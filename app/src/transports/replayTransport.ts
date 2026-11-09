import { hostNowMs } from "../time/clock";
import { BaseTransport } from "./types";

export type ReplayChunk = { t: number; bytes: Uint8Array };

/**
 * Plays recorded raw chunks back with their original spacing. Chunks are re-stamped onto the current
 * host timeline (recorded offset + replay start) so live views behave as during capture.
 */
export class ReplayTransport extends BaseTransport {
  readonly kind = "replay" as const;
  private readonly chunks: ReplayChunk[];
  private readonly t0: number;
  private readonly label: string;
  private readonly speed: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private index = 0;
  private startHostMs = 0;

  /** t0 is the recording's start time, shared by all connections of a recording so they stay aligned. */
  constructor(chunks: ReplayChunk[], t0: number, label: string, speed = 1) {
    super();
    this.chunks = chunks;
    this.t0 = t0;
    this.label = label;
    this.speed = speed;
  }

  isSupported(): boolean {
    return true;
  }

  deviceLabel(): string {
    return this.label;
  }

  /** Pin the replay start so several replays of one recording share a clock. Call before open(). */
  startAt(startHostMs: number): void {
    this.startHostMs = startHostMs;
  }

  async open(): Promise<void> {
    this.index = 0;
    if (this.startHostMs === 0) this.startHostMs = hostNowMs();
    this.schedule();
  }

  private schedule(): void {
    if (this.index >= this.chunks.length) {
      this.timer = null;
      this.emitClosed("Replay finished.", false);
      return;
    }
    const due = this.startHostMs + (this.chunks[this.index].t - this.t0) / this.speed;
    this.timer = setTimeout(() => this.flush(), Math.max(0, due - hostNowMs()));
  }

  private flush(): void {
    const now = hostNowMs();
    while (this.index < this.chunks.length) {
      const c = this.chunks[this.index];
      const due = this.startHostMs + (c.t - this.t0) / this.speed;
      if (due > now) break;
      this.emitChunk(c.bytes, due);
      this.index++;
    }
    this.schedule();
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.index = this.chunks.length;
  }
}
