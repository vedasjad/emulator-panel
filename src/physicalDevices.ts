import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { adbPath } from './sdk';
import { simulatorsSupported } from './simulators';

export interface AdbEntry {
  serial: string;
  state: string;
  usb: boolean;
  model?: string;
}

export interface AndroidPhone {
  serial: string;
  state: string;
  connection: 'USB' | 'Wi-Fi';
  name: string;
  model?: string;
  sdk?: string;
  abi?: string;
}

export interface IosPhone {
  udid: string;
  name: string;
  model?: string;
  osVersion?: string;
  connected: boolean;
  connection?: 'USB' | 'Wi-Fi';
}

interface PhoneProperties {
  name?: string;
  sdk?: string;
  abi?: string;
}

function run(command: string, args: string[], timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        const message = Buffer.concat(stderr).toString().trim().split('\n').pop();
        reject(new Error(message || `${path.basename(command)} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

export const adb = (args: string[], timeoutMs?: number) => run(adbPath(), args, timeoutMs);

export async function listAdbEntries(): Promise<AdbEntry[]> {
  const output = (await adb(['devices', '-l'])).toString();
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*') && !line.startsWith('List of devices'))
    .map((line) => {
      const [serial, state, ...fields] = line.split(/\s+/);
      const properties = Object.fromEntries(
        fields.filter((field) => field.includes(':')).map((field) => [field.slice(0, field.indexOf(':')), field.slice(field.indexOf(':') + 1)]),
      );
      return { serial, state, usb: 'usb' in properties, model: properties.model?.replace(/_/g, ' ') };
    });
}

const propertyCache = new Map<string, PhoneProperties>();

async function readProperties(serial: string): Promise<PhoneProperties> {
  const cached = propertyCache.get(serial);
  if (cached) {
    return cached;
  }
  const output = (await adb(['-s', serial, 'shell', 'getprop'])).toString();
  const props: Record<string, string> = {};
  for (const match of output.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]/gm)) {
    props[match[1]] = match[2];
  }
  const marketName = props['ro.product.marketname'] || props['ro.product.vendor.marketname'];
  const properties: PhoneProperties = {
    name: marketName || [props['ro.product.manufacturer'], props['ro.product.model']].filter(Boolean).join(' ') || undefined,
    sdk: props['ro.build.version.sdk'] || undefined,
    abi: props['ro.product.cpu.abi'] || undefined,
  };
  propertyCache.set(serial, properties);
  return properties;
}

export async function listAndroidPhones(entries: AdbEntry[]): Promise<AndroidPhone[]> {
  const phones = entries.filter((entry) => !entry.serial.startsWith('emulator-'));
  return Promise.all(
    phones.map(async (entry) => {
      const properties: PhoneProperties = entry.state === 'device' ? await readProperties(entry.serial).catch(() => ({})) : {};
      const wireless = !entry.usb && /:|_adb-tls-connect/.test(entry.serial);
      return {
        serial: entry.serial,
        state: entry.state,
        connection: wireless ? 'Wi-Fi' : 'USB',
        name: properties.name ?? entry.model ?? entry.serial,
        model: entry.model,
        sdk: properties.sdk,
        abi: properties.abi,
      };
    }),
  );
}

let iosCache: { at: number; phones: IosPhone[] } | undefined;
let iosLoading: Promise<IosPhone[]> | undefined;

async function loadIosPhones(): Promise<IosPhone[]> {
  const file = path.join(os.tmpdir(), `emulator-panel-devicectl-${process.pid}.json`);
  try {
    await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', file], 20000);
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return (data.result?.devices ?? [])
      .filter((device: any) => device.hardwareProperties?.reality === 'physical' && ['iOS', 'iPadOS'].includes(device.hardwareProperties?.platform))
      .map((device: any): IosPhone => {
        const transport = device.connectionProperties?.transportType;
        return {
          udid: device.hardwareProperties?.udid ?? device.identifier,
          name: device.deviceProperties?.name ?? device.hardwareProperties?.marketingName ?? 'iPhone',
          model: device.hardwareProperties?.marketingName,
          osVersion: device.deviceProperties?.osVersionNumber,
          connected: !!transport || device.connectionProperties?.tunnelState === 'connected',
          connection: transport === 'wired' ? 'USB' : transport ? 'Wi-Fi' : undefined,
        };
      });
  } finally {
    await fs.promises.rm(file, { force: true });
  }
}

export async function listIosPhones(): Promise<IosPhone[]> {
  if (!simulatorsSupported) {
    return [];
  }
  if (iosCache && Date.now() - iosCache.at < 10_000) {
    return iosCache.phones;
  }
  iosLoading ??= loadIosPhones()
    .then((phones) => {
      iosCache = { at: Date.now(), phones };
      return phones;
    })
    .finally(() => {
      iosLoading = undefined;
    });
  return iosLoading;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const androidScreenshot = (serial: string) => adb(['-s', serial, 'exec-out', 'screencap', '-p'], 20000);

export const androidOpenUrl = (serial: string, url: string) =>
  adb(['-s', serial, 'shell', `am start -a android.intent.action.VIEW -d ${shellQuote(url)}`]).then(() => undefined);

export async function androidNightMode(serial: string): Promise<boolean> {
  const output = (await adb(['-s', serial, 'shell', 'cmd', 'uimode', 'night'])).toString();
  return /night mode:\s*yes/i.test(output);
}

export const setAndroidNightMode = (serial: string, enabled: boolean) =>
  adb(['-s', serial, 'shell', 'cmd', 'uimode', 'night', enabled ? 'yes' : 'no']).then(() => undefined);

export const rebootAndroid = (serial: string) => adb(['-s', serial, 'reboot']).then(() => undefined);
