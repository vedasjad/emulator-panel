import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Coordinate } from './simulators';

export interface SavedPoint extends Coordinate {
  name: string;
  description?: string;
}

interface ProtoFields {
  strings: Map<number, string>;
  doubles: Map<number, number>;
}

function decodeProto(buffer: Buffer): ProtoFields {
  const fields: ProtoFields = { strings: new Map(), doubles: new Map() };
  let offset = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (offset >= buffer.length) {
        throw new RangeError('The point file ends inside a number.');
      }
      const byte = buffer[offset++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (byte < 0x80) {
        return result;
      }
    }
  };
  while (offset < buffer.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    switch (key % 8) {
      case 0:
        varint();
        break;
      case 1:
        fields.doubles.set(field, buffer.readDoubleLE(offset));
        offset += 8;
        break;
      case 2: {
        const length = varint();
        fields.strings.set(field, buffer.toString('utf8', offset, offset + length));
        offset += length;
        break;
      }
      case 5:
        offset += 4;
        break;
      default:
        return fields;
    }
  }
  return fields;
}

export function readSavedPoints(): SavedPoint[] {
  const userHome = process.env.ANDROID_USER_HOME ?? process.env.ANDROID_EMULATOR_HOME ?? path.join(os.homedir(), '.android');
  const dir = path.join(userHome, 'locations', 'points');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const points: SavedPoint[] = [];
  for (const entry of entries) {
    try {
      const fields = decodeProto(fs.readFileSync(path.join(dir, entry, 'point_metadata.pb')));
      const lat = fields.doubles.get(3);
      const lon = fields.doubles.get(4);
      if (lat === undefined || lon === undefined) {
        continue;
      }
      points.push({
        name: fields.strings.get(1) || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
        description: fields.strings.get(7) || fields.strings.get(6) || undefined,
        lat,
        lon,
      });
    } catch {
      continue;
    }
  }
  return points.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseCoordinate(text: string): Coordinate | undefined {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) {
    return undefined;
  }
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : undefined;
}

export function parseRouteFile(file: string): Coordinate[] {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.kml$/i.test(file)) {
    return [...text.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/gi)].flatMap((block) =>
      block[1]
        .trim()
        .split(/\s+/)
        .map((tuple) => tuple.split(',').map(Number))
        .filter(([lon, lat]) => Number.isFinite(lat) && Number.isFinite(lon))
        .map(([lon, lat]) => ({ lat, lon })),
    );
  }
  const points: Coordinate[] = [];
  for (const tag of ['trkpt', 'rtept', 'wpt']) {
    for (const match of text.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))) {
      const lat = Number(/\blat="([^"]+)"/.exec(match[1])?.[1]);
      const lon = Number(/\blon="([^"]+)"/.exec(match[1])?.[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        points.push({ lat, lon });
      }
    }
    if (points.length > 0) {
      break;
    }
  }
  return points;
}
