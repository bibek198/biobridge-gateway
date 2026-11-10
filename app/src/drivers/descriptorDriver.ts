import { compileDescriptor, type Decoder, type DecoderStats } from "../descriptors/compile";
import type { Descriptor } from "../descriptors/types";
import { WindowedMinOffsetMapper, type ClockEstimate, type ClockMapper } from "../time/clock";
import type { ChunkListener, Transport } from "../transports/types";
import { BaseDriver, type DeviceMetadata, type DriverKind } from "./types";

/**
 * The one driver implementation: a Transport (how bytes arrive) + a compiled Descriptor (what they mean).
 * Adding a device means writing a descriptor, not a class.
 */
export class DescriptorDriver extends BaseDriver {
  readonly metadata: DeviceMetadata;
  readonly descriptor: Descriptor;
  readonly transport: Transport;
  private readonly decoder: Decoder;
  private readonly clock: ClockMapper;
  private info: Record<string, number | string> = {};
  private rawListeners = new Set<ChunkListener>();
  private unsubs: Array<() => void> = [];

  constructor(descriptor: Descriptor, transport: Transport, clock: ClockMapper = new WindowedMinOffsetMapper()) {
    super();
    this.descriptor = descriptor;
    this.transport = transport;
    this.decoder = compileDescriptor(descriptor);
    this.clock = clock;
    this.metadata = {
      id: descriptor.id,
      name: descriptor.name,
      driverType: transport.kind as DriverKind,
      channels: descriptor.channels.map((c) => c.id),
    };
  }

  isSupported(): boolean {
    return this.transport.isSupported();
  }

  getStats(): DecoderStats {
    return this.decoder.stats;
  }

  getInfo(): Record<string, number | string> {
    return this.info;
  }

  getClockMapperName(): string {
    return this.clock.name;
  }

  getClockDetail(): string | null {
    return this.clock.describe?.() ?? null;
  }

  getClockEstimate(): ClockEstimate | null {
    return this.clock.estimate?.() ?? null;
  }

  /** Sends one of the descriptor's commands (e.g. "mode-edge") to the device. */
  async sendCommand(id: string): Promise<void> {
    const cmd = this.descriptor.commands?.find((c) => c.id === id);
    if (!cmd) throw new Error(`${this.descriptor.id} has no command "${id}".`);
    await this.transport.write(Uint8Array.from(cmd.hex.match(/../g)!.map((b) => parseInt(b, 16))));
  }

  /** Raw bytes exactly as received, before decoding. Recordings are made from this. */
  onRawChunk(listener: ChunkListener): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (!this.isSupported()) {
      this.setStatus("error", `${this.transport.kind} is not supported in this browser.`);
      return;
    }
    this.setStatus("connecting");
    this.decoder.reset();
    this.clock.reset();
    this.unsubs = [
      this.transport.onChunk((chunk, t) => this.handleChunk(chunk, t)),
      this.transport.onClosed((reason, isError) => this.setStatus(isError ? "error" : "disconnected", isError ? reason : null)),
    ];
    try {
      await this.transport.open();
      this.setStatus("connected");
    } catch (err) {
      for (const u of this.unsubs) u();
      this.unsubs = [];
      this.setStatus("error", err instanceof Error ? err.message : "Failed to connect.");
    }
  }

  async disconnect(): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    await this.transport.close();
    this.setStatus("disconnected");
  }

  private handleChunk(chunk: Uint8Array, hostTimeMs: number): void {
    for (const l of this.rawListeners) l(chunk, hostTimeMs);

    const out = this.decoder.push(chunk);
    if (out.info) this.info = { ...this.info, ...out.info };

    for (const m of out.timedMessages ?? []) this.clock.observe(m.deviceUs, hostTimeMs, m);

    for (const s of out.samples) {
      this.emitReading({
        timestamp: s.deviceTimestampUs === undefined ? hostTimeMs : this.clock.toHostMs(s.deviceTimestampUs),
        channel: s.channel,
        value: s.value,
        unit: s.unit,
        hostTimestamp: hostTimeMs,
        deviceTimestampUs: s.deviceTimestampUs,
        seq: s.seq,
      });
    }
  }
}
