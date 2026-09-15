import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { RunningEmulator } from './discovery';
import { EmulatorClient, Frame, KeyEventType, Pane, Rotation } from './emulatorClient';
import { log } from './log';
import { AndroidPhone, androidScreenshot } from './physicalDevices';
import { ScrcpyConnection } from './scrcpy';

const ROTATION_QUADRANT: Record<Rotation, number> = {
  PORTRAIT: 0,
  LANDSCAPE: 1,
  REVERSE_PORTRAIT: 2,
  REVERSE_LANDSCAPE: 3,
};

const ANDROID_KEYCODES: Record<string, number> = {
  GoBack: 4,
  GoHome: 3,
  AppSwitch: 187,
  Power: 26,
  AudioVolumeUp: 24,
  AudioVolumeDown: 25,
};

const TYPED_KEYCODES: Record<string, number> = {
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  Escape: 111,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

const PHONE_MAX_SIZE = 1920;
const MIN_NEIGHBOR_WIDTH = 220;

const mac = process.platform === 'darwin';

const shortcut = (keys: string) =>
  mac
    ? keys.replace('mod+', '⌘').replace('shift+', '⇧').replace('backspace', '⌫').replace('left', '←').replace('right', '→').toUpperCase()
    : keys.replace('mod+', 'Ctrl+').replace('shift+', 'Shift+').replace(/(^|\+)([a-z])/g, (_m, sep: string, key: string) => sep + key.toUpperCase());

const icon = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

interface Tool {
  command: string;
  title: string;
  keys?: string;
  svg: string;
  needsUi?: boolean;
  collapse?: number;
}

const TOOL_GROUPS: Tool[][] = [
  [
    { command: 'emulatorPanel.back', title: 'Back', keys: 'mod+backspace', svg: icon('<path d="M16 5v14L6 12z"/>') },
    { command: 'emulatorPanel.home', title: 'Home', keys: 'mod+shift+h', svg: icon('<circle cx="12" cy="12" r="7"/>') },
    { command: 'emulatorPanel.overview', title: 'Overview', keys: 'mod+o', svg: icon('<rect x="6" y="6" width="12" height="12" rx="1.5"/>') },
  ],
  [
    { command: 'emulatorPanel.volumeDown', title: 'Volume down', keys: 'mod+-', collapse: 2, svg: icon('<path d="M4 9h3l5-4v14l-5-4H4z"/><path d="M16 12h5"/>') },
    { command: 'emulatorPanel.volumeUp', title: 'Volume up', keys: 'mod+=', collapse: 2, svg: icon('<path d="M4 9h3l5-4v14l-5-4H4z"/><path d="M16 12h5M18.5 9.5v5"/>') },
    { command: 'emulatorPanel.power', title: 'Power', keys: 'mod+p', svg: icon('<path d="M12 3v8"/><path d="M7.05 6.05a7 7 0 1 0 9.9 0"/>') },
  ],
  [
    { command: 'emulatorPanel.rotateLeft', title: 'Rotate left', keys: 'mod+left', collapse: 1, svg: icon('<path d="M4.5 13a7.5 7.5 0 1 0 2.2-6.3"/><path d="M4 4v5h5"/>') },
    { command: 'emulatorPanel.rotateRight', title: 'Rotate right', keys: 'mod+right', collapse: 1, svg: icon('<path d="M19.5 13a7.5 7.5 0 1 1-2.2-6.3"/><path d="M20 4v5h-5"/>') },
    { command: 'emulatorPanel.screenshot', title: 'Take screenshot', keys: 'mod+s', collapse: 4, svg: icon('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3"/>') },
  ],
  [
    { command: 'emulatorPanel.location', title: 'Location', keys: 'mod+shift+l', needsUi: true, collapse: 3, svg: icon('<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>') },
    {
      command: 'emulatorPanel.extendedControls',
      title: 'Extended controls',
      needsUi: true,
      svg: icon(
        '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
      ),
    },
  ],
];

interface EditorGroupLayout {
  orientation: number;
  groups: { size?: number; groups?: unknown[] }[];
}

export interface PanelEnvironment {
  extensionUri: vscode.Uri;
  protoDir: string;
  serverPath: string;
}

export interface SavedPanelState {
  devices: string[];
  focused?: string;
  separateWindow?: boolean;
}

interface SessionBase {
  readonly id: number;
  readonly name: string;
  readonly hasUi: boolean;
  box: { width: number; height: number };
  restartTimer?: NodeJS.Timeout;
  stopping?: boolean;
}

interface EmulatorSession extends SessionBase {
  readonly kind: 'emulator';
  readonly emulator: RunningEmulator;
  readonly client: EmulatorClient;
  displaySize?: { width: number; height: number };
  rotation: Rotation;
  stopStream?: () => void;
  awaitingDraw: boolean;
  pendingFrame?: Frame;
}

interface PhoneSession extends SessionBase {
  readonly kind: 'phone';
  readonly phone: AndroidPhone;
  readonly connection: ScrcpyConnection;
  forwarding: boolean;
}

type Session = EmulatorSession | PhoneSession;

type PanelAction = 'add' | 'newWindow' | 'mainWindow' | 'onTop';

const PANEL_ACTION_COMMANDS: Record<PanelAction, string> = {
  add: 'emulatorPanel.open',
  newWindow: 'emulatorPanel.moveToNewWindow',
  mainWindow: 'emulatorPanel.moveToMainWindow',
  onTop: 'emulatorPanel.toggleAlwaysOnTop',
};

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'panelAction'; action: PanelAction }
  | { type: 'close'; id: number }
  | { type: 'focus'; id: number }
  | { type: 'command'; id: number; command: string }
  | { type: 'layout'; reason: 'devices' | 'aspect' | 'request'; width: number; needed: number }
  | { type: 'resize'; id: number; width: number; height: number; dpr: number }
  | { type: 'drawn'; id: number }
  | { type: 'videoError'; id: number }
  | { type: 'videoStarted'; id: number; width: number; height: number }
  | { type: 'pointer'; id: number; phase: 'down' | 'move' | 'up'; pointer: number; u: number; v: number }
  | { type: 'wheel'; id: number; u: number; v: number; dx: number; dy: number }
  | { type: 'key'; id: number; key: string; eventType: KeyEventType };

