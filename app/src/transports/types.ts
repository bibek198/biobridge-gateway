// A Transport moves raw bytes and knows nothing about what they mean (that is the descriptor's job).
// Every chunk carries the host time it arrived, captured as early as possible.

export type TransportKind = "webserial" | "webbluetooth" | "simulated" | "replay";

export type ChunkListener = (chunk: Uint8Array, hostTimeMs: number) => void;
export type ClosedListener = (reason: string, isError: boolean) => void;

export interface Transport {
  readonly kind: TransportKind;
  isSupported(): boolean;
  /** May show a browser device picker; must then be called from a user gesture. */
  open(): Promise<void>;
  close(): Promise<void>;
  onChunk(listener: ChunkListener): () => void;
  /** Sends bytes to the device (commands). Rejects if this transport or device cannot receive. */
  write(bytes: Uint8Array): Promise<void>;
  /** Fires when the transport ends on its own (unplugged, BLE link lost, replay finished). */
  onClosed(listener: ClosedListener): () => void;
  /** Human-readable name of the device actually opened (e.g. BLE advertised name), once known. */
  deviceLabel(): string | null;
  /** Simulators only: the hidden truth (clock offset/drift, PTT) for evaluating sync methods. */
  groundTruth?(): Record<string, number> | null;
}

export abstract class BaseTransport implements Transport {
  abstract readonly kind: TransportKind;
  private chunkListeners = new Set<ChunkListener>();
  private closedListeners = new Set<ClosedListener>();

  abstract isSupported(): boolean;
  abstract open(): Promise<void>;
  abstract close(): Promise<void>;

  deviceLabel(): string | null {
    return null;
  }

  async write(_bytes: Uint8Array): Promise<void> {
    throw new Error(`${this.kind} transport cannot send to the device.`);
  }

  onChunk(listener: ChunkListener): () => void {
    this.chunkListeners.add(listener);
    return () => this.chunkListeners.delete(listener);
  }

  onClosed(listener: ClosedListener): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  protected emitChunk(chunk: Uint8Array, hostTimeMs: number): void {
    for (const l of this.chunkListeners) l(chunk, hostTimeMs);
  }

  protected emitClosed(reason: string, isError = true): void {
    for (const l of this.closedListeners) l(reason, isError);
  }
}
