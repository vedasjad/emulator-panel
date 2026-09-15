import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Device, DeviceStore } from './deviceStore';

export type DeviceAction =
  | 'run'
  | 'coldBoot'
  | 'wipeData'
  | 'open'
  | 'stop'
  | 'location'
  | 'extendedControls'
  | 'screenshot'
  | 'copySerial'
  | 'reveal'
  | 'editConfig'
  | 'delete';

type ViewMessage = { type: 'ready' } | { type: 'action'; action: DeviceAction; avd: string };

export class DevicesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'emulatorPanel.devices';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: DeviceStore,
    private readonly onAction: (action: DeviceAction, device: Device) => void,
  ) {
    store.onDidChange((devices) => this.post(devices));
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
      } else if (message.type === 'action') {
        const device = this.store.find(message.avd);
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
    void this.view?.webview.postMessage({
      type: 'devices',
      devices: devices.map(({ avd, status, emulator, serial, external }) => ({
        name: avd.name,
        displayName: avd.displayName,
        api: avd.apiLabel ?? '',
        androidVersion: avd.androidVersion ?? '',
        abi: avd.abi ?? '',
        device: avd.device ?? '',
        image: avd.image ?? '',
        resolution: avd.resolution ?? '',
        serial: serial ?? '',
        status,
        external,
        controllable: !!emulator,
        hasUi: !!emulator?.hasUi,
      })),
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
