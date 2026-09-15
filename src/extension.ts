import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AvdInfo, avdHome, readAvds } from './avds';
import { DevicePanel, PanelEnvironment, SavedPanelState } from './devicePanel';
import { Device, DeviceStore } from './deviceStore';
import { DeviceAction, DevicesViewProvider } from './devicesView';
import { RunningEmulator, listRunning } from './discovery';
import { EmulatorClient, Pane } from './emulatorClient';
import { launchAvd } from './launcher';
import { pickAndPlayRoute, pickLocation } from './locationPicker';
import { log } from './log';
import {
  AndroidPhone,
  IosPhone,
  androidNightMode,
  androidOpenUrl,
  androidScreenshot,
  listAdbEntries,
  listAndroidPhones,
  rebootAndroid,
  setAndroidNightMode,
} from './physicalDevices';
import { SCRCPY_SERVER_FILE, ScrcpyConnection, ScrcpyRecord } from './scrcpy';
import { adbPath, protoDir } from './sdk';
import {
  SimulatorInfo,
  bootSimulator,
  clearLocation,
  deleteSimulator,
  eraseSimulator,
  getAppearance,
  openUrl,
  screenshotSimulator,
  setAppearance,
  setLocation,
  showSimulatorWindow,
  shutdownSimulator,
} from './simulators';

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

const LAST_URL = 'emulatorPanel.lastSimulatorUrl';
const PANEL_STATE = 'emulatorPanel.runningDevicesState';
const SCRCPY_SESSIONS = 'emulatorPanel.scrcpySessions';

let shuttingDown = false;

