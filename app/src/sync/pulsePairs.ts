// Pairs SYNC_EVENTs from different devices that report the same physical edge of the sync rig.
// Both devices saw the edge at the same instant, so after clock mapping their times should be equal:
// the difference is the sync error between the two devices, measured against hardware ground truth.

export type PulseErrorPoint = { t: number; errMs: number };

export type PulsePairSeries = {
  key: string;
  a: string;
  b: string;
  /** err = mapped time on a − mapped time on b, for each pulse edge both devices reported. */
  points: PulseErrorPoint[];
};

type PulseEvent = { edge: number; t: number; matched: Set<string> };

export class PulsePairTracker {
  private readonly maxPairMs: number;
  private readonly keep: number;
  private recent = new Map<string, { group: string; events: PulseEvent[] }>();
  private series = new Map<string, PulsePairSeries>();

  /** maxPairMs must stay under half the pulse spacing, or edges could pair with the wrong pulse. */
  constructor(maxPairMs = 250, keep = 7200) {
    this.maxPairMs = maxPairMs;
    this.keep = keep;
  }

  /** Records an edge reported by `source` at mapped host time t. Sources pair only within one group. */
  add(source: string, edge: number, t: number, group = "live"): void {
    let entry = this.recent.get(source);
    if (!entry) {
      entry = { group, events: [] };
      this.recent.set(source, entry);
    }
    const ev: PulseEvent = { edge, t, matched: new Set() };

    for (const [other, o] of this.recent) {
      if (other === source || o.group !== group) continue;
      let best: PulseEvent | null = null;
      for (const cand of o.events) {
        if (cand.edge !== edge || cand.matched.has(source)) continue;
        if (Math.abs(cand.t - t) <= this.maxPairMs && (!best || Math.abs(cand.t - t) < Math.abs(best.t - t))) best = cand;
      }
      if (!best) continue;
      best.matched.add(source);
      ev.matched.add(other);
      const [a, b] = source < other ? [source, other] : [other, source];
      const key = `${a}|${b}`;
      let s = this.series.get(key);
      if (!s) {
        s = { key, a, b, points: [] };
        this.series.set(key, s);
      }
      s.points.push({ t: Math.max(t, best.t), errMs: a === source ? t - best.t : best.t - t });
      if (s.points.length > this.keep) s.points.shift();
    }

    entry.events.push(ev);
    if (entry.events.length > 16) entry.events.shift();
  }

  removeSource(source: string): void {
    this.recent.delete(source);
    for (const [key, s] of this.series) if (s.a === source || s.b === source) this.series.delete(key);
  }

  getSeries(): PulsePairSeries[] {
    return [...this.series.values()];
  }
}
