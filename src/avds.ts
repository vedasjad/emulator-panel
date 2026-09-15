import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseIni } from './discovery';

export interface AvdInfo {
  name: string;
  displayName: string;
  iniPath: string;
  dir: string;
  api?: string;
  apiLabel?: string;
  androidVersion?: string;
  abi?: string;
  image?: string;
  device?: string;
  resolution?: string;
}

const ANDROID_VERSIONS: Record<number, [version: string, codename: string]> = {
  21: ['5.0', 'Lollipop'],
  22: ['5.1', 'Lollipop'],
  23: ['6.0', 'Marshmallow'],
  24: ['7.0', 'Nougat'],
  25: ['7.1.1', 'Nougat'],
  26: ['8.0', 'Oreo'],
  27: ['8.1', 'Oreo'],
  28: ['9.0', 'Pie'],
  29: ['10.0', 'Q'],
  30: ['11.0', 'R'],
  31: ['12.0', 'S'],
  32: ['12L', 'Sv2'],
  33: ['13.0', 'Tiramisu'],
  34: ['14.0', 'UpsideDownCake'],
  35: ['15.0', 'VanillaIceCream'],
  36: ['16.0', 'Baklava'],
  37: ['17.0', 'CinnamonBun'],
};

const ABI_LABELS: Record<string, string> = {
  'arm64-v8a': 'arm64',
  'armeabi-v7a': 'arm',
};

export function avdHome(): string {
  if (process.env.ANDROID_AVD_HOME) {
    return process.env.ANDROID_AVD_HOME;
  }
  const userHome = process.env.ANDROID_USER_HOME ?? process.env.ANDROID_EMULATOR_HOME ?? path.join(os.homedir(), '.android');
  return path.join(userHome, 'avd');
}

function readIni(file: string): Record<string, string> {
  try {
    return parseIni(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function apiLabel(api: string | undefined): string | undefined {
  if (!api || api.includes('.')) {
    return api;
  }
  return Number(api) >= 36 ? `${api}.0` : api;
}

function androidVersion(api: string | undefined): string | undefined {
  if (!api) {
    return undefined;
  }
  const entry = ANDROID_VERSIONS[Math.floor(Number(api))];
  return entry ? `Android ${entry[0]} ("${entry[1]}")` : `API ${api}`;
}

export function readAvds(sdkRoot?: string): AvdInfo[] {
  const home = avdHome();
  let files: string[];
  try {
    files = fs.readdirSync(home).filter((file) => file.endsWith('.ini'));
  } catch {
    return [];
  }
  const avds: AvdInfo[] = [];
  for (const file of files) {
    const name = file.slice(0, -4);
    const iniPath = path.join(home, file);
    const ini = readIni(iniPath);
    const dir =
      ini['path'] && fs.existsSync(ini['path'])
        ? ini['path']
        : ini['path.rel']
          ? path.join(path.dirname(home), ini['path.rel'])
          : path.join(home, `${name}.avd`);
    if (!fs.existsSync(dir)) {
      continue;
    }
    const config = readIni(path.join(dir, 'config.ini'));
    const sysdir = config['image.sysdir.1'] ?? '';
    const imageProperties = sdkRoot && sysdir ? readIni(path.join(sdkRoot, sysdir, 'source.properties')) : {};
    const api =
      imageProperties['AndroidVersion.ApiLevel'] ??
      /android-([^/\\]+)/.exec(sysdir)?.[1] ??
      /android-(\S+)/.exec(ini['target'] ?? '')?.[1];
    const width = config['hw.lcd.width'];
    const height = config['hw.lcd.height'];
    const abi = config['abi.type'];
    avds.push({
      name,
      iniPath,
      dir,
      displayName: config['avd.ini.displayname'] || name.replace(/_/g, ' '),
      api,
      apiLabel: apiLabel(api),
      androidVersion: androidVersion(api),
      abi: abi ? (ABI_LABELS[abi] ?? abi) : undefined,
      image: [config['tag.display'], abi].filter(Boolean).join(' · ') || undefined,
      device: config['hw.device.name'] ? [config['hw.device.manufacturer'], config['hw.device.name']].filter(Boolean).join(' ') : undefined,
      resolution: width && height ? `${width}×${height}` : undefined,
    });
  }
  return avds;
}