function showError(error: unknown): void {
  if (!(error instanceof vscode.CancellationError)) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(log);
  void ScrcpyConnection.cleanup(context.workspaceState.get<ScrcpyRecord[]>(SCRCPY_SESSIONS, []));
  ScrcpyConnection.onRecordsChanged = (records) => void context.workspaceState.update(SCRCPY_SESSIONS, records);
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

  const environment = (): PanelEnvironment => ({
    extensionUri: context.extensionUri,
    protoDir: protoDir(),
    serverPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'vendor', SCRCPY_SERVER_FILE).fsPath,
  });

  const connectedPhones = (): AndroidPhone[] =>
    store.current.flatMap((device) => (device.androidPhone?.state === 'device' ? [device.androidPhone] : []));

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(DevicePanel.viewType, {
      deserializeWebviewPanel: async (panel) => {
        try {
          const phones = await listAndroidPhones(await listAdbEntries().catch(() => [])).catch(() => [] as AndroidPhone[]);
          DevicePanel.revive(
            panel,
            environment(),
            context.workspaceState.get<SavedPanelState>(PANEL_STATE),
            listRunning(),
            phones.filter((phone) => phone.state === 'device'),
          );
        } catch (error) {
          panel.dispose();
          showError(error);
        }
      },
    }),
    DevicePanel.onDidChangeSessions(() => {
      if (!shuttingDown) {
        void context.workspaceState.update(PANEL_STATE, DevicePanel.savedState());
      }
    }),
  );

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
    DevicePanel.show(environment(), emulator);
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

  const askUrl = async (deviceName: string): Promise<string | undefined> => {
    const url = await vscode.window.showInputBox({
      title: `Open URL on ${deviceName}`,
      prompt: 'A web address or deep link',
      placeHolder: 'https://example.com or myapp://screen',
      value: context.globalState.get<string>(LAST_URL),
      ignoreFocusOut: true,
    });
    if (url) {
      await context.globalState.update(LAST_URL, url);
    }
    return url;
  };

  const handleAndroidPhoneAction = async (action: DeviceAction, phone: AndroidPhone): Promise<void> => {
    const requireConnected = () => {
      if (phone.state !== 'device') {
        throw new Error(
          phone.state === 'unauthorized' ? `Allow USB debugging on ${phone.name} first.` : `${phone.name} is ${phone.state}.`,
        );
      }
    };
    switch (action) {
      case 'open':
        requireConnected();
        DevicePanel.showPhone(environment(), phone);
        return;
      case 'hideScreen':
        DevicePanel.closePhone(phone.serial);
        return;
      case 'screenshot':
        requireConnected();
        await saveScreenshot(await androidScreenshot(phone.serial));
        return;
      case 'openUrl': {
        requireConnected();
        const url = await askUrl(phone.name);
        if (url) {
          await androidOpenUrl(phone.serial, url);
        }
        return;
      }
      case 'toggleAppearance':
        requireConnected();
        await setAndroidNightMode(phone.serial, !(await androidNightMode(phone.serial)));
        return;
      case 'copySerial':
        await vscode.env.clipboard.writeText(phone.serial);
        vscode.window.showInformationMessage(`Copied ${phone.serial} to the clipboard.`);
        return;
      case 'reboot': {
        requireConnected();
        const choice = await vscode.window.showWarningMessage(`Reboot ${phone.name}?`, { modal: true }, 'Reboot');
        if (choice) {
          await rebootAndroid(phone.serial);
          void store.refresh();
        }
        return;
      }
    }
  };

  const handleIosPhoneAction = async (action: DeviceAction, phone: IosPhone): Promise<void> => {
    if (action === 'copyUdid') {
      await vscode.env.clipboard.writeText(phone.udid);
      vscode.window.showInformationMessage(`Copied the UDID of ${phone.name} to the clipboard.`);
    }
  };

  const handleAndroidAction = async (action: DeviceAction, device: Device, avd: AvdInfo): Promise<void> => {
    const { emulator, serial, status } = device;
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
          DevicePanel.show(environment(), emulator);
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
        DevicePanel.show(environment(), controllable());
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

  const handleSimulatorAction = async (action: DeviceAction, device: Device, simulator: SimulatorInfo): Promise<void> => {
    const { udid, name } = simulator;
    const requireRunning = () => {
      if (device.status !== 'running') {
        throw new Error(`${name} is not running. Run it first.`);
      }
    };
    const requireStopped = (verb: string) => {
      if (device.status !== 'stopped') {
        throw new Error(`Stop ${name} before ${verb} it.`);
      }
    };

    switch (action) {
      case 'run':
        if (device.status !== 'stopped') {
          await showSimulatorWindow(udid);
          return;
        }
        store.markStarting(device.id);
        try {
          await bootSimulator(udid);
        } catch (error) {
          store.clearTransition(device.id);
          throw error;
        }
        return;
      case 'showWindow':
        await showSimulatorWindow(udid);
        return;
      case 'stop':
        store.markStopping(device.id);
        try {
          await shutdownSimulator(udid);
        } catch (error) {
          store.clearTransition(device.id);
          throw error;
        }
        return;
      case 'erase': {
        requireStopped('erasing');
        const choice = await vscode.window.showWarningMessage(
          `Erase ${name}?`,
          { modal: true, detail: 'All apps, data and settings on this simulator are erased.' },
          'Erase',
        );
        if (choice) {
          await eraseSimulator(udid);
          vscode.window.showInformationMessage(`${name} was erased.`);
        }
        return;
      }
      case 'delete': {
        requireStopped('deleting');
        const choice = await vscode.window.showWarningMessage(
          `Delete ${name}?`,
          { modal: true, detail: 'The simulator and all of its data are permanently deleted.' },
          'Delete',
        );
        if (choice) {
          await deleteSimulator(udid);
          void store.refresh();
        }
        return;
      }
      case 'reveal':
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.dirname(simulator.dataPath)));
        return;
      case 'setLocation': {
        requireRunning();
        const point = await pickLocation(context.globalState, name);
        if (point) {
          await setLocation(udid, point);
          vscode.window.showInformationMessage(`${name} location set to ${point.name ?? `${point.lat}, ${point.lon}`}.`);
        }
        return;
      }
      case 'playRoute':
        requireRunning();
        await pickAndPlayRoute(context.globalState, udid, name);
        return;
      case 'clearLocation':
        requireRunning();
        await clearLocation(udid);
        vscode.window.showInformationMessage(`Location simulation stopped on ${name}.`);
        return;
      case 'toggleAppearance': {
        requireRunning();
        const next = (await getAppearance(udid)) === 'dark' ? 'light' : 'dark';
        await setAppearance(udid, next);
        return;
      }
      case 'openUrl': {
        requireRunning();
        const url = await askUrl(name);
        if (url) {
          await openUrl(udid, url);
        }
        return;
      }
      case 'screenshot':
        requireRunning();
        await saveScreenshot(await screenshotSimulator(udid));
        return;
      case 'copyUdid':
        await vscode.env.clipboard.writeText(udid);
        vscode.window.showInformationMessage(`Copied the UDID of ${name} to the clipboard.`);
        return;
    }
  };

  const handleDeviceAction = async (action: DeviceAction, device: Device): Promise<void> => {
    if (device.androidPhone) {
      await handleAndroidPhoneAction(action, device.androidPhone);
    } else if (device.iosPhone) {
      await handleIosPhoneAction(action, device.iosPhone);
    } else if (device.simulator) {
      await handleSimulatorAction(action, device, device.simulator);
    } else if (device.avd) {
      await handleAndroidAction(action, device, device.avd);
    }
  };

  devicesView = new DevicesViewProvider(context.extensionUri, store, (action, device) => {
    handleDeviceAction(action, device).catch(showError);
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(DevicesViewProvider.viewType, devicesView));

  register('emulatorPanel.open', (name) => openDevice(environment, launch, connectedPhones(), typeof name === 'string' ? name : undefined));
  register('emulatorPanel.stop', async () => {
    const panel = activePanel();
    const emulator = panel.focusedEmulator;
    if (emulator) {
      await stop(emulator.avdName, `emulator-${emulator.consolePort}`);
    } else {
      panel.closeFocused();
    }
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
    if (!DevicePanel.restore(environment(), listRunning(), connectedPhones())) {
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
  register('emulatorPanel.moveToMainWindow', () => DevicePanel.moveToMainWindow(environment(), listRunning(), connectedPhones()));
  register('emulatorPanel.toggleAlwaysOnTop', () => DevicePanel.current?.toggleAlwaysOnTop());

  register('emulatorPanel.refreshDevices', () => store.refresh());
  register('emulatorPanel.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.emulator-panel'));
  register('emulatorPanel.showLog', () => log.show());
  register('emulatorPanel.openAvdFolder', () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(avdHome())));
  register('emulatorPanel.stopAll', async () => {
    const running = store.current.filter((device) => device.status === 'running' && !device.androidPhone && !device.iosPhone);
    if (running.length === 0) {
      vscode.window.showInformationMessage('No emulators or simulators are running.');
      return;
    }
    await Promise.all(running.map((device) => handleDeviceAction('stop', device)));
  });
}

export function deactivate(): void {
  shuttingDown = true;
  ScrcpyConnection.closeAllSync();
}

async function openDevice(
  environment: () => PanelEnvironment,
  launch: (avdName: string) => Promise<void>,
  phones: AndroidPhone[],
  name?: string,
): Promise<void> {
  type Item = vscode.QuickPickItem & { emulator?: RunningEmulator; avd?: string; phone?: AndroidPhone };
  const running = listRunning();
  const items: Item[] = [
    ...running.map((emulator) => ({
      label: `$(device-mobile) ${emulator.avdName}`,
      description: emulator.hasUi ? 'running' : 'running without emulator UI (no extended controls)',
      emulator,
    })),
    ...phones.map((phone) => ({
      label: `$(device-mobile) ${phone.name}`,
      description: `physical device · ${phone.connection}`,
      phone,
    })),
    ...readAvds()
      .filter((avd) => !running.some((emulator) => emulator.avdName === avd.name))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((avd) => ({ label: `$(play) ${avd.name}`, description: 'start', avd: avd.name })),
  ];
  if (items.length === 0) {
    throw new Error("No devices found. Create an AVD in Android Studio's Device Manager or connect a phone.");
  }
  const picked = name
    ? items.find(
        (item) => item.emulator?.avdName === name || item.avd === name || item.phone?.serial === name || item.phone?.name === name,
      )
    : await vscode.window.showQuickPick(items, { placeHolder: 'Add a running device or start an AVD' });
  if (!picked) {
    if (name) {
      throw new Error(`No device named "${name}" was found.`);
    }
    return;
  }
  if (picked.emulator) {
    DevicePanel.show(environment(), picked.emulator);
  } else if (picked.phone) {
    DevicePanel.showPhone(environment(), picked.phone);
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
