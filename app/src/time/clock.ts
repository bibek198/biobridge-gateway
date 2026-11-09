import type { Descriptor } from "../descriptors/types";

/** High-resolution host time in epoch milliseconds (same scale as Date.now(), sub-ms precision). */
export function hostNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Maps a device clock (µs) onto host time (ms). The Paper 1 sync estimators implement this; everything
 * downstream (waveforms, HR detection, cross-device PTT) only sees mapped times.
 *
 * Observations are one-way: "a message stamped deviceUs by the device arrived at hostArrivalMs". The
 * arrival is always later than the true send instant by a positive, variable delay, so estimators work
 * from the least-delayed observations.
 */
export type ObservationInfo = {
  /** Size of the frame that carried the observation (serial serialisation time). */
  bytes?: number;
  /** The device sent this message the moment deviceUs was reached (sample batches, not event messages). */
  sentWhenReady?: boolean;
};

export interface ClockMapper {
  readonly name: string;
  observe(deviceUs: number, hostArrivalMs: number, info?: ObservationInfo): void;
  toHostMs(deviceUs: number): number;
  reset(): void;
  /** Short live state for display, e.g. estimated skew. */
  describe?(): string;
}

/** Baseline 0: offset from the first observation only. Never corrects drift or a slow first message. */
export class FirstOffsetMapper implements ClockMapper {
  readonly name = "first-offset";
  private offsetMs: number | null = null;

  observe(deviceUs: number, hostArrivalMs: number): void {
    this.offsetMs ??= hostArrivalMs - deviceUs / 1000;
  }

  toHostMs(deviceUs: number): number {
    return deviceUs / 1000 + (this.offsetMs ?? 0);
  }

  reset(): void {
    this.offsetMs = null;
  }
}

/**
 * Baseline 1: offset = min(host arrival − device time) over a sliding window of recent messages.
 * The minimum approximates the least-delayed message. No skew model: drift shows up as a sawtooth.
 */
export class WindowedMinOffsetMapper implements ClockMapper {
  readonly name = "windowed-min";
  private offsets: number[] = [];
  private offsetMs: number | null = null;
  private readonly window: number;

  constructor(window = 64) {
    this.window = window;
  }

  observe(deviceUs: number, hostArrivalMs: number): void {
    this.offsets.push(hostArrivalMs - deviceUs / 1000);
    if (this.offsets.length > this.window) this.offsets.shift();
    this.offsetMs = Math.min(...this.offsets);
  }

  toHostMs(deviceUs: number): number {
    return deviceUs / 1000 + (this.offsetMs ?? 0);
  }

  reset(): void {
    this.offsets = [];
    this.offsetMs = null;
  }
}

type Pt = { x: number; y: number };

/** Lower convex hull (Andrew's monotone chain) of points sorted by x. */
export function lowerHull(sorted: Pt[]): Pt[] {
  const hull: Pt[] = [];
  for (const p of sorted) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2];
      const b = hull[hull.length - 1];
      // Pop b if it lies on or above segment a→p.
      if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) <= 0) hull.pop();
      else break;
    }
    hull.push(p);
  }
  return hull;
}

export type LowerHullOptions = {
  /** Device-time span of observations kept, ms. */
  windowMs?: number;
  /** Below this span, fall back to an offset-only estimate (a skew from a short span is mostly noise). */
  minSpanMs?: number;
  /** Refit after this many new observations. */
  refitEvery?: number;
  /** Largest plausible |skew|; crystals are tens of ppm. */
  maxSkewPpm?: number;
  /** Known minimum transport latency of an observation, ms (e.g. UART serialisation time). Subtracted before fitting. */
  latencyFloorMs?: (frameBytes: number) => number;
  /**
   * BLE: notifications leave only at connection events, so a frame sent when ready waited less than one
   * connection interval (CI). That bounds the offset from below as the delay envelope bounds it from above;
   * the estimate moves to the middle of the band. CI is inferred from the arrival-time grid.
   */
  bleConnectionBand?: boolean;
  name?: string;
};

type Obs = Pt & { ready: boolean };

/** BLE connection intervals are multiples of 1.25 ms; candidates 7.5–100 ms. */
const CI_CANDIDATES = Array.from({ length: 75 }, (_, i) => 7.5 + i * 1.25);

