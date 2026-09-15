import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AvdInfo, avdHome, readAvds } from './avds';
import { RunningEmulator, discoveryDir, listRunning } from './discovery';
import { AdbEntry, AndroidPhone, IosPhone, adb, listAdbEntries, listAndroidPhones, listIosPhones } from './physicalDevices';
import { sdkRoot } from './sdk';
import { SimulatorInfo, listSimulators, simulatorsSupported } from './simulators';

export type DeviceStatus = 'stopped' | 'starting' | 'running' | 'stopping';

export interface Device {
  id: string;
  platform: 'android' | 'ios';
  status: DeviceStatus;
  avd?: AvdInfo;
  simulator?: SimulatorInfo;
  androidPhone?: AndroidPhone;
  iosPhone?: IosPhone;
  emulator?: RunningEmulator;
  serial?: string;
  external: boolean;
}

interface Transition {
  status: 'starting' | 'stopping';
  until: number;
}

const SIMULATOR_STATES: Record<string, DeviceStatus> = {
  Booted: 'running',
  Booting: 'starting',
  'Shutting Down': 'stopping',
};

async function externalEmulators(entries: AdbEntry[], knownSerials: Set<string>): Promise<Map<string, string>> {
  const serials = entries
    .map((entry) => entry.serial)
    .filter((serial) => serial.startsWith('emulator-') && !knownSerials.has(serial));
  const names = new Map<string, string>();
  await Promise.all(
    serials.map(async (serial) => {
      const output = (await adb(['-s', serial, 'emu', 'avd', 'name'], 3000).catch(() => Buffer.alloc(0))).toString();
      const name = output.split(/\r?\n/)[0]?.trim();
      if (name && name !== 'OK') {
        names.set(serial, name);
      }
    }),
  );
  return names;
}

export class DeviceStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Device[]>();
  readonly onDidChange = this.changed.event;
  private devices: Device[] = [];
  private readonly transitions = new Map<string, Transition>();
  private readonly watchers: fs.FSWatcher[] = [];
  private loading: Promise<Device[]> | undefined;
  private reloadQueued = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;

  constructor(private readonly shouldPoll: () => boolean) {
    const dirs = [discoveryDir(), avdHome()];
    if (simulatorsSupported) {
      dirs.push(path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices'));
    }
    for (const dir of dirs) {
      try {
        this.watchers.push(fs.watch(dir, () => this.refreshSoon()));
      } catch {
        continue;
      }
    }
    void this.refresh();
  }

  get current(): Device[] {
    return this.devices;
  }

  find(id: string): Device | undefined {
    return this.devices.find((device) => device.id === id);
  }

  markStarting(id: string): void {
    this.transitions.set(id, { status: 'starting', until: Date.now() + 180_000 });
    this.applyTransitions();
    void this.refresh();
  }

  markStopping(id: string): void {
    this.transitions.set(id, { status: 'stopping', until: Date.now() + 60_000 });
    this.applyTransitions();
    void this.refresh();
  }

  clearTransition(id: string): void {
    this.transitions.delete(id);
    void this.refresh();
  }

  refresh(): Promise<Device[]> {
    if (this.loading) {
      this.reloadQueued = true;
      return this.loading;
    }
    this.loading = this.load()
      .then((devices) => {
        this.devices = devices;
        this.changed.fire(devices);
        return devices;
      })
      .finally(() => {
        this.loading = undefined;
        if (this.reloadQueued) {
          this.reloadQueued = false;
          void this.refresh();
        } else {
          this.schedulePoll();
        }
      });
    return this.loading;
  }

  dispose(): void {
    clearTimeout(this.pollTimer);
    clearTimeout(this.debounceTimer);
    this.watchers.forEach((watcher) => watcher.close());
    this.changed.dispose();
  }

  private refreshSoon(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(), 250);
  }

  private schedulePoll(): void {
    clearTimeout(this.pollTimer);
    if (this.transitions.size > 0) {
      this.pollTimer = setTimeout(() => void this.refresh(), 1000);
    } else if (this.shouldPoll()) {
      this.pollTimer = setTimeout(() => void this.refresh(), 4000);
    }
  }

  private applyTransitions(): void {
    this.devices = this.devices.map((device) => {
      const transition = this.transitions.get(device.id);
      return transition ? { ...device, status: transition.status } : device;
    });
    this.changed.fire(this.devices);
  }

  private resolveStatus(id: string, observed: DeviceStatus, settled: (transition: Transition) => boolean): DeviceStatus {
    const transition = this.transitions.get(id);
    if (!transition) {
      return observed;
    }
    if (settled(transition) || Date.now() > transition.until) {
      this.transitions.delete(id);
      return observed;
    }
    return transition.status;
  }

  private async load(): Promise<Device[]> {
    let root: string | undefined;
    try {
      root = sdkRoot();
    } catch {
      root = undefined;
    }
    const running = listRunning();
    const serialOf = (emulator: RunningEmulator) => `emulator-${emulator.consolePort}`;
    const entries = await listAdbEntries().catch(() => [] as AdbEntry[]);
    const [external, simulators, androidPhones, iosPhones] = await Promise.all([
      externalEmulators(entries, new Set(running.map(serialOf))).catch(() => new Map<string, string>()),
      listSimulators().catch(() => [] as SimulatorInfo[]),
      listAndroidPhones(entries).catch(() => [] as AndroidPhone[]),
      listIosPhones().catch(() => [] as IosPhone[]),
    ]);

    const emulators: Device[] = readAvds(root).map((avd) => {
      const emulator = running.find((candidate) => candidate.avdName === avd.name);
      const serial = emulator ? serialOf(emulator) : [...external].find(([, name]) => name === avd.name)?.[0];
      const status = this.resolveStatus(avd.name, serial ? 'running' : 'stopped', (transition) =>
        transition.status === 'starting' ? !!emulator : !serial,
      );
      return { id: avd.name, platform: 'android', status, avd, emulator, serial, external: !!serial && !emulator };
    });

    const androidDevices: Device[] = androidPhones.map((phone) => ({
      id: `android:${phone.serial}`,
      platform: 'android',
      status: phone.state === 'device' ? 'running' : 'stopped',
      androidPhone: phone,
      serial: phone.serial,
      external: false,
    }));

    const iosSimulators: Device[] = simulators.map((simulator) => {
      const status = this.resolveStatus(simulator.udid, SIMULATOR_STATES[simulator.state] ?? 'stopped', (transition) =>
        transition.status === 'starting' ? simulator.state === 'Booted' : simulator.state === 'Shutdown',
      );
      return { id: simulator.udid, platform: 'ios', status, simulator, external: false };
    });

    const iosDevices: Device[] = iosPhones.map((phone) => ({
      id: `ios:${phone.udid}`,
      platform: 'ios',
      status: phone.connected ? 'running' : 'stopped',
      iosPhone: phone,
      external: false,
    }));

    return [...emulators, ...androidDevices, ...iosSimulators, ...iosDevices];
  }
}
