import { execFile } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { AvdInfo, avdHome, readAvds } from './avds';
import { RunningEmulator, discoveryDir, listRunning } from './discovery';
import { adbPath, sdkRoot } from './sdk';

export type DeviceStatus = 'stopped' | 'starting' | 'running' | 'stopping';

export interface Device {
  avd: AvdInfo;
  status: DeviceStatus;
  emulator?: RunningEmulator;
  serial?: string;
  external: boolean;
}

interface Transition {
  status: 'starting' | 'stopping';
  until: number;
}

function adb(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(adbPath(), args, { timeout: 3000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );
}

async function externalEmulators(knownSerials: Set<string>): Promise<Map<string, string>> {
  const serials = (await adb(['devices']))
    .split(/\r?\n/)
    .map((line) => line.split('\t')[0]?.trim())
    .filter((serial): serial is string => !!serial && serial.startsWith('emulator-') && !knownSerials.has(serial));
  const names = new Map<string, string>();
  await Promise.all(
    serials.map(async (serial) => {
      const output = await adb(['-s', serial, 'emu', 'avd', 'name']).catch(() => '');
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
    for (const dir of [discoveryDir(), avdHome()]) {
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

  find(name: string): Device | undefined {
    return this.devices.find((device) => device.avd.name === name);
  }

  markStarting(name: string): void {
    this.transitions.set(name, { status: 'starting', until: Date.now() + 180_000 });
    this.applyTransitions();
    void this.refresh();
  }

  markStopping(name: string): void {
    this.transitions.set(name, { status: 'stopping', until: Date.now() + 60_000 });
    this.applyTransitions();
    void this.refresh();
  }

  clearTransition(name: string): void {
    this.transitions.delete(name);
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
      const transition = this.transitions.get(device.avd.name);
      return transition ? { ...device, status: transition.status } : device;
    });
    this.changed.fire(this.devices);
  }

  private async load(): Promise<Device[]> {
    let root: string | undefined;
    try {
      root = sdkRoot();
    } catch {
      root = undefined;
    }
    const avds = readAvds(root);
    const running = listRunning();
    const serialOf = (emulator: RunningEmulator) => `emulator-${emulator.consolePort}`;
    const external = await externalEmulators(new Set(running.map(serialOf))).catch(() => new Map<string, string>());
    const now = Date.now();
    return avds.map((avd) => {
      const emulator = running.find((candidate) => candidate.avdName === avd.name);
      const serial = emulator ? serialOf(emulator) : [...external].find(([, name]) => name === avd.name)?.[0];
      let status: DeviceStatus = serial ? 'running' : 'stopped';
      const transition = this.transitions.get(avd.name);
      if (transition) {
        const settled = transition.status === 'starting' ? !!emulator : !serial;
        if (settled || now > transition.until) {
          this.transitions.delete(avd.name);
        } else {
          status = transition.status;
        }
      }
      return { avd, status, emulator, serial, external: !!serial && !emulator };
    });
  }
}