const settings = () => vscode.workspace.getConfiguration('emulatorPanel');
const fitEnabled = () => settings().get<boolean>('fitColumnOnOpen', true);
const stopOnClose = () => settings().get<boolean>('stopOnClose', true);
const compactWindow = () => settings().get<boolean>('compactWindow', true);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

export class DevicePanel {
  static readonly viewType = 'emulatorPanel.device';
  static stopEmulator: ((emulator: RunningEmulator) => Promise<void>) | undefined;
  private static instance: DevicePanel | undefined;
  private static hiddenIds: number[] = [];
  private static hiddenFocus: number | undefined;
  private static readonly phoneIds = new Map<string, number>();
  private static readonly sessionsChanged = new vscode.EventEmitter<void>();
  static readonly onDidChangeSessions = DevicePanel.sessionsChanged.event;

  static get current(): DevicePanel | undefined {
    return DevicePanel.instance;
  }

  static mirroredSerials(): Set<string> {
    const sessions = DevicePanel.instance ? [...DevicePanel.instance.sessions.values()] : [];
    return new Set(sessions.flatMap((session) => (session.kind === 'phone' ? [session.phone.serial] : [])));
  }

  static closePhone(serial: string): void {
    const id = DevicePanel.phoneIds.get(serial);
    if (id !== undefined) {
      DevicePanel.instance?.removeSession(id);
    }
  }

  static savedState(): SavedPanelState | undefined {
    const devicePanel = DevicePanel.instance;
    if (!devicePanel || devicePanel.sessions.size === 0) {
      return undefined;
    }
    const focused = devicePanel.focusedSession();
    return {
      devices: [...devicePanel.sessions.values()].map((session) => DevicePanel.sessionKey(session)),
      focused: focused && DevicePanel.sessionKey(focused),
      separateWindow: devicePanel.separateWindow,
    };
  }

