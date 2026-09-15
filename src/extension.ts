import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { avdHome, readAvds } from './avds';
import { DevicePanel } from './devicePanel';
import { Device, DeviceStore } from './deviceStore';
import { DeviceAction, DevicesViewProvider } from './devicesView';
import { RunningEmulator, listRunning } from './discovery';
import { EmulatorClient, Pane } from './emulatorClient';
import { launchAvd } from './launcher';
import { log } from './log';
import { adbPath, protoDir } from './sdk';

const PANE_COMMANDS: Record<string, Pane> = {
  'emulatorPanel.extendedControls': 'KEEP_CURRENT',
  'emulatorPanel.location': 'LOCATION',
  'emulatorPanel.cellular': 'CELLULAR',
  'emulatorPanel.battery': 'BATTERY',
  'emulatorPanel.phone': 'TELEPHONE',
  'emulatorPanel.virtualSensors': 'VIRT_SENSORS',
  'emulatorPanel.fingerprint': 'FINGER',
  'emulatorPanel.camera': 'CAMERA',
  'emulatorPanel.microphone': 'MICROPHONE',
  'emulatorPanel.screenRecord': 'RECORD',
  'emulatorPanel.snapshots': 'SNAPSHOT',
  'emulatorPanel.settings': 'SETTINGS',
};

const KEY_COMMANDS: Record<string, string> = {
  'emulatorPanel.back': 'GoBack',
  'emulatorPanel.home': 'GoHome',
  'emulatorPanel.overview': 'AppSwitch',
  'emulatorPanel.power': 'Power',
  'emulatorPanel.volumeUp': 'AudioVolumeUp',
  'emulatorPanel.volumeDown': 'AudioVolumeDown',
};

