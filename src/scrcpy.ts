import { ChildProcess, execFile, execFileSync, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as net from 'net';
import { adb } from './physicalDevices';
import { adbPath } from './sdk';

export const SCRCPY_VERSION = '4.1';
export const SCRCPY_SERVER_FILE = `scrcpy-server-v${SCRCPY_VERSION}`;

const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';
const CODEC_H264 = 0x68323634;
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = FLAG_KEY_FRAME - 1n;

const MESSAGE = {
  injectKeycode: 0,
  injectText: 1,
  injectTouch: 2,
  injectScroll: 3,
  rotateDevice: 11,
  resetVideo: 17,
};

export type VideoPacketKind = 'config' | 'key' | 'delta';
export type TouchPhase = 'down' | 'move' | 'up';

export interface ScrcpyRecord {
  serial: string;
  scid: string;
  port: number;
}

export interface ScrcpyHandlers {
  onSession(width: number, height: number): void;
  onPacket(kind: VideoPacketKind, pts: number, data: Buffer): void;
  onEnd(error?: Error): void;
  onLog(line: string): void;
}

class ByteQueue {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  take(length: number): Buffer | undefined {
    if (this.size < length) {
      return undefined;
    }
    const first = this.chunks[0];
    let result: Buffer;
    if (first.length >= length) {
      result = first.subarray(0, length);
      if (first.length === length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(length);
      }
    } else {
      const merged = Buffer.concat(this.chunks, this.size);
      result = merged.subarray(0, length);
      const rest = merged.subarray(length);
      this.chunks = rest.length > 0 ? [rest] : [];
    }
    this.size -= length;
    return result;
  }
}

export class ScrcpyConnection {
  static onRecordsChanged: ((records: ScrcpyRecord[]) => void) | undefined;
  private static readonly live = new Set<ScrcpyConnection>();

  static records(): ScrcpyRecord[] {
    return [...ScrcpyConnection.live].flatMap((connection) =>
      connection.scid && connection.port ? [{ serial: connection.serial, scid: connection.scid, port: connection.port }] : [],
    );
  }

  static closeAllSync(): void {
    for (const connection of [...ScrcpyConnection.live]) {
      connection.closeSync();
    }
  }

  static async cleanup(records: ScrcpyRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    try {
      const forwards = (await adb(['forward', '--list'])).toString();
      for (const record of records) {
        if (forwards.includes(`tcp:${record.port} localabstract:scrcpy_${record.scid}`)) {
          await adb(['-s', record.serial, 'forward', '--remove', `tcp:${record.port}`]).catch(() => undefined);
        }
        await adb(['-s', record.serial, 'shell', 'pkill', '-f', `scid=${record.scid}`]).catch(() => undefined);
        execFile('pkill', ['-f', `scid=${record.scid}`], () => undefined);
      }
    } catch {
      return;
    }
  }

  private static changed(): void {
    ScrcpyConnection.onRecordsChanged?.(ScrcpyConnection.records());
  }

  width = 0;
  height = 0;
  private server: ChildProcess | undefined;
  private video: net.Socket | undefined;
  private control: net.Socket | undefined;
  private port: number | undefined;
  private scid: string | undefined;
  private closed = false;
  private readonly queue = new ByteQueue();
  private stage: 'name' | 'codec' | 'header' | 'body' = 'name';
  private pending: { flags: bigint; size: number } | undefined;

  constructor(
    readonly serial: string,
    private readonly serverPath: string,
    private readonly handlers: ScrcpyHandlers,
  ) {}

  async start(maxSize: number): Promise<void> {
    await adb(['-s', this.serial, 'push', this.serverPath, DEVICE_SERVER_PATH], 60_000);
    const scid = crypto.randomInt(1, 0x7fffffff).toString(16).padStart(8, '0');
    this.scid = scid;
    this.port = Number((await adb(['-s', this.serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scid}`])).toString().trim());
    if (!this.port) {
      throw new Error('adb did not return a forwarded port.');
    }
    if (this.closed) {
      void adb(['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`]).catch(() => undefined);
      throw new Error('The connection was closed.');
    }
    ScrcpyConnection.live.add(this);
    ScrcpyConnection.changed();
    this.server = spawn(adbPath(), [
      '-s',
      this.serial,
      'shell',
      `CLASSPATH=${DEVICE_SERVER_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SCRCPY_VERSION,
      `scid=${scid}`,
      'log_level=info',
      'audio=false',
      'video_codec=h264',
      `max_size=${maxSize}`,
      'max_fps=60',
      'video_bit_rate=8000000',
      'tunnel_forward=true',
      'clipboard_autosync=false',
    ]);
    const log = (chunk: Buffer) =>
      chunk
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => this.handlers.onLog(line));
    this.server.stdout?.on('data', log);
    this.server.stderr?.on('data', log);
    this.server.on('exit', (code) => this.fail(new Error(`The scrcpy server exited with code ${code}.`)));

    try {
      this.video = await this.connectVideo();
      this.control = await this.connectSocket();
    } catch (error) {
      this.close();
      throw error;
    }
    this.control.on('data', () => undefined);
    this.control.on('error', (error) => this.fail(error));
    this.control.on('close', () => this.fail());
  }

  touch(phase: TouchPhase, pointerId: number, x: number, y: number): void {
    if (!this.width || !this.height) {
      return;
    }
    const buffer = Buffer.alloc(32);
    buffer[0] = MESSAGE.injectTouch;
    buffer[1] = phase === 'down' ? 0 : phase === 'up' ? 1 : 2;
    buffer.writeBigUInt64BE(BigInt(Math.max(0, pointerId)), 2);
    buffer.writeUInt32BE(Math.max(0, Math.round(x)), 10);
    buffer.writeUInt32BE(Math.max(0, Math.round(y)), 14);
    buffer.writeUInt16BE(this.width, 18);
    buffer.writeUInt16BE(this.height, 20);
    buffer.writeUInt16BE(phase === 'up' ? 0 : 0xffff, 22);
    this.send(buffer);
  }

  scroll(x: number, y: number, horizontal: number, vertical: number): void {
    if (!this.width || !this.height) {
      return;
    }
    const fixedPoint = (value: number) => Math.max(-0x8000, Math.min(0x7fff, Math.round(Math.max(-1, Math.min(1, value / 16)) * 0x8000)));
    const buffer = Buffer.alloc(21);
    buffer[0] = MESSAGE.injectScroll;
    buffer.writeUInt32BE(Math.max(0, Math.round(x)), 1);
    buffer.writeUInt32BE(Math.max(0, Math.round(y)), 5);
    buffer.writeUInt16BE(this.width, 9);
    buffer.writeUInt16BE(this.height, 11);
    buffer.writeInt16BE(fixedPoint(horizontal), 13);
    buffer.writeInt16BE(fixedPoint(vertical), 15);
    this.send(buffer);
  }

  key(phase: 'down' | 'up', keycode: number): void {
    const buffer = Buffer.alloc(14);
    buffer[0] = MESSAGE.injectKeycode;
    buffer[1] = phase === 'down' ? 0 : 1;
    buffer.writeUInt32BE(keycode, 2);
    this.send(buffer);
  }

  pressKey(keycode: number): void {
    this.key('down', keycode);
    this.key('up', keycode);
  }

  text(text: string): void {
    const bytes = Buffer.from(text, 'utf8').subarray(0, 300);
    const buffer = Buffer.alloc(5 + bytes.length);
    buffer[0] = MESSAGE.injectText;
    buffer.writeUInt32BE(bytes.length, 1);
    bytes.copy(buffer, 5);
    this.send(buffer);
  }

  rotate(): void {
    this.send(Buffer.from([MESSAGE.rotateDevice]));
  }

  resetVideo(): void {
    this.send(Buffer.from([MESSAGE.resetVideo]));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.video?.destroy();
    this.control?.destroy();
    this.server?.kill();
    if (this.port) {
      void adb(['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`]).catch(() => undefined);
    }
    if (ScrcpyConnection.live.delete(this)) {
      ScrcpyConnection.changed();
    }
  }

  closeSync(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.video?.destroy();
    this.control?.destroy();
    this.server?.kill();
    ScrcpyConnection.live.delete(this);
    const run = (args: string[]) => {
      try {
        execFileSync(adbPath(), ['-s', this.serial, ...args], { timeout: 2000, stdio: 'ignore' });
      } catch {
        return;
      }
    };
    if (this.port) {
      run(['forward', '--remove', `tcp:${this.port}`]);
    }
    if (this.scid) {
      run(['shell', 'pkill', '-f', `scid=${this.scid}`]);
    }
  }

  private send(buffer: Buffer): void {
    if (this.control && !this.closed) {
      this.control.write(buffer);
    }
  }

  private fail(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.close();
    this.handlers.onEnd(error);
  }

  private connectSocket(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port!, '127.0.0.1');
      socket.once('connect', () => {
        socket.removeListener('error', reject);
        resolve(socket);
      });
      socket.once('error', reject);
    });
  }

  private async connectVideo(): Promise<net.Socket> {
    const deadline = Date.now() + 15_000;
    while (!this.closed) {
      const socket = await this.connectSocket().catch(() => undefined);
      if (socket) {
        const first = await new Promise<Buffer | undefined>((resolve) => {
          const cleanup = () => {
            socket.removeListener('data', onData);
            socket.removeListener('close', onEnd);
            socket.removeListener('error', onEnd);
          };
          const onData = (chunk: Buffer) => {
            cleanup();
            resolve(chunk);
          };
          const onEnd = () => {
            cleanup();
            resolve(undefined);
          };
          socket.on('data', onData);
          socket.once('close', onEnd);
          socket.once('error', onEnd);
        });
        if (first) {
          socket.on('data', (chunk: Buffer) => this.onVideoData(chunk));
          socket.on('close', () => this.fail());
          socket.on('error', (error) => this.fail(error));
          if (first.length > 1) {
            this.onVideoData(first.subarray(1));
          }
          return socket;
        }
        socket.destroy();
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out connecting to the scrcpy server on the device.');
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('The connection was closed.');
  }

  private onVideoData(chunk: Buffer): void {
    this.queue.push(chunk);
    for (;;) {
      if (this.stage === 'name') {
        if (!this.queue.take(64)) {
          return;
        }
        this.stage = 'codec';
      } else if (this.stage === 'codec') {
        const codec = this.queue.take(4);
        if (!codec) {
          return;
        }
        const id = codec.readUInt32BE(0);
        if (id !== CODEC_H264) {
          this.fail(
            new Error(
              id === 0
                ? 'The device disabled the video stream.'
                : id === 1
                  ? 'The device could not configure its video encoder.'
                  : `Unsupported video codec 0x${id.toString(16)}.`,
            ),
          );
          return;
        }
        this.stage = 'header';
      } else if (this.stage === 'header') {
        const header = this.queue.take(12);
        if (!header) {
          return;
        }
        if (header[0] & 0x80) {
          this.width = header.readUInt32BE(4);
          this.height = header.readUInt32BE(8);
          this.handlers.onSession(this.width, this.height);
        } else {
          this.pending = { flags: header.readBigUInt64BE(0), size: header.readUInt32BE(8) };
          this.stage = 'body';
        }
      } else {
        const pending = this.pending!;
        const body = this.queue.take(pending.size);
        if (!body) {
          return;
        }
        this.pending = undefined;
        this.stage = 'header';
        const kind: VideoPacketKind = pending.flags & FLAG_CONFIG ? 'config' : pending.flags & FLAG_KEY_FRAME ? 'key' : 'delta';
        this.handlers.onPacket(kind, kind === 'config' ? 0 : Number(pending.flags & PTS_MASK), body);
      }
    }
  }
}