/**
 * Infers a BLE connection interval from host arrival times: arrivals cluster on a grid of period CI.
 * Divisors of the true CI also fit (arrivals on a 15 ms grid are on a 7.5 ms grid), so the largest
 * candidate with strong phase concentration wins. Returns null when no grid is evident (e.g. serial).
 */
export function inferConnectionIntervalMs(arrivals: number[], minConcentration = 0.9): number | null {
  if (arrivals.length < 40) return null;
  const a0 = arrivals[0];
  let best: number | null = null;
  for (const ci of CI_CANDIDATES) {
    let c = 0;
    let sn = 0;
    for (const a of arrivals) {
      const ph = (2 * Math.PI * (a - a0)) / ci;
      c += Math.cos(ph);
      sn += Math.sin(ph);
    }
    if (Math.hypot(c, sn) / arrivals.length >= minConcentration) best = ci;
  }
  return best;
}

/**
 * Affine (offset + skew) estimator over the lower envelope of one-way delay observations.
 *
 * Each observation gives y = arrival − device time = true offset(x) + delay ≥ true offset(x). The best
 * line lying under every point is an edge of the points' lower convex hull; following Moon et al.
 * ("Estimation and removal of clock skew from network delay measurements", INFOCOM 1999) we take the
 * hull edge spanning the mean x, which minimises the total vertical distance from points to the line.
 */
export class LowerHullAffineMapper implements ClockMapper {
  readonly name: string;
  private readonly opts: Required<Omit<LowerHullOptions, "name">>;
  private pts: Obs[] = [];
  private arrivals: number[] = [];
  private sinceFit = 0;
  private anchor: Pt | null = null;
  private slope = 0;
  /** BLE band correction subtracted from the envelope line, ms. */
  private bandShift = 0;
  private ciMs: number | null = null;

  constructor(opts: LowerHullOptions = {}) {
    this.name = opts.name ?? "lower-hull";
    this.opts = {
      windowMs: opts.windowMs ?? 120_000,
      minSpanMs: opts.minSpanMs ?? 5_000,
      refitEvery: opts.refitEvery ?? 8,
      maxSkewPpm: opts.maxSkewPpm ?? 500,
      latencyFloorMs: opts.latencyFloorMs ?? (() => 0),
      bleConnectionBand: opts.bleConnectionBand ?? false,
    };
  }

  observe(deviceUs: number, hostArrivalMs: number, info: ObservationInfo = {}): void {
    const x = deviceUs / 1000;
    const p = { x, y: hostArrivalMs - this.opts.latencyFloorMs(info.bytes ?? 0) - x, ready: !!info.sentWhenReady };
    this.pts.push(p);
    if (this.opts.bleConnectionBand) {
      this.arrivals.push(hostArrivalMs);
      if (this.arrivals.length > 300) this.arrivals.shift();
    }
    // Bootstrap: until the first fit, use the least-delayed point seen.
    if (!this.anchor || (this.slope === 0 && p.y < this.anchor.y)) this.anchor = p;
    const cutoff = x - this.opts.windowMs;
    if (this.pts[0].x < cutoff) this.pts = this.pts.filter((q) => q.x >= cutoff);
    if (++this.sinceFit >= this.opts.refitEvery) this.fit();
  }

  private fit(): void {
    this.sinceFit = 0;
    const sorted = [...this.pts].sort((a, b) => a.x - b.x);
    const span = sorted[sorted.length - 1].x - sorted[0].x;
    if (span < this.opts.minSpanMs) {
      this.anchor = sorted.reduce((m, q) => (q.y < m.y ? q : m));
      this.slope = 0;
      return;
    }
    const hull = lowerHull(sorted);
    const meanX = sorted.reduce((s, q) => s + q.x, 0) / sorted.length;
    let i = 0;
    while (i < hull.length - 2 && hull[i + 1].x < meanX) i++;
    const a = hull[i];
    const b = hull[Math.min(i + 1, hull.length - 1)];
    const maxSlope = this.opts.maxSkewPpm * 1e-6;
    const raw = b.x > a.x ? (b.y - a.y) / (b.x - a.x) : 0;
    this.slope = Math.max(-maxSlope, Math.min(maxSlope, raw));
    this.anchor = a;
    if (this.opts.bleConnectionBand) this.fitBand(sorted);
  }

