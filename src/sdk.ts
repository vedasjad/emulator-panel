import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

export function sdkRoot(): string {
  const configured = vscode.workspace.getConfiguration('emulatorPanel').get<string>('sdkPath');
  const candidates = [
    configured,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  ];
  const root = candidates.find((c): c is string => !!c && fs.existsSync(path.join(c, 'emulator', exe('emulator'))));
  if (!root) {
    throw new Error('Android SDK with the emulator package was not found. Set "emulatorPanel.sdkPath".');
  }
  return root;
}

export const emulatorPath = () => path.join(sdkRoot(), 'emulator', exe('emulator'));
export const adbPath = () => path.join(sdkRoot(), 'platform-tools', exe('adb'));
export const protoDir = () => path.join(sdkRoot(), 'emulator', 'lib');
