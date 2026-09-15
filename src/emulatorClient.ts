import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { RunningEmulator } from './discovery';

export type Pane =
  | 'KEEP_CURRENT'
  | 'LOCATION'
  | 'CELLULAR'
  | 'BATTERY'
  | 'CAMERA'
  | 'TELEPHONE'
  | 'MICROPHONE'
  | 'FINGER'
  | 'VIRT_SENSORS'
  | 'SNAPSHOT'
  | 'RECORD'
  | 'SETTINGS';

export type Rotation = 'PORTRAIT' | 'LANDSCAPE' | 'REVERSE_PORTRAIT' | 'REVERSE_LANDSCAPE';

export type KeyEventType = 'keydown' | 'keyup' | 'keypress';

export interface Frame {
  png: Buffer;
  width: number;
  height: number;
  rotation: Rotation;
}

const packages = new Map<string, any>();

function controlPackage(protoDir: string): any {
  let pkg = packages.get(protoDir);
  if (!pkg) {
    const definition = loader.loadSync(['emulator_controller.proto', 'ui_controller_service.proto'], {
      includeDirs: [protoDir],
      keepCase: true,
      defaults: true,
      enums: String,
      longs: Number,
    });
    pkg = (grpc.loadPackageDefinition(definition) as any).android.emulation.control;
    packages.set(protoDir, pkg);
  }
  return pkg;
}

export class EmulatorClient {
  private readonly controller: any;
  private readonly ui: any;
  private readonly metadata = new grpc.Metadata();
  private input: grpc.ClientWritableStream<object> | undefined;

  constructor(readonly emulator: RunningEmulator, protoDir: string) {
    const pkg = controlPackage(protoDir);
    const target = `localhost:${emulator.grpcPort}`;
    const options = { 'grpc.max_receive_message_length': 64 * 1024 * 1024 };
    this.controller = new pkg.EmulatorController(target, grpc.credentials.createInsecure(), options);
    this.ui = new pkg.UiController(target, grpc.credentials.createInsecure(), options);
    if (emulator.token) {
      this.metadata.add('authorization', `Bearer ${emulator.token}`);
    }
  }

  private unary<T>(client: any, method: string, request: object): Promise<T> {
    return new Promise((resolve, reject) => {
      client[method](request, this.metadata, (error: grpc.ServiceError | null, response: T) =>
        error ? reject(error) : resolve(response),
      );
    });
  }

  async displaySize(): Promise<{ width: number; height: number }> {
    const status: any = await this.unary(this.controller, 'getStatus', {});
    const config: Record<string, string> = { ...(status.platformConfig ?? {}) };
    for (const entry of status.hardwareConfig?.entry ?? []) {
      config[entry.key] ??= entry.value;
    }
    const width = Number(config['hw.lcd.width']);
    const height = Number(config['hw.lcd.height']);
    if (width && height) {
      return { width, height };
    }
    const image: any = await this.unary(this.controller, 'getScreenshot', { format: 'PNG' });
    const sideways = ['LANDSCAPE', 'REVERSE_LANDSCAPE'].includes(image.format.rotation?.rotation);
    return sideways
      ? { width: image.format.height, height: image.format.width }
      : { width: image.format.width, height: image.format.height };
  }

  streamScreen(
    width: number,
    height: number,
    onFrame: (frame: Frame) => void,
    onEnd: (error?: grpc.ServiceError) => void,
  ): () => void {
    const call = this.controller.streamScreenshot({ format: 'PNG', width, height }, this.metadata);
    let cancelled = false;
    call.on('data', (image: any) =>
      onFrame({
        png: image.image,
        width: image.format.width,
        height: image.format.height,
        rotation: image.format.rotation?.rotation ?? 'PORTRAIT',
      }),
    );
    call.on('error', (error: grpc.ServiceError) => {
      if (!cancelled) {
        onEnd(error);
      }
    });
    call.on('end', () => {
      if (!cancelled) {
        onEnd();
      }
    });
    return () => {
      cancelled = true;
      call.cancel();
    };
  }

  private send(event: object): void {
    if (!this.input) {
      const stream: grpc.ClientWritableStream<object> = this.controller.streamInputEvent(this.metadata, () => {
        if (this.input === stream) {
          this.input = undefined;
        }
      });
      this.input = stream;
    }
    try {
      this.input.write(event);
    } catch {
      this.input = undefined;
    }
  }

  touch(x: number, y: number, down: boolean, identifier: number): void {
    this.send({ touch_event: { touches: [{ x, y, identifier, pressure: down ? 1 : 0, expiration: 'NEVER_EXPIRE' }] } });
  }

  mouseMove(x: number, y: number): void {
    this.send({ mouse_event: { x, y, buttons: 0 } });
  }

  wheel(dx: number, dy: number): void {
    this.send({ wheel_event: { dx, dy } });
  }

  key(key: string, eventType: KeyEventType = 'keypress'): void {
    this.send({ key_event: { key, eventType } });
  }

  async setRotation(quadrants: number): Promise<void> {
    const z = [0, 90, 180, -90][((quadrants % 4) + 4) % 4];
    await this.unary(this.controller, 'setPhysicalModel', { target: 'ROTATION', value: { data: [0, 0, z] } });
  }

  async showExtendedControls(pane: Pane): Promise<void> {
    await this.unary(this.ui, 'showExtendedControls', { index: pane });
  }

  async screenshot(): Promise<Buffer> {
    const image: any = await this.unary(this.controller, 'getScreenshot', { format: 'PNG' });
    return image.image;
  }

  close(): void {
    this.input?.end();
    this.input = undefined;
    this.controller.close();
    this.ui.close();
  }
}
