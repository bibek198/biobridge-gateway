import { hostNowMs } from "../time/clock";
import { BaseTransport } from "./types";

export class SerialTransport extends BaseTransport {
  readonly kind = "webserial" as const;
  private readonly baudRate: number;
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stopped = false;

  constructor(baudRate: number) {
    super();
    this.baudRate = baudRate;
  }

  isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.serial;
  }

  async open(): Promise<void> {
    if (!navigator.serial) throw new Error("Web Serial is not supported in this browser.");
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: this.baudRate });
    this.stopped = false;
    void this.readLoop();
  }

  async write(bytes: Uint8Array): Promise<void> {
    const writable = this.port?.writable;
    if (!writable) throw new Error("Serial port is not open.");
    const writer = writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }

  deviceLabel(): string | null {
    const info = this.port?.getInfo?.();
    if (!info?.usbVendorId) return null;
    const hex = (n: number) => n.toString(16).padStart(4, "0");
    return `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId ?? 0)}`;
  }

  private async readLoop(): Promise<void> {
    if (!this.port?.readable) return;
    this.reader = this.port.readable.getReader();
    try {
      while (!this.stopped) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length > 0) this.emitChunk(value, hostNowMs());
      }
    } catch (err) {
      if (!this.stopped) {
        this.emitClosed(err instanceof Error ? err.message : "Serial read error.");
        return;
      }
    }
    if (!this.stopped) this.emitClosed("Serial device closed the stream.");
  }

  async close(): Promise<void> {
    this.stopped = true;
    try {
      await this.reader?.cancel();
      this.reader?.releaseLock();
    } catch {
      // reader already released or stream errored; safe to ignore during teardown
    }
    try {
      await this.port?.close();
    } catch {
      // port already closed
    }
    this.port = null;
    this.reader = null;
  }
}