  static revive(
    panel: vscode.WebviewPanel,
    environment: PanelEnvironment,
    state: SavedPanelState | undefined,
    running: RunningEmulator[],
    phones: AndroidPhone[],
  ): void {
    if (DevicePanel.instance) {
      panel.dispose();
      return;
    }
    const devicePanel = new DevicePanel(panel, environment);
    DevicePanel.instance = devicePanel;
    devicePanel.separateWindow = !!state?.separateWindow;
    for (const key of state?.devices ?? []) {
      const separator = key.indexOf(':');
      const kind = key.slice(0, separator);
      const value = key.slice(separator + 1);
      const emulator = kind === 'emulator' ? running.find((candidate) => candidate.avdName === value) : undefined;
      const phone = kind === 'phone' ? phones.find((candidate) => candidate.serial === value) : undefined;
      if (emulator) {
        devicePanel.addEmulator(emulator, false);
      } else if (phone) {
        devicePanel.addPhone(phone, false);
      }
    }
    if (devicePanel.sessions.size === 0) {
      panel.dispose();
      return;
    }
    const focused = [...devicePanel.sessions.values()].find((session) => DevicePanel.sessionKey(session) === state?.focused);
    devicePanel.focus(focused?.id);
    DevicePanel.updateVisibilityContext();
    log.appendLine(`Restored Running Devices: ${[...devicePanel.sessions.values()].map((session) => session.name).join(', ')}`);
  }

  private static sessionKey(session: Session): string {
    return session.kind === 'phone' ? `phone:${session.phone.serial}` : `emulator:${session.emulator.avdName}`;
  }

  static get isVisible(): boolean {
    return !!DevicePanel.instance?.panel.visible;
  }

  static get inSeparateWindow(): boolean {
    return !!DevicePanel.instance?.separateWindow;
  }

  private static phoneId(serial: string): number {
    let id = DevicePanel.phoneIds.get(serial);
    if (id === undefined) {
      id = -(DevicePanel.phoneIds.size + 1);
      DevicePanel.phoneIds.set(serial, id);
    }
    return id;
  }

  static show(environment: PanelEnvironment, emulator: RunningEmulator): void {
    DevicePanel.ensure(environment, emulator.avdName).addEmulator(emulator);
  }

  static showPhone(environment: PanelEnvironment, phone: AndroidPhone): void {
    DevicePanel.ensure(environment, phone.name).addPhone(phone);
  }

  static async moveToNewWindow(): Promise<void> {
    const devicePanel = DevicePanel.instance;
    if (!devicePanel || devicePanel.separateWindow) {
      return;
    }
    devicePanel.panel.reveal(undefined, false);
    await delay(150);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    devicePanel.separateWindow = true;
    devicePanel.alwaysOnTop = false;
    devicePanel.fitPending = false;
    devicePanel.refitOnAspect = false;
    DevicePanel.updateVisibilityContext();
    devicePanel.postDevices();
    if (compactWindow()) {
      await delay(300);
      await vscode.commands.executeCommand('workbench.action.enableCompactAuxiliaryWindow');
    }
  }

  static async moveToMainWindow(environment: PanelEnvironment, running: RunningEmulator[], phones: AndroidPhone[]): Promise<void> {
    if (!DevicePanel.instance) {
      return;
    }
    DevicePanel.hide();
    await vscode.commands.executeCommand('workbench.action.switchToMainWindow');
    await delay(150);
    DevicePanel.restore(environment, running, phones);
  }

  static hide(): void {
    const devicePanel = DevicePanel.instance;
    if (!devicePanel) {
      return;
    }
    DevicePanel.hiddenIds = [...devicePanel.sessions.keys()];
    DevicePanel.hiddenFocus = devicePanel.focusedId;
    devicePanel.keepEmulatorsRunning = true;
    devicePanel.panel.dispose();
  }

  static reveal(): boolean {
    const devicePanel = DevicePanel.instance;
    if (!devicePanel) {
      return false;
    }
    devicePanel.panel.reveal(undefined, false);
    return true;
  }

