import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { abiLabel, androidVersion, apiLabel } from './avds';
import { DevicePanel } from './devicePanel';
import { Device, DeviceStore } from './deviceStore';

export type DeviceAction =
  | 'run'
  | 'stop'
  | 'reveal'
  | 'screenshot'
  | 'delete'
  | 'coldBoot'
  | 'wipeData'
  | 'open'
  | 'location'
  | 'extendedControls'
  | 'copySerial'
  | 'editConfig'
  | 'showWindow'
  | 'erase'
  | 'setLocation'
  | 'playRoute'
  | 'clearLocation'
  | 'toggleAppearance'
  | 'openUrl'
  | 'copyUdid'
  | 'reboot'
  | 'hideScreen';

type ViewMessage = { type: 'ready' } | { type: 'openSdkSetting' } | { type: 'action'; action: DeviceAction; id: string };

function describe(device: Device, mirrored: Set<string>) {
  const common = { id: device.id, platform: device.platform, status: device.status, physical: false, mirrored: false };
  if (device.androidPhone) {
    const phone = device.androidPhone;
    const stateNote =
      phone.state === 'unauthorized'
        ? 'Unauthorized: allow USB debugging on the phone'
        : phone.state !== 'device'
          ? `State: ${phone.state}`
          : undefined;
    return {
      ...common,
      physical: true,
      mirrored: mirrored.has(phone.serial),
      displayName: phone.name,
      subtitle: [androidVersion(phone.sdk) ?? phone.state, abiLabel(phone.abi)].filter(Boolean),
      api: apiLabel(phone.sdk) ?? '',
      type: 'Physical',
      external: false,
      controllable: false,
      hasUi: false,
      details: [stateNote, phone.model && `Model: ${phone.model}`, `Serial: ${phone.serial}`, `Connection: ${phone.connection}`].filter(Boolean),
    };
  }
  if (device.iosPhone) {
    const phone = device.iosPhone;
    return {
      ...common,
      physical: true,
      displayName: phone.name,
      subtitle: [phone.osVersion && `iOS ${phone.osVersion}`, phone.model].filter(Boolean),
      api: phone.osVersion ?? '',
      type: 'Physical',
      external: false,
      controllable: false,
      hasUi: false,
      details: [phone.connected ? `Connected over ${phone.connection ?? 'USB'}` : 'Not connected', `UDID: ${phone.udid}`],
    };
  }
  if (device.simulator) {
    const simulator = device.simulator;
    return {
      ...common,
      displayName: simulator.name,
      subtitle: [simulator.runtime, simulator.family].filter(Boolean),
      api: simulator.runtimeVersion,
      type: 'Simulator',
      external: false,
      controllable: false,
      hasUi: false,
      details: [`UDID: ${simulator.udid}`],
    };
  }
  const avd = device.avd!;
  return {
    ...common,
    displayName: avd.displayName,
    subtitle: [avd.androidVersion, avd.abi].filter(Boolean),
    api: avd.apiLabel ?? '',
    type: 'Virtual',
    external: device.external,
    controllable: !!device.emulator,
    hasUi: !!device.emulator?.hasUi,
    details: [
      avd.device && `Device: ${avd.device}`,
      avd.image && `Image: ${avd.image}`,
      avd.resolution && `Screen: ${avd.resolution}`,
      device.serial && `Serial: ${device.serial}`,
    ].filter(Boolean),
  };
}

export class DevicesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'emulatorPanel.devices';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: DeviceStore,
    private readonly onAction: (action: DeviceAction, device: Device) => void,
  ) {
    store.onDidChange((devices) => this.post(devices));
    DevicePanel.onDidChangeSessions(() => this.post(this.store.current));
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: ViewMessage) => {
      if (message.type === 'ready') {
        this.post(this.store.current);
        void this.store.refresh();
      } else if (message.type === 'openSdkSetting') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'emulatorPanel.sdkPath');
      } else if (message.type === 'action') {
        const device = this.store.find(message.id);
        if (device) {
          this.onAction(message.action, device);
        }
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.store.refresh();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private post(devices: Device[]): void {
    if (!this.view) {
      return;
    }
    const mirrored = DevicePanel.mirroredSerials();
    void this.view.webview.postMessage({
      type: 'devices',
      devices: devices.map((device) => describe(device, mirrored)),
      sdkProblem: this.store.sdkProblem,
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('manager.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${media('manager.js')}"></script>
</body>
</html>`;
  }
}
