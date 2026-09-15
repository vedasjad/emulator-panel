import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RunningEmulator, listRunning, waitForRunning } from './discovery';
import { emulatorPath } from './sdk';

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

function stopProcessGroup(child: ChildProcess): void {
  try {
    if (process.platform === 'win32' || child.pid === undefined) {
      child.kill();
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    child.kill();
  }
}

async function freeGrpcPort(): Promise<number> {
  const taken = new Set(listRunning().map((emulator) => emulator.grpcPort));
  for (let port = 8554; port < 8700; port += 2) {
    if (!taken.has(port) && (await portIsFree(port))) {
      return port;
    }
  }
  throw new Error('No free gRPC port was found for the emulator.');
}

export async function launchAvd(
  avdName: string,
  output: vscode.OutputChannel,
  cancellation: vscode.CancellationToken,
  launchArgs: string[] = [],
): Promise<RunningEmulator> {
  const grpcPort = await freeGrpcPort();
  const extraArgs = vscode.workspace.getConfiguration('emulatorPanel').get<string[]>('emulatorArgs') ?? [];
  const crashMode = extraArgs.some((arg) => arg.replace(/_/g, '-') === '-crash-report-mode') ? [] : ['-crash-report-mode', 'never'];
  const args = ['-avd', avdName, '-qt-hide-window', '-grpc', String(grpcPort), '-grpc-use-token', ...crashMode, ...launchArgs, ...extraArgs];
  const logFile = path.join(os.tmpdir(), 'emulator-panel', `${avdName}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  output.appendLine(`$ ${emulatorPath()} ${args.join(' ')}`);
  output.appendLine(`Emulator log: ${logFile}`);

  const log = fs.openSync(logFile, 'w');
  const child = spawn(emulatorPath(), args, { detached: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let failure: string | undefined;
  child.on('error', (error) => {
    failure = error.message;
  });
  child.on('exit', (code) => {
    const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
    output.appendLine(lines.slice(-20).join('\n'));
    failure ??= `The emulator exited with code ${code}. See the "Emulator Panel" output for details.`;
  });
  child.unref();

  try {
    return await waitForRunning(
      (emulator) => emulator.avdName === avdName && emulator.grpcPort === grpcPort,
      180_000,
      () => {
        if (cancellation.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        if (failure) {
          output.show(true);
          throw new Error(failure);
        }
      },
    );
  } catch (error) {
    stopProcessGroup(child);
    throw error;
  }
}