function showError(error: unknown): void {
  if (!(error instanceof vscode.CancellationError)) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(log);
  let devicesView: DevicesViewProvider | undefined;
  const store = new DeviceStore(() => !!devicesView?.visible || !!DevicePanel.current);
  context.subscriptions.push(store);
  store.onDidChange(() => DevicePanel.current?.prune(new Set(listRunning().map((emulator) => emulator.pid))));

  const register = (id: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          showError(error);
        }
      }),
    );

  const activePanel = (): DevicePanel => {
    const panel = DevicePanel.current;
    if (!panel) {
      throw new Error('No device is open. Run "Emulator: Open Device" first.');
    }
    return panel;
  };

  const launch = async (avdName: string, launchArgs: string[] = []): Promise<void> => {
    store.markStarting(avdName);
    let emulator: RunningEmulator;
    try {
      emulator = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${avdName}…`, cancellable: true },
        (_progress, cancellation) => launchAvd(avdName, log, cancellation, launchArgs),
      );
    } catch (error) {
      store.clearTransition(avdName);
      throw error;
    }
    void store.refresh();
    DevicePanel.show(context.extensionUri, emulator, protoDir());
  };

  const stop = async (avdName: string, serial: string | undefined): Promise<void> => {
    if (!serial) {
      return;
    }
    store.markStopping(avdName);
    try {
      await stopSerial(serial);
    } catch (error) {
      store.clearTransition(avdName);
      throw error;
    }
  };

  DevicePanel.stopEmulator = (emulator) => stop(emulator.avdName, `emulator-${emulator.consolePort}`);

  const handleDeviceAction = async (action: DeviceAction, device: Device): Promise<void> => {
    const { avd, emulator, serial, status } = device;
    const controllable = (): RunningEmulator => {
      if (!emulator) {
        throw new Error(`${avd.displayName} was not started by Emulator Panel. Stop it and run it from the Device Manager.`);
      }
      return emulator;
    };
    const withUi = (): RunningEmulator => {
      const running = controllable();
      if (!running.hasUi) {
        throw new Error(`${avd.displayName} was started without the emulator UI, so extended controls are unavailable.`);
      }
      return running;
    };

    switch (action) {
      case 'run':
        if (status === 'stopped') {
          await launch(avd.name);
        } else if (emulator) {
          DevicePanel.show(context.extensionUri, emulator, protoDir());
        }
        return;
      case 'coldBoot':
        await launch(avd.name, ['-no-snapshot-load']);
        return;
      case 'wipeData': {
        const choice = await vscode.window.showWarningMessage(
          `Wipe all data on ${avd.displayName}?`,
          { modal: true, detail: 'Apps, accounts, files and saved state on this emulator are erased, then it starts fresh.' },
          'Wipe and Run',
        );
        if (choice) {
          await launch(avd.name, ['-wipe-data']);
        }
        return;
      }
      case 'open':
        DevicePanel.show(context.extensionUri, controllable(), protoDir());
        return;
      case 'stop':
        await stop(avd.name, serial);
        return;
      case 'location':
        await withClient(withUi(), (client) => client.showExtendedControls('LOCATION'));
        return;
      case 'extendedControls':
        await withClient(withUi(), (client) => client.showExtendedControls('KEEP_CURRENT'));
        return;
      case 'screenshot':
        await saveScreenshot(await withClient(controllable(), (client) => client.screenshot()));
        return;
      case 'copySerial':
        if (serial) {
          await vscode.env.clipboard.writeText(serial);
          vscode.window.showInformationMessage(`Copied ${serial} to the clipboard.`);
        }
        return;
      case 'reveal':
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(avd.dir));
        return;
      case 'editConfig':
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(avd.dir, 'config.ini')));
        return;
      case 'delete': {
        if (status !== 'stopped') {
          throw new Error(`Stop ${avd.displayName} before deleting it.`);
        }
        const choice = await vscode.window.showWarningMessage(
          `Delete ${avd.displayName}?`,
          { modal: true, detail: 'The emulator, its data and its snapshots are moved to the Trash.' },
          'Move to Trash',
        );
        if (!choice) {
          return;
        }
        await vscode.workspace.fs.delete(vscode.Uri.file(avd.dir), { recursive: true, useTrash: true });
        await vscode.workspace.fs.delete(vscode.Uri.file(avd.iniPath), { useTrash: true });
        void store.refresh();
        return;
      }
    }
  };

  devicesView = new DevicesViewProvider(context.extensionUri, store, (action, device) => {
    handleDeviceAction(action, device).catch(showError);
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(DevicesViewProvider.viewType, devicesView));

  register('emulatorPanel.open', (avdName) => openDevice(context, launch, typeof avdName === 'string' ? avdName : undefined));
  register('emulatorPanel.stop', async () => {
    const emulator = activePanel().focusedEmulator;
    if (!emulator) {
      throw new Error('No device is open in Running Devices.');
    }
    await stop(emulator.avdName, `emulator-${emulator.consolePort}`);
  });
  register('emulatorPanel.rotateLeft', () => activePanel().rotate(1));
  register('emulatorPanel.rotateRight', () => activePanel().rotate(-1));
  register('emulatorPanel.screenshot', async () => saveScreenshot(await activePanel().screenshot()));
  register('emulatorPanel.fitColumn', () => activePanel().requestFit());
  for (const [id, pane] of Object.entries(PANE_COMMANDS)) {
    register(id, () => activePanel().showPane(pane));
  }
  for (const [id, key] of Object.entries(KEY_COMMANDS)) {
    register(id, () => activePanel().key(key));
  }

  const showRunningDevices = async (): Promise<void> => {
    if (DevicePanel.reveal()) {
      return;
    }
    if (!DevicePanel.restore(context.extensionUri, listRunning(), protoDir())) {
      await vscode.commands.executeCommand('emulatorPanel.open');
    }
  };
  register('emulatorPanel.showRunningDevices', showRunningDevices);
  register('emulatorPanel.hideRunningDevices', () => DevicePanel.hide());
  register('emulatorPanel.toggleRunningDevices', () => (DevicePanel.isVisible ? DevicePanel.hide() : showRunningDevices()));
  register('emulatorPanel.moveToNewWindow', async () => {
    if (!DevicePanel.current) {
      await showRunningDevices();
    }
    await DevicePanel.moveToNewWindow();
  });
  register('emulatorPanel.moveToMainWindow', () => DevicePanel.moveToMainWindow(context.extensionUri, listRunning(), protoDir()));
  register('emulatorPanel.toggleAlwaysOnTop', () => DevicePanel.current?.toggleAlwaysOnTop());

  register('emulatorPanel.refreshDevices', () => store.refresh());
  register('emulatorPanel.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.emulator-panel'));
  register('emulatorPanel.showLog', () => log.show());
  register('emulatorPanel.openAvdFolder', () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(avdHome())));
  register('emulatorPanel.stopAll', async () => {
    const running = store.current.filter((device) => device.serial && device.status === 'running');
    if (running.length === 0) {
      vscode.window.showInformationMessage('No emulators are running.');
      return;
    }
    await Promise.all(running.map((device) => stop(device.avd.name, device.serial)));
  });
}

export function deactivate(): void {}

async function openDevice(
  context: vscode.ExtensionContext,
  launch: (avdName: string) => Promise<void>,
  avdName?: string,
): Promise<void> {
  type Item = vscode.QuickPickItem & { emulator?: RunningEmulator; avd?: string };
  const running = listRunning();
  const items: Item[] = [
    ...running.map((emulator) => ({
      label: `$(device-mobile) ${emulator.avdName}`,
      description: emulator.hasUi ? 'running' : 'running without emulator UI (no extended controls)',
      emulator,
    })),
    ...readAvds()
      .filter((avd) => !running.some((emulator) => emulator.avdName === avd.name))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((avd) => ({ label: `$(play) ${avd.name}`, description: 'start', avd: avd.name })),
  ];
  if (items.length === 0) {
    throw new Error("No AVDs found. Create one in Android Studio's Device Manager.");
  }
  const picked = avdName
    ? items.find((item) => (item.emulator?.avdName ?? item.avd) === avdName)
    : await vscode.window.showQuickPick(items, { placeHolder: 'Add a running emulator or start an AVD' });
  if (!picked) {
    if (avdName) {
      throw new Error(`No AVD named "${avdName}" was found.`);
    }
    return;
  }
  if (picked.emulator) {
    DevicePanel.show(context.extensionUri, picked.emulator, protoDir());
  } else if (picked.avd) {
    await launch(picked.avd);
  }
}

function stopSerial(serial: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(adbPath(), ['-s', serial, 'emu', 'kill'], (error) => (error ? reject(error) : resolve()));
  });
}

async function withClient<T>(emulator: RunningEmulator, action: (client: EmulatorClient) => Promise<T>): Promise<T> {
  const client = new EmulatorClient(emulator, protoDir());
  try {
    return await action(client);
  } finally {
    client.close();
  }
}

async function saveScreenshot(png: Buffer): Promise<void> {
  const configured = vscode.workspace.getConfiguration('emulatorPanel').get<string>('screenshotFolder');
  const folder = configured ? configured.replace(/^~(?=$|[\\/])/, os.homedir()) : path.join(os.homedir(), 'Desktop');
  const file = path.join(folder, `Screenshot_${Math.floor(Date.now() / 1000)}.png`);
  await fs.promises.mkdir(folder, { recursive: true });
  await fs.promises.writeFile(file, png);

  let copied = false;
  if (process.platform === 'darwin') {
    const scriptPath = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    copied = await new Promise<boolean>((resolve) =>
      execFile('osascript', ['-e', `set the clipboard to (read (POSIX file "${scriptPath}") as «class PNGf»)`], (error) =>
        resolve(!error),
      ),
    );
  }
  vscode.window
    .showInformationMessage(`Screenshot saved to ${file}${copied ? ' and copied to the clipboard' : ''}.`, 'Reveal')
    .then((choice) => {
      if (choice === 'Reveal') {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
      }
    });
}
