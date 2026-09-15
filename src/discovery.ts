import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RunningEmulator {
  pid: number;
  avdName: string;
  grpcPort: number;
  token?: string;
  consolePort: number;
  hasUi: boolean;
}

export function discoveryDir(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Caches', 'TemporaryItems', 'avd', 'running');
    case 'win32':
      return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'Temp', 'avd', 'running');
    default:
      return path.join(process.env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `android-${os.userInfo().username}`), 'avd', 'running');
  }
}

export function parseIni(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) {
      entries[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  return entries;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listRunning(): RunningEmulator[] {
  const dir = discoveryDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((file) => /^pid_\d+\.ini$/.test(file));
  } catch {
    return [];
  }
  const emulators: RunningEmulator[] = [];
  for (const file of files) {
    const pid = Number(file.slice(4, -4));
    if (!isAlive(pid)) {
      continue;
    }
    let ini: Record<string, string>;
    try {
      ini = parseIni(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    const grpcPort = Number(ini['grpc.port']);
    if (!grpcPort) {
      continue;
    }
    const cmdline = ini['cmdline'] ?? '';
    emulators.push({
      pid,
      avdName: ini['avd.name'] ?? ini['avd.id'] ?? `emulator-${ini['port.serial']}`,
      grpcPort,
      token: ini['grpc.token'] || undefined,
      consolePort: Number(ini['port.serial']),
      hasUi: !cmdline.includes('-headless') && !cmdline.includes('-no-window'),
    });
  }
  return emulators;
}

export async function waitForRunning(
  match: (emulator: RunningEmulator) => boolean,
  timeoutMs: number,
  checkAbort: () => void,
): Promise<RunningEmulator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkAbort();
    const found = listRunning().find(match);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for the emulator to start.');
}
