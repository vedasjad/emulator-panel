import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

export const expandHome = (value: string) => value.replace(/^~(?=$|[\\/])/, os.homedir());

const hasEmulator = (root: string) => fs.existsSync(path.join(root, 'emulator', exe('emulator')));

export function sdkRoot(): string {
  const configured = vscode.workspace.getConfiguration('emulatorPanel').get<string>('sdkPath')?.trim();
  if (configured) {
    const root = expandHome(configured);
    if (!hasEmulator(root)) {
      throw new Error(`"emulatorPanel.sdkPath" is set to ${configured}, but it has no emulator/${exe('emulator')}. Install the Android Emulator package or fix the path.`);
    }
    return root;
  }
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  ];
  const root = candidates.find((candidate): candidate is string => !!candidate && hasEmulator(candidate));
  if (!root) {
    throw new Error('The Android SDK with the Emulator package was not found. Install it from Android Studio, or set "emulatorPanel.sdkPath".');
  }
  return root;
}

export const emulatorPath = () => path.join(sdkRoot(), 'emulator', exe('emulator'));
export const adbPath = () => path.join(sdkRoot(), 'platform-tools', exe('adb'));
export const protoDir = () => path.join(sdkRoot(), 'emulator', 'lib');
