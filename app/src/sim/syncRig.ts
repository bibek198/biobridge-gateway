import { hostNowMs } from "../time/clock";

export type SyncEdgeListener = (edge: 0 | 1, trueHostMs: number) => void;

/**
 * Simulated Paper 1 ground-truth rig: one GPIO pulse train wired to every simulated node's sync input.
 * Each node stamps the same physical edge with its own clock, exactly as the hardware rig will.
 *
 * Edges are reported at their exact instants, not at JS timer ticks, and the spacing between pulses is
 * randomised (period ± jitter). A strictly periodic rig is commensurate with BLE connection intervals
 * (1000 ms / 15 ms repeats every 3 pulses), so every edge would land at the same few phases of the
 * connection-event grid and the least-delayed observation would never get close to the true delay
 * floor. The hardware sync node must randomise its spacing for the same reason.
 * Runs only while at least one node listens.
 */
export class SimSyncRig {
  readonly periodMs: number;
  readonly jitterMs: number;
  readonly widthMs: number;
  private listeners = new Set<SyncEdgeListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private next: { edge: 0 | 1; t: number } | null = null;

  constructor(periodMs = 1000, jitterMs = 200, widthMs = 50) {
    this.periodMs = periodMs;
    this.jitterMs = jitterMs;
    this.widthMs = widthMs;
  }

  subscribe(listener: SyncEdgeListener): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.next = { edge: 1, t: hostNowMs() + Math.random() * this.periodMs };
      this.schedule();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private schedule(): void {
    const ev = this.next!;
    this.timer = setTimeout(() => {
      for (const l of this.listeners) l(ev.edge, ev.t);
      const gap = this.periodMs + (Math.random() - 0.5) * 2 * this.jitterMs;
      this.next = ev.edge === 1 ? { edge: 0, t: ev.t + this.widthMs } : { edge: 1, t: ev.t - this.widthMs + gap };
      this.schedule();
    }, Math.max(0, ev.t - hostNowMs()));
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.next = null;
  }
}
