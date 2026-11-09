import type { RecordedChunk, RecordingConnection, RecordingMeta } from "./recording";
import type { RecordingStore } from "./recordingStore";

const FLUSH_MS = 1000;

/** Captures raw chunks from any number of connections into one recording, flushing to IndexedDB. */
export class Recorder {
  private readonly store: RecordingStore;
  private meta: RecordingMeta | null = null;
  private pending: RecordedChunk[] = [];
  private batchNo = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  /** Last storage failure (e.g. quota exceeded). That batch is lost; later batches are still attempted. */
  lastError: string | null = null;

  constructor(store: RecordingStore) {
    this.store = store;
  }

  get active(): RecordingMeta | null {
    return this.meta;
  }

  async start(name: string, connections: RecordingConnection[], now: number): Promise<RecordingMeta> {
    if (this.meta) throw new Error("Already recording.");
    this.meta = {
      id: `rec-${Math.round(now)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      startedAt: now,
      endedAt: null,
      connections: [...connections],
      chunkCount: 0,
      byteCount: 0,
    };
    this.pending = [];
    this.batchNo = 0;
    await this.store.saveMeta(this.meta);
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    return this.meta;
  }

  /** A device connected mid-recording. */
  addConnection(conn: RecordingConnection): void {
    if (!this.meta || this.meta.connections.some((c) => c.key === conn.key)) return;
    this.meta.connections.push(conn);
  }

  push(connectionKey: string, bytes: Uint8Array, t: number): void {
    // Chunks from a connection not (yet) part of the recording, e.g. while it is still connecting, are skipped.
    if (!this.meta || !this.meta.connections.some((c) => c.key === connectionKey)) return;
    this.pending.push({ t, c: connectionKey, bytes: bytes.slice() });
    this.meta.chunkCount++;
    this.meta.byteCount += bytes.length;
  }

  async stop(now: number): Promise<RecordingMeta | null> {
    if (!this.meta) return null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.meta.endedAt = now;
    await this.flush();
    const finished = this.meta;
    this.meta = null;
    return finished;
  }

  private flush(): Promise<void> {
    const meta = this.meta;
    if (!meta) return this.flushing;
    const items = this.pending;
    this.pending = [];
    const n = this.batchNo++;
    const snapshot = { ...meta, connections: [...meta.connections] };
    // Serialise writes so batches land in order even if IndexedDB is slow.
    this.flushing = this.flushing
      .then(async () => {
        if (items.length > 0) await this.store.appendBatch(meta.id, n, items);
        await this.store.saveMeta(snapshot);
      })
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      });
    return this.flushing;
  }
}
