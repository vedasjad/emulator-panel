import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SimulatorInfo {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  runtimeVersion: string;
  family?: string;
  dataPath: string;
}

export interface Coordinate {
  lat: number;
  lon: number;
}

export const simulatorsSupported = process.platform === 'darwin';

function simctl(args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('xcrun', ['simctl', ...args]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        const message = Buffer.concat(stderr).toString().trim().split('\n').pop();
        reject(new Error(message || `simctl ${args[0]} exited with code ${code}`));
      }
    });
    child.stdin.end(input);
  });
}

export async function listSimulators(): Promise<SimulatorInfo[]> {
  if (!simulatorsSupported) {
    return [];
  }
  const data = JSON.parse((await simctl(['list', '-j'])).toString());
  const runtimes = new Map<string, { name: string; version: string }>(
    (data.runtimes ?? []).map((runtime: any) => [runtime.identifier, { name: runtime.name, version: runtime.version }]),
  );
  const families = new Map<string, string>(
    (data.devicetypes ?? []).map((type: any) => [type.identifier, type.productFamily]),
  );
  const simulators: SimulatorInfo[] = [];
  for (const [runtimeId, devices] of Object.entries<any[]>(data.devices ?? {})) {
    const runtime = runtimes.get(runtimeId);
    for (const device of devices) {
      if (!device.isAvailable) {
        continue;
      }
      simulators.push({
        udid: device.udid,
        name: device.name,
        state: device.state,
        runtime: runtime?.name ?? runtimeId.split('.').pop()?.replace(/-/g, ' ') ?? runtimeId,
        runtimeVersion: runtime?.version ?? '',
        family: families.get(device.deviceTypeIdentifier),
        dataPath: device.dataPath,
      });
    }
  }
  return simulators;
}

export async function showSimulatorWindow(udid: string): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    execFile('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], (error) => (error ? reject(error) : resolve())),
  );
}

export async function bootSimulator(udid: string): Promise<void> {
  await simctl(['boot', udid]).catch((error: Error) => {
    if (!/current state: Booted/i.test(error.message)) {
      throw error;
    }
  });
  await showSimulatorWindow(udid);
}

export const shutdownSimulator = (udid: string) => simctl(['shutdown', udid]).then(() => undefined);
export const eraseSimulator = (udid: string) => simctl(['erase', udid]).then(() => undefined);
export const deleteSimulator = (udid: string) => simctl(['delete', udid]).then(() => undefined);
export const openUrl = (udid: string, url: string) => simctl(['openurl', udid, url]).then(() => undefined);
export async function screenshotSimulator(udid: string): Promise<Buffer> {
  const file = path.join(os.tmpdir(), `emulator-panel-${udid}-${Date.now()}.png`);
  await simctl(['io', udid, 'screenshot', '--type=png', file]);
  try {
    return await fs.promises.readFile(file);
  } finally {
    await fs.promises.rm(file, { force: true });
  }
}

export async function getAppearance(udid: string): Promise<string> {
  return (await simctl(['ui', udid, 'appearance'])).toString().trim();
}

export const setAppearance = (udid: string, appearance: 'light' | 'dark') =>
  simctl(['ui', udid, 'appearance', appearance]).then(() => undefined);

export const setLocation = (udid: string, point: Coordinate) =>
  simctl(['location', udid, 'set', `${point.lat},${point.lon}`]).then(() => undefined);

export const clearLocation = (udid: string) => simctl(['location', udid, 'clear']).then(() => undefined);

export function playRoute(udid: string, points: Coordinate[], speedMetersPerSecond: number): Promise<void> {
  const waypoints = points.map((point) => `${point.lat},${point.lon}`).join('\n');
  return simctl(['location', udid, 'start', `--speed=${speedMetersPerSecond}`, '-'], `${waypoints}\n`).then(() => undefined);
}

export async function listLocationScenarios(udid: string): Promise<string[]> {
  const output = (await simctl(['location', udid, 'list'])).toString();
  return output
    .split('\n')
    .slice(output.split('\n').findIndex((line) => line.startsWith('===')) + 1)
    .map((line) => line.split(/\s{2,}/)[0]?.trim())
    .filter((name): name is string => !!name);
}

export const runLocationScenario = (udid: string, scenario: string) =>
  simctl(['location', udid, 'run', scenario]).then(() => undefined);