  /**
   * Residual r = y − envelope(x) ≥ 0 is each frame's delay above the least-delayed one. If the envelope
   * sits δ above the true offset, frames sent when ready have total delay r + δ < CI, so δ < CI − max(r).
   * Taking the middle of [0, CI − max r] halves the worst case when frames only ever hit a few phases
   * of the connection-event grid (which happens whenever batch rate and CI are commensurate).
   */
  private fitBand(sorted: Obs[]): void {
    this.ciMs = inferConnectionIntervalMs(this.arrivals);
    this.bandShift = 0;
    if (this.ciMs === null) return;
    const ci = this.ciMs;
    let maxR = -Infinity;
    let n = 0;
    for (const p of sorted) {
      if (!p.ready) continue;
      const r = p.y - (this.anchor!.y + this.slope * (p.x - this.anchor!.x));
      // A frame that missed its first event (radio retry, full queue) breaks the bound; skip it.
      if (r >= ci) continue;
      n++;
      if (r > maxR) maxR = r;
    }
    if (n >= 50) this.bandShift = Math.max(0, (ci - maxR) / 2);
  }

  toHostMs(deviceUs: number): number {
    const x = deviceUs / 1000;
    if (!this.anchor) return x;
    return x + this.anchor.y + this.slope * (x - this.anchor.x) - this.bandShift;
  }

  describe(): string {
    if (!this.anchor) return "waiting for data";
    const parts = [this.slope === 0 ? "offset only (collecting span)" : `skew ${this.skewPpm() >= 0 ? "+" : ""}${this.skewPpm().toFixed(1)} ppm`];
    if (this.opts.bleConnectionBand) parts.push(this.ciMs === null ? "CI unknown" : `CI ${this.ciMs} ms`);
    return parts.join(", ");
  }

  /** Inferred BLE connection interval, if the band model is on and a grid was found. */
  connectionIntervalMs(): number | null {
    return this.ciMs;
  }

  /** Current skew estimate in ppm (device clock relative to host), for display. */
  skewPpm(): number {
    return this.slope * 1e6;
  }

  reset(): void {
    this.pts = [];
    this.arrivals = [];
    this.anchor = null;
    this.slope = 0;
    this.bandShift = 0;
    this.ciMs = null;
    this.sinceFit = 0;
  }
}

/** Minimum time a frame spends on the wire before its last byte can arrive: 8N1 = 10 bits per byte. */
export function serialFloorMs(baudRate: number): (frameBytes: number) => number {
  return (frameBytes) => (frameBytes * 10 * 1000) / baudRate;
}

export type ClockMethodId = "first-offset" | "windowed-min" | "lower-hull" | "lower-hull-transport";

export const CLOCK_METHODS: { id: ClockMethodId; label: string; description: string }[] = [
  { id: "first-offset", label: "First offset", description: "Offset from the first message. Naive baseline." },
  { id: "windowed-min", label: "Windowed min offset", description: "Least-delayed message among the last 64. No skew model." },
  { id: "lower-hull", label: "Affine (lower hull)", description: "Offset + skew fitted under the delay envelope (Moon et al.)." },
  {
    id: "lower-hull-transport",
    label: "Affine + transport model",
    description:
      "As affine, plus transport physics: serial frames minus their UART serialisation time; BLE frames bounded by the inferred connection interval.",
  },
];

export const DEFAULT_CLOCK_METHOD: ClockMethodId = "lower-hull-transport";

export function createClockMapper(method: ClockMethodId, descriptor: Descriptor): ClockMapper {
  switch (method) {
    case "first-offset":
      return new FirstOffsetMapper();
    case "windowed-min":
      return new WindowedMinOffsetMapper();
    case "lower-hull":
      return new LowerHullAffineMapper();
    case "lower-hull-transport":
      return descriptor.transport.kind === "serial"
        ? new LowerHullAffineMapper({ name: "lower-hull-transport", latencyFloorMs: serialFloorMs(descriptor.transport.baudRate) })
        : new LowerHullAffineMapper({ name: "lower-hull-transport", bleConnectionBand: true });
  }
}
