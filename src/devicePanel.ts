import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { RunningEmulator } from './discovery';
import { EmulatorClient, Frame, KeyEventType, Pane, Rotation } from './emulatorClient';
import { log } from './log';

const ROTATION_QUADRANT: Record<Rotation, number> = {
  PORTRAIT: 0,
  LANDSCAPE: 1,
  REVERSE_PORTRAIT: 2,
  REVERSE_LANDSCAPE: 3,
};

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
}

const TOOL_GROUPS: Tool[][] = [
  [
    { command: 'emulatorPanel.back', title: 'Back', keys: 'mod+backspace', svg: icon('<path d="M16 5v14L6 12z"/>') },
    { command: 'emulatorPanel.home', title: 'Home', keys: 'mod+shift+h', svg: icon('<circle cx="12" cy="12" r="7"/>') },
    { command: 'emulatorPanel.overview', title: 'Overview', keys: 'mod+o', svg: icon('<rect x="6" y="6" width="12" height="12" rx="1.5"/>') },
  ],
  [
    { command: 'emulatorPanel.volumeDown', title: 'Volume down', keys: 'mod+-', svg: icon('<path d="M4 9h3l5-4v14l-5-4H4z"/><path d="M16 12h5"/>') },
    { command: 'emulatorPanel.volumeUp', title: 'Volume up', keys: 'mod+=', svg: icon('<path d="M4 9h3l5-4v14l-5-4H4z"/><path d="M16 12h5M18.5 9.5v5"/>') },
    { command: 'emulatorPanel.power', title: 'Power', keys: 'mod+p', svg: icon('<path d="M12 3v8"/><path d="M7.05 6.05a7 7 0 1 0 9.9 0"/>') },
  ],
  [
    { command: 'emulatorPanel.rotateLeft', title: 'Rotate left', keys: 'mod+left', svg: icon('<path d="M4.5 13a7.5 7.5 0 1 0 2.2-6.3"/><path d="M4 4v5h5"/>') },
    { command: 'emulatorPanel.rotateRight', title: 'Rotate right', keys: 'mod+right', svg: icon('<path d="M19.5 13a7.5 7.5 0 1 1-2.2-6.3"/><path d="M20 4v5h-5"/>') },
    { command: 'emulatorPanel.screenshot', title: 'Take screenshot', keys: 'mod+s', svg: icon('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3"/>') },
  ],
  [
    { command: 'emulatorPanel.location', title: 'Location', keys: 'mod+shift+l', needsUi: true, svg: icon('<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>') },
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

const MIN_NEIGHBOR_WIDTH = 220;

interface Session {
  readonly emulator: RunningEmulator;
  readonly client: EmulatorClient;
  displaySize?: { width: number; height: number };
  rotation: Rotation;
  stopStream?: () => void;
  awaitingDraw: boolean;
  pendingFrame?: Frame;
  box: { width: number; height: number };
  restartTimer?: NodeJS.Timeout;
  stopping?: boolean;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'panelAction'; action: PanelAction }
  | { type: 'close'; id: number }
  | { type: 'focus'; id: number }
  | { type: 'command'; id: number; command: string }
  | { type: 'layout'; reason: 'devices' | 'aspect' | 'request'; width: number; needed: number }
  | { type: 'resize'; id: number; width: number; height: number; dpr: number }
  | { type: 'drawn'; id: number }
  | { type: 'pointer'; id: number; phase: 'down' | 'move' | 'up'; pointer: number; u: number; v: number }
  | { type: 'wheel'; id: number; u: number; v: number; dx: number; dy: number }
  | { type: 'key'; id: number; key: string; eventType: KeyEventType };

const fitEnabled = () => vscode.workspace.getConfiguration('emulatorPanel').get<boolean>('fitColumnOnOpen', true);
const stopOnClose = () => vscode.workspace.getConfiguration('emulatorPanel').get<boolean>('stopOnClose', true);
const compactWindow = () => vscode.workspace.getConfiguration('emulatorPanel').get<boolean>('compactWindow', true);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type PanelAction = 'add' | 'newWindow' | 'mainWindow' | 'onTop';

const PANEL_ACTION_COMMANDS: Record<PanelAction, string> = {
  add: 'emulatorPanel.open',
  newWindow: 'emulatorPanel.moveToNewWindow',
  mainWindow: 'emulatorPanel.moveToMainWindow',
  onTop: 'emulatorPanel.toggleAlwaysOnTop',
};

export class DevicePanel {
  static readonly viewType = 'emulatorPanel.device';
  static stopEmulator: ((emulator: RunningEmulator) => Promise<void>) | undefined;
  private static instance: DevicePanel | undefined;
  private static hiddenPids: number[] = [];
  private static hiddenFocus: number | undefined;

  static get current(): DevicePanel | undefined {
    return DevicePanel.instance;
  }

  static get isVisible(): boolean {
    return !!DevicePanel.instance?.panel.visible;
  }

  static get inSeparateWindow(): boolean {
    return !!DevicePanel.instance?.separateWindow;
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

  static async moveToMainWindow(extensionUri: vscode.Uri, running: RunningEmulator[], protoDir: string): Promise<void> {
    if (!DevicePanel.instance) {
      return;
    }
    DevicePanel.hide();
    await vscode.commands.executeCommand('workbench.action.switchToMainWindow');
    await delay(150);
    DevicePanel.restore(extensionUri, running, protoDir);
  }

  static hide(): void {
    const devicePanel = DevicePanel.instance;
    if (!devicePanel) {
      return;
    }
    DevicePanel.hiddenPids = [...devicePanel.sessions.keys()];
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

  static restore(extensionUri: vscode.Uri, running: RunningEmulator[], protoDir: string): boolean {
    const byPid = new Map(running.map((emulator) => [emulator.pid, emulator]));
    const previous = DevicePanel.hiddenPids
      .map((pid) => byPid.get(pid))
      .filter((emulator): emulator is RunningEmulator => !!emulator);
    const emulators = previous.length > 0 ? previous : running;
    if (emulators.length === 0) {
      return false;
    }
    for (const emulator of emulators) {
      DevicePanel.show(extensionUri, emulator, protoDir);
    }
    DevicePanel.instance?.focus(DevicePanel.hiddenFocus);
    return true;
  }

  private static updateVisibilityContext(): void {
    void vscode.commands.executeCommand('setContext', 'emulatorPanel.runningDevicesVisible', DevicePanel.isVisible);
    void vscode.commands.executeCommand('setContext', 'emulatorPanel.runningDevicesInWindow', DevicePanel.inSeparateWindow);
  }

  static show(extensionUri: vscode.Uri, emulator: RunningEmulator, protoDir: string): void {
    let devicePanel = DevicePanel.instance;
    if (devicePanel) {
      devicePanel.panel.reveal(undefined, false);
    } else {
      const openIn = vscode.workspace.getConfiguration('emulatorPanel').get<string>('openIn');
      const panel = vscode.window.createWebviewPanel(
        DevicePanel.viewType,
        emulator.avdName,
        { viewColumn: openIn === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] },
      );
      devicePanel = new DevicePanel(panel, extensionUri, protoDir);
      DevicePanel.instance = devicePanel;
      DevicePanel.hiddenPids = [];
      DevicePanel.updateVisibilityContext();
    }
    devicePanel.addSession(emulator);
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
    private readonly extensionUri: vscode.Uri,
    private readonly protoDir: string,
  ) {
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'device-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'device-dark.svg'),
    };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message)),
      panel.onDidChangeViewState(({ webviewPanel }) => {
        if (!webviewPanel.visible) {
          this.sessions.forEach((session) => this.pauseStream(session));
        }
        DevicePanel.updateVisibilityContext();
      }),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('emulatorPanel.showToolbar')) {
          this.sessions.forEach((session) => this.pauseStream(session));
          panel.webview.html = this.html();
        }
      }),
    );
  }

  get focusedEmulator(): RunningEmulator | undefined {
    return this.focusedSession()?.emulator;
  }

  async toggleAlwaysOnTop(): Promise<void> {
    if (!this.separateWindow) {
      return;
    }
    await vscode.commands.executeCommand('workbench.action.toggleWindowAlwaysOnTop');
    this.alwaysOnTop = !this.alwaysOnTop;
    this.postDevices();
  }

  focus(pid: number | undefined): void {
    if (pid !== undefined && this.sessions.has(pid)) {
      this.focusedId = pid;
      this.postDevices();
    }
  }

  addSession(emulator: RunningEmulator): void {
    if (!this.sessions.has(emulator.pid)) {
      const session: Session = {
        emulator,
        client: new EmulatorClient(emulator, this.protoDir),
        rotation: 'PORTRAIT',
        awaitingDraw: false,
        box: { width: 0, height: 0 },
      };
      this.sessions.set(emulator.pid, session);
      session.client.displaySize().then(
        (size) => {
          session.displaySize = size;
          this.postDevices();
        },
        (error: Error) => this.status(session, `Could not reach ${emulator.avdName}: ${error.message}`),
      );
      this.markForFit();
    }
    this.focusedId = emulator.pid;
    this.updateTitle();
    this.postDevices();
  }

  removeSession(pid: number): void {
    const session = this.sessions.get(pid);
    if (!session) {
      return;
    }
    clearTimeout(session.restartTimer);
    this.pauseStream(session);
    session.client.close();
    this.sessions.delete(pid);
    if (this.sessions.size === 0) {
      this.panel.dispose();
      return;
    }
    if (this.focusedId === pid) {
      this.focusedId = this.sessions.keys().next().value;
    }
    this.markForFit();
    this.updateTitle();
    this.postDevices();
  }

  private stopSession(session: Session): void {
    const stopEmulator = DevicePanel.stopEmulator;
    if (!stopEmulator || !stopOnClose()) {
      this.removeSession(session.emulator.pid);
      return;
    }
    if (session.stopping) {
      return;
    }
    const name = session.emulator.avdName;
    session.stopping = true;
    this.status(session, `Stopping ${name}…`);
    stopEmulator(session.emulator).catch((error: Error) => {
      session.stopping = false;
      this.status(session, `Could not stop ${name}: ${error.message}`);
    });
  }

  prune(runningPids: Set<number>): void {
    for (const pid of [...this.sessions.keys()]) {
      if (!runningPids.has(pid)) {
        this.removeSession(pid);
      }
    }
  }

  key(key: string): void {
    this.requireFocused().client.key(key);
  }

  async rotate(quadrants: number): Promise<void> {
    const session = this.requireFocused();
    this.refitOnAspect = fitEnabled();
    await session.client.setRotation(ROTATION_QUADRANT[session.rotation] + quadrants);
  }

  async showPane(pane: Pane): Promise<void> {
    const session = this.requireFocused();
    if (!session.emulator.hasUi) {
      throw new Error(
        `${session.emulator.avdName} was started without the emulator UI, so extended controls are unavailable. Stop it and run it from the Device Manager.`,
      );
    }
    await session.client.showExtendedControls(pane);
  }

  screenshot(): Promise<Buffer> {
    return this.requireFocused().client.screenshot();
  }

  requestFit(): void {
    this.fitPending = true;
    void this.panel.webview.postMessage({ type: 'requestLayout' });
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
    this.panel.title = this.sessions.size === 1 && only ? only.emulator.avdName : 'Running Devices';
  }

  private postDevices(): void {
    void this.panel.webview.postMessage({
      type: 'devices',
      focused: this.focusedId,
      stopOnClose: stopOnClose(),
      separateWindow: this.separateWindow,
      alwaysOnTop: this.alwaysOnTop,
      devices: [...this.sessions.values()].map((session) => ({
        id: session.emulator.pid,
        name: session.emulator.avdName,
        hasUi: session.emulator.hasUi,
        aspect: session.displaySize ? session.displaySize.width / session.displaySize.height : 0,
      })),
    });
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
        break;
      case 'focus':
        this.focusedId = message.id;
        break;
      case 'command':
        this.focusedId = message.id;
        void vscode.commands.executeCommand(message.command);
        break;
      case 'resize': {
        session.box = { width: Math.round(message.width * message.dpr), height: Math.round(message.height * message.dpr) };
        clearTimeout(session.restartTimer);
        if (!session.box.width || !session.box.height) {
          this.pauseStream(session);
          break;
        }
        session.restartTimer = setTimeout(() => this.startStream(session), session.stopStream ? 150 : 0);
        break;
      }
      case 'drawn': {
        session.awaitingDraw = false;
        const next = session.pendingFrame;
        if (next) {
          session.pendingFrame = undefined;
          this.postFrame(session, next);
        }
        break;
      }
      case 'pointer': {
        const point = this.toDevice(session, message.u, message.v);
        if (point) {
          session.client.touch(point.x, point.y, message.phase !== 'up', message.pointer);
        }
        break;
      }
      case 'wheel': {
        const point = this.toDevice(session, message.u, message.v);
        if (point) {
          session.client.mouseMove(point.x, point.y);
        }
        session.client.wheel(Math.round(-message.dx), Math.round(-message.dy));
        break;
      }
      case 'key':
        session.client.key(message.key, message.eventType);
        break;
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

  private toDevice(session: Session, u: number, v: number): { x: number; y: number } | undefined {
    if (!session.displaySize) {
      return undefined;
    }
    const clamp = (n: number) => Math.min(Math.max(n, 0), 1);
    const [cu, cv] = [clamp(u), clamp(v)];
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

  private startStream(session: Session): void {
    this.pauseStream(session);
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
        const name = session.emulator.avdName;
        if (session.stopping) {
          this.status(session, `Stopping ${name}…`);
        } else {
          this.status(session, error ? `${name} disconnected: ${error.details || error.message}` : `${name} stopped`);
        }
      },
    );
  }

  private pauseStream(session: Session): void {
    session.stopStream?.();
    session.stopStream = undefined;
    session.awaitingDraw = false;
    session.pendingFrame = undefined;
  }

  private onFrame(session: Session, frame: Frame): void {
    session.rotation = frame.rotation;
    if (session.awaitingDraw) {
      session.pendingFrame = frame;
      return;
    }
    this.postFrame(session, frame);
  }

  private postFrame(session: Session, frame: Frame): void {
    session.awaitingDraw = true;
    this.panel.webview
      .postMessage({ type: 'frame', id: session.emulator.pid, png: new Uint8Array(frame.png) })
      .then((delivered) => {
        if (!delivered) {
          session.awaitingDraw = false;
        }
      });
  }

  private status(session: Session, text: string | undefined): void {
    void this.panel.webview.postMessage({ type: 'status', id: session.emulator.pid, text });
  }

  private dispose(): void {
    const stopEmulator = stopOnClose() && !this.keepEmulatorsRunning ? DevicePanel.stopEmulator : undefined;
    for (const session of this.sessions.values()) {
      clearTimeout(session.restartTimer);
      this.pauseStream(session);
      session.client.close();
      if (stopEmulator && !session.stopping) {
        stopEmulator(session.emulator).catch((error: Error) =>
          log.appendLine(`Could not stop ${session.emulator.avdName}: ${error.message}`),
        );
      }
    }
    this.sessions.clear();
    this.disposables.forEach((disposable) => disposable.dispose());
    if (DevicePanel.instance === this) {
      DevicePanel.instance = undefined;
      DevicePanel.updateVisibilityContext();
    }
  }

  private toolbarHtml(): string {
    if (!vscode.workspace.getConfiguration('emulatorPanel').get<boolean>('showToolbar', true)) {
      return '';
    }
    const groups = TOOL_GROUPS.map((tools) =>
      tools
        .map((tool) => {
          const label = tool.keys ? `${tool.title} (${shortcut(tool.keys)})` : tool.title;
          const needsUi = tool.needsUi ? ` data-needs-ui="${tool.title}: unavailable, this emulator was started without its UI"` : '';
          return `<button class="tool" data-command="${tool.command}" title="${label}" aria-label="${tool.title}"${needsUi}>${tool.svg}</button>`;
        })
        .join(''),
    );
    const actions = `<span class="separator panel-separator"></span><span class="panel-actions">${this.panelActionsHtml()}</span>`;
    return `<div class="toolbar" role="toolbar">${groups.join('<span class="separator"></span>')}${actions}</div>`;
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
      button(
        'mainWindow',
        'Move back to main window',
        icon('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M15 9l-5 5M10 9.5V14h4.5"/>'),
      ),
      button('add', 'Add device', icon('<path d="M12 5v14M5 12h14"/>')),
    ].join('');
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('hex');
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
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