  static restore(environment: PanelEnvironment, running: RunningEmulator[], phones: AndroidPhone[]): boolean {
    const emulators = new Map(running.map((emulator) => [emulator.pid, emulator]));
    const phonesById = new Map(phones.map((phone) => [DevicePanel.phoneId(phone.serial), phone]));
    const previous = DevicePanel.hiddenIds.filter((id) => emulators.has(id) || phonesById.has(id));
    const ids = previous.length > 0 ? previous : running.map((emulator) => emulator.pid);
    if (ids.length === 0) {
      return false;
    }
    const focus = DevicePanel.hiddenFocus;
    for (const id of ids) {
      const emulator = emulators.get(id);
      const phone = phonesById.get(id);
      if (emulator) {
        DevicePanel.show(environment, emulator);
      } else if (phone) {
        DevicePanel.showPhone(environment, phone);
      }
    }
    DevicePanel.instance?.focus(focus);
    return true;
  }

  private static ensure(environment: PanelEnvironment, title: string): DevicePanel {
    const existing = DevicePanel.instance;
    if (existing) {
      existing.panel.reveal(undefined, false);
      return existing;
    }
    const openIn = settings().get<string>('openIn');
    const panel = vscode.window.createWebviewPanel(
      DevicePanel.viewType,
      title,
      { viewColumn: openIn === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(environment.extensionUri, 'media')] },
    );
    const devicePanel = new DevicePanel(panel, environment);
    DevicePanel.instance = devicePanel;
    DevicePanel.hiddenIds = [];
    DevicePanel.updateVisibilityContext();
    return devicePanel;
  }

  private static updateVisibilityContext(): void {
    void vscode.commands.executeCommand('setContext', 'emulatorPanel.runningDevicesVisible', DevicePanel.isVisible);
    void vscode.commands.executeCommand('setContext', 'emulatorPanel.runningDevicesInWindow', DevicePanel.inSeparateWindow);
  }

  private readonly sessions = new Map<number, Session>();
  private readonly disposables: vscode.Disposable[] = [];
  private focusedId: number | undefined;
  private fitPending = false;
  private refitOnAspect = false;
  private keepEmulatorsRunning = false;
  private separateWindow = false;
  private alwaysOnTop = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly environment: PanelEnvironment,
  ) {
    panel.iconPath = {
      light: vscode.Uri.joinPath(environment.extensionUri, 'media', 'device-light.svg'),
      dark: vscode.Uri.joinPath(environment.extensionUri, 'media', 'device-dark.svg'),
    };
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(environment.extensionUri, 'media')] };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message)),
      panel.onDidChangeViewState(({ webviewPanel }) => {
        if (!webviewPanel.visible) {
          this.sessions.forEach((session) => this.pause(session));
        }
        DevicePanel.updateVisibilityContext();
      }),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('emulatorPanel.showToolbar')) {
          this.sessions.forEach((session) => this.pause(session));
          panel.webview.html = this.html();
        }
      }),
    );
  }

  get focusedEmulator(): RunningEmulator | undefined {
    const session = this.focusedSession();
    return session?.kind === 'emulator' ? session.emulator : undefined;
  }

  closeFocused(): void {
    this.removeSession(this.requireFocused().id);
  }

  async toggleAlwaysOnTop(): Promise<void> {
    if (!this.separateWindow) {
      return;
    }
    await vscode.commands.executeCommand('workbench.action.toggleWindowAlwaysOnTop');
    this.alwaysOnTop = !this.alwaysOnTop;
    this.postDevices();
  }

  focus(id: number | undefined): void {
    if (id !== undefined && this.sessions.has(id)) {
      this.focusedId = id;
      this.postDevices();
    }
  }

  prune(runningPids: Set<number>): void {
    for (const session of [...this.sessions.values()]) {
      if (session.kind === 'emulator' && !runningPids.has(session.id)) {
        this.removeSession(session.id);
      }
    }
  }

  key(key: string): void {
    const session = this.requireFocused();
    if (session.kind === 'emulator') {
      session.client.key(key);
      return;
    }
    const keycode = ANDROID_KEYCODES[key];
    if (keycode !== undefined) {
      session.connection.pressKey(keycode);
    }
  }

  async rotate(quadrants: number): Promise<void> {
    const session = this.requireFocused();
    this.refitOnAspect = fitEnabled();
    if (session.kind === 'phone') {
      session.connection.rotate();
      return;
    }
    await session.client.setRotation(ROTATION_QUADRANT[session.rotation] + quadrants);
  }

  async showPane(pane: Pane): Promise<void> {
    const session = this.requireFocused();
    if (session.kind === 'phone') {
      throw new Error(`${session.name} is a physical device, so the emulator's extended controls are not available.`);
    }
    if (!session.hasUi) {
      throw new Error(
        `${session.name} was started without the emulator UI, so extended controls are unavailable. Stop it and run it from the Device Manager.`,
      );
    }
    await session.client.showExtendedControls(pane);
  }

  screenshot(): Promise<Buffer> {
    const session = this.requireFocused();
    return session.kind === 'phone' ? androidScreenshot(session.phone.serial) : session.client.screenshot();
  }

  requestFit(): void {
    this.fitPending = true;
    this.post({ type: 'requestLayout' });
  }

  private addEmulator(emulator: RunningEmulator, fit = true): void {
    if (!this.sessions.has(emulator.pid)) {
      const session: EmulatorSession = {
        kind: 'emulator',
        id: emulator.pid,
        name: emulator.avdName,
        hasUi: emulator.hasUi,
        emulator,
        client: new EmulatorClient(emulator, this.environment.protoDir),
        rotation: 'PORTRAIT',
        awaitingDraw: false,
        box: { width: 0, height: 0 },
      };
      this.sessions.set(session.id, session);
      session.client.displaySize().then(
        (size) => {
          session.displaySize = size;
          this.postDevices();
        },
        (error: Error) => this.status(session, `Could not reach ${session.name}: ${error.message}`),
      );
      if (fit) {
        this.markForFit();
      }
    }
    this.focusedId = emulator.pid;
    this.updateTitle();
    this.postDevices();
  }

  private addPhone(phone: AndroidPhone, fit = true): void {
    const id = DevicePanel.phoneId(phone.serial);
    if (!this.sessions.has(id)) {
      let session: PhoneSession | undefined;
      const connection = new ScrcpyConnection(phone.serial, this.environment.serverPath, {
        onSession: (width, height) => {
          if (session) {
            this.postDevices();
            this.post({ type: 'video', id, kind: 'session', width, height });
          }
        },
        onPacket: (kind, pts, data) => {
          if (session?.forwarding) {
            this.post({ type: 'video', id, kind, pts, data: new Uint8Array(data) });
          }
        },
        onEnd: (error) => {
          if (session && this.sessions.get(id) === session) {
            this.status(session, error ? `${phone.name} disconnected: ${error.message}` : `${phone.name} disconnected`);
          }
        },
        onLog: (line) => log.appendLine(`[${phone.name}] ${line}`),
      });
      session = {
        kind: 'phone',
        id,
        name: phone.name,
        hasUi: false,
        phone,
        connection,
        forwarding: false,
        box: { width: 0, height: 0 },
      };
      this.sessions.set(id, session);
      const started = session;
      connection.start(PHONE_MAX_SIZE).catch((error: Error) => {
        log.appendLine(`Could not mirror ${phone.name}: ${error.message}`);
        if (this.sessions.get(id) === started) {
          this.status(started, `Could not mirror ${phone.name}: ${error.message}`);
        }
      });
      if (fit) {
        this.markForFit();
      }
    }
    this.focusedId = id;
    this.updateTitle();
    this.postDevices();
  }

  private removeSession(id: number): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    clearTimeout(session.restartTimer);
    this.release(session);
    this.sessions.delete(id);
    if (this.sessions.size === 0) {
      this.panel.dispose();
      return;
    }
    if (this.focusedId === id) {
      this.focusedId = this.sessions.keys().next().value;
    }
    this.markForFit();
    this.updateTitle();
    this.postDevices();
  }

  private release(session: Session): void {
    if (session.kind === 'emulator') {
      this.pause(session);
      session.client.close();
    } else {
      session.connection.close();
    }
  }

  private stopSession(session: Session): void {
    const stopEmulator = DevicePanel.stopEmulator;
    if (session.kind === 'phone' || !stopEmulator || !stopOnClose()) {
      this.removeSession(session.id);
      return;
    }
    if (session.stopping) {
      return;
    }
    session.stopping = true;
    this.status(session, `Stopping ${session.name}…`);
    stopEmulator(session.emulator).catch((error: Error) => {
      session.stopping = false;
      this.status(session, `Could not stop ${session.name}: ${error.message}`);
    });
  }

  private focusedSession(): Session | undefined {
    const focused = this.focusedId === undefined ? undefined : this.sessions.get(this.focusedId);
    return focused ?? this.sessions.values().next().value;
  }

  private requireFocused(): Session {
    const session = this.focusedSession();
    if (!session) {
      throw new Error('No device is open in Running Devices.');
    }
    return session;
  }

  private markForFit(): void {
    const enabled = fitEnabled();
    this.fitPending = enabled;
    this.refitOnAspect = enabled;
  }

  private updateTitle(): void {
    const [only] = this.sessions.values();
    this.panel.title = this.sessions.size === 1 && only ? only.name : 'Running Devices';
  }

  private post(message: object): void {
    void this.panel.webview.postMessage(message);
  }

  private postDevices(): void {
    DevicePanel.sessionsChanged.fire();
    this.post({
      type: 'devices',
      focused: this.focusedId,
      stopOnClose: stopOnClose(),
      separateWindow: this.separateWindow,
      alwaysOnTop: this.alwaysOnTop,
      devices: [...this.sessions.values()].map((session) => ({
        id: session.id,
        name: session.name,
        hasUi: session.hasUi,
        transport: session.kind === 'phone' ? 'h264' : 'png',
        aspect: this.aspectOf(session),
      })),
    });
  }

  private aspectOf(session: Session): number {
    if (session.kind === 'phone') {
      return session.connection.height ? session.connection.width / session.connection.height : 0;
    }
    return session.displaySize ? session.displaySize.width / session.displaySize.height : 0;
  }

  private onMessage(message: WebviewMessage): void {
    if (message.type === 'ready') {
      this.postDevices();
      return;
    }
    if (message.type === 'panelAction') {
      const command = PANEL_ACTION_COMMANDS[message.action];
      if (command) {
        void vscode.commands.executeCommand(command);
      }
      return;
    }
    if (message.type === 'layout') {
      if (this.separateWindow) {
        return;
      }
      if (this.fitPending || (message.reason === 'aspect' && this.refitOnAspect)) {
        this.fitPending = false;
        if (message.reason === 'aspect') {
          this.refitOnAspect = false;
        }
        this.fitColumn(message.width, message.needed).catch((error: Error) => log.appendLine(`Fit failed: ${error.message}`));
      }
      return;
    }

    const session = this.sessions.get(message.id);
    if (!session) {
      return;
    }
    switch (message.type) {
      case 'close':
        this.stopSession(session);
        return;
      case 'focus':
        this.focusedId = message.id;
        return;
      case 'command':
        this.focusedId = message.id;
        void vscode.commands.executeCommand(message.command);
        return;
    }
    if (session.kind === 'phone') {
      this.onPhoneMessage(session, message);
    } else {
      this.onEmulatorMessage(session, message);
    }
  }

  private onPhoneMessage(session: PhoneSession, message: WebviewMessage): void {
    const { connection } = session;
    switch (message.type) {
      case 'resize': {
        const visible = message.width > 0 && message.height > 0;
        if (visible && !session.forwarding) {
          session.forwarding = true;
          connection.resetVideo();
        } else if (!visible) {
          session.forwarding = false;
        }
        return;
      }
      case 'videoError':
        connection.resetVideo();
        return;
      case 'videoStarted':
        log.appendLine(`[${session.name}] Mirroring ${message.width}x${message.height}`);
        return;
      case 'pointer':
        connection.touch(message.phase, message.pointer, clamp01(message.u) * (connection.width - 1), clamp01(message.v) * (connection.height - 1));
        return;
      case 'wheel':
        connection.scroll(
          clamp01(message.u) * (connection.width - 1),
          clamp01(message.v) * (connection.height - 1),
          -message.dx / 100,
          -message.dy / 100,
        );
        return;
      case 'key': {
        const keycode = TYPED_KEYCODES[message.key];
        if (keycode !== undefined) {
          connection.key(message.eventType === 'keyup' ? 'up' : 'down', keycode);
        } else if (message.eventType === 'keydown' && [...message.key].length === 1) {
          connection.text(message.key);
        }
        return;
      }
    }
  }

  private onEmulatorMessage(session: EmulatorSession, message: WebviewMessage): void {
    switch (message.type) {
      case 'resize': {
        session.box = { width: Math.round(message.width * message.dpr), height: Math.round(message.height * message.dpr) };
        clearTimeout(session.restartTimer);
        if (!session.box.width || !session.box.height) {
          this.pause(session);
          return;
        }
        session.restartTimer = setTimeout(() => this.startStream(session), session.stopStream ? 150 : 0);
        return;
      }
      case 'drawn': {
        session.awaitingDraw = false;
        const next = session.pendingFrame;
        if (next) {
          session.pendingFrame = undefined;
          this.postFrame(session, next);
        }
        return;
      }
      case 'pointer': {
        const point = this.toDevice(session, message.u, message.v);
        if (point) {
          session.client.touch(point.x, point.y, message.phase !== 'up', message.pointer);
        }
        return;
      }
      case 'wheel': {
        const point = this.toDevice(session, message.u, message.v);
        if (point) {
          session.client.mouseMove(point.x, point.y);
        }
        session.client.wheel(Math.round(-message.dx), Math.round(-message.dy));
        return;
      }
      case 'key':
        session.client.key(message.key, message.eventType);
        return;
    }
  }

  private async fitColumn(width: number, needed: number): Promise<void> {
    const column = this.panel.viewColumn;
    const layout = await vscode.commands.executeCommand<EditorGroupLayout>('vscode.getEditorLayout');
    const details = `column=${column} width=${Math.round(width)} needed=${Math.round(needed)} layout=${JSON.stringify(layout)}`;
    if (
      !column ||
      width <= 0 ||
      needed <= 0 ||
      !layout ||
      layout.orientation !== 0 ||
      layout.groups.length < 2 ||
      layout.groups.some((group) => group.groups?.length)
    ) {
      log.appendLine(`Fit skipped, unsupported layout: ${details}`);
      return;
    }
    const index = column - 1;
    const group = layout.groups[index];
    const neighbor = layout.groups[index > 0 ? index - 1 : index + 1];
    if (!group?.size || !neighbor?.size) {
      log.appendLine(`Fit skipped, group sizes unknown: ${details}`);
      return;
    }
    const wanted = Math.round(needed - width);
    const change =
      wanted > 0
        ? Math.min(wanted, Math.max(0, neighbor.size - MIN_NEIGHBOR_WIDTH))
        : Math.max(wanted, MIN_NEIGHBOR_WIDTH - group.size);
    if (Math.abs(change) < 2) {
      log.appendLine(`Fit not needed: ${details}`);
      return;
    }
    group.size += change;
    neighbor.size -= change;
    await vscode.commands.executeCommand('vscode.setEditorLayout', layout);
    log.appendLine(`Fit column by ${change}px: ${details}`);
  }

  private toDevice(session: EmulatorSession, u: number, v: number): { x: number; y: number } | undefined {
    if (!session.displaySize) {
      return undefined;
    }
    const [cu, cv] = [clamp01(u), clamp01(v)];
    const w = session.displaySize.width - 1;
    const h = session.displaySize.height - 1;
    switch (session.rotation) {
      case 'LANDSCAPE':
        return { x: Math.round((1 - cv) * w), y: Math.round(cu * h) };
      case 'REVERSE_PORTRAIT':
        return { x: Math.round((1 - cu) * w), y: Math.round((1 - cv) * h) };
      case 'REVERSE_LANDSCAPE':
        return { x: Math.round(cv * w), y: Math.round((1 - cu) * h) };
      default:
        return { x: Math.round(cu * w), y: Math.round(cv * h) };
    }
  }

  private startStream(session: EmulatorSession): void {
    this.pause(session);
    const { width, height } = session.box;
    if (!width || !height) {
      return;
    }
    session.stopStream = session.client.streamScreen(
      width,
      height,
      (frame) => this.onFrame(session, frame),
      (error) => {
        session.stopStream = undefined;
        if (session.stopping) {
          this.status(session, `Stopping ${session.name}…`);
        } else {
          this.status(session, error ? `${session.name} disconnected: ${error.details || error.message}` : `${session.name} stopped`);
        }
      },
    );
  }

  private pause(session: Session): void {
    if (session.kind === 'phone') {
      session.forwarding = false;
      return;
    }
    session.stopStream?.();
    session.stopStream = undefined;
    session.awaitingDraw = false;
    session.pendingFrame = undefined;
  }

  private onFrame(session: EmulatorSession, frame: Frame): void {
    session.rotation = frame.rotation;
    if (session.awaitingDraw) {
      session.pendingFrame = frame;
      return;
    }
    this.postFrame(session, frame);
  }

  private postFrame(session: EmulatorSession, frame: Frame): void {
    session.awaitingDraw = true;
    this.panel.webview.postMessage({ type: 'frame', id: session.id, png: new Uint8Array(frame.png) }).then((delivered) => {
      if (!delivered) {
        session.awaitingDraw = false;
      }
    });
  }

  private status(session: Session, text: string | undefined): void {
    this.post({ type: 'status', id: session.id, text });
  }

  private dispose(): void {
    const stopEmulator = stopOnClose() && !this.keepEmulatorsRunning ? DevicePanel.stopEmulator : undefined;
    for (const session of this.sessions.values()) {
      clearTimeout(session.restartTimer);
      this.release(session);
      if (stopEmulator && session.kind === 'emulator' && !session.stopping) {
        stopEmulator(session.emulator).catch((error: Error) => log.appendLine(`Could not stop ${session.name}: ${error.message}`));
      }
    }
    this.sessions.clear();
    this.disposables.forEach((disposable) => disposable.dispose());
    if (DevicePanel.instance === this) {
      DevicePanel.instance = undefined;
      DevicePanel.updateVisibilityContext();
    }
    DevicePanel.sessionsChanged.fire();
  }

  private toolbarHtml(): string {
    if (!settings().get<boolean>('showToolbar', true)) {
      return '';
    }
    const groups = TOOL_GROUPS.map((tools) => {
      const buttons = tools
        .map((tool) => {
          const label = tool.keys ? `${tool.title} (${shortcut(tool.keys)})` : tool.title;
          const needsUi = tool.needsUi ? ` data-needs-ui="${tool.title}: not available on this device"` : '';
          const collapse = tool.collapse ? ` data-collapse="${tool.collapse}"` : '';
          return `<button class="tool" data-command="${tool.command}" title="${label}" aria-label="${tool.title}"${needsUi}${collapse}>${tool.svg}</button>`;
        })
        .join('');
      return `<span class="tool-group">${buttons}</span>`;
    });
    return `<div class="toolbar" role="toolbar">${groups.join('')}<span class="tool-group panel-actions">${this.panelActionsHtml()}</span></div>`;
  }

  private panelActionsHtml(): string {
    const button = (action: PanelAction, title: string, svg: string) =>
      `<button class="tool" data-panel="${action}" title="${title}" aria-label="${title}">${svg}</button>`;
    return [
      button(
        'newWindow',
        'Open in new window',
        icon('<rect x="3" y="8" width="12" height="12" rx="1.5"/><path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H15"/>'),
      ),
      button('onTop', 'Keep window on top', icon('<path d="M9 3.5h6l-1 5.5 3 3.5H7l3-3.5z"/><path d="M12 12.5V20.5"/>')),
      button('mainWindow', 'Move back to main window', icon('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M15 9l-5 5M10 9.5V14h4.5"/>')),
      button('add', 'Add device', icon('<path d="M12 5v14M5 12h14"/>')),
    ].join('');
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('hex');
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.environment.extensionUri, 'media', file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('panel.css')}">
</head>
<body>
<header id="header">
<div id="chips" role="tablist"></div>
<span class="panel-actions">${this.panelActionsHtml()}</span>
</header>
<main id="devices"></main>
<template id="toolbar-template">${this.toolbarHtml()}</template>
<script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}
