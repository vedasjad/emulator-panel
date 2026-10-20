import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './log';
import { adb } from './physicalDevices';

export interface AdbTarget {
  name: string;
  serial: string;
}

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const DOWNLOADS = '/sdcard/Download/';

export async function sendFiles(target: AdbTarget, files: vscode.Uri[]): Promise<void> {
  const local = files.filter((file) => file.scheme === 'file');
  if (!local.length) {
    return;
  }
  const done: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: target.name, cancellable: false },
    async (progress) => {
      for (const file of local) {
        const name = path.basename(file.fsPath);
        const apk = name.toLowerCase().endsWith('.apk');
        progress.report({ message: apk ? `Installing ${name}…` : `Copying ${name} to Downloads…` });
        const args = apk ? ['install', '-r', file.fsPath] : ['push', file.fsPath, DOWNLOADS];
        try {
          await adb(['-s', target.serial, ...args], INSTALL_TIMEOUT_MS);
          done.push(apk ? `Installed ${name}` : `Copied ${name} to Downloads`);
        } catch (error) {
          log.appendLine(`[${target.name}] adb ${args.join(' ')} failed: ${(error as Error).message}`);
          throw new Error(`${apk ? 'Installing' : 'Copying'} ${name} on ${target.name} failed: ${(error as Error).message}`);
        }
      }
    },
  );
  void vscode.window.showInformationMessage(`${done.join(', ')} on ${target.name}.`);
}

export async function sendFileContents(target: AdbTarget, files: { name: string; data: Uint8Array }[]): Promise<void> {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'emulator-panel-drop-'));
  try {
    const uris: vscode.Uri[] = [];
    for (const file of files) {
      const destination = path.join(folder, path.basename(file.name));
      await fs.promises.writeFile(destination, file.data);
      uris.push(vscode.Uri.file(destination));
    }
    await sendFiles(target, uris);
  } finally {
    await fs.promises.rm(folder, { recursive: true, force: true });
  }
}
