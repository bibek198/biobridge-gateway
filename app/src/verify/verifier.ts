import type { DecoderStats } from "../descriptors/compile";
import type { Descriptor } from "../descriptors/types";

// The Paper 2 verifier: does a descriptor decode this device correctly? Three oracles, none of which needs
// to know the right answer in advance:
//   structural    — frames parse: CRC, malformed messages, sequence continuity
//   plausibility  — values are physically possible: declared ranges, rate of change, a live (non-flat)
//                   signal, and a measured sample rate matching what the device announces
//   cross-sensor  — independent sensors agree on the same physiology (e.g. ECG heart rate vs PPG pulse rate)
// The same code runs live in the app and offline on recordings (to score candidate descriptors).

export type CheckStatus = "pass" | "warn" | "fail" | "pending";
export type Oracle = "structural" | "plausibility" | "cross-sensor";
export type CheckResult = { id: string; oracle: Oracle; name: string; status: CheckStatus; detail: string };
export type Verdict = "verified" | "suspect" | "failed" | "pending";
export type VerificationReport = { verdict: Verdict; checks: CheckResult[] };

export type VerifiableSample = { channel: string; value: number; timestamp: number; deviceTimestampUs?: number };

const MIN_SAMPLES = 50;

/** pass at or below passRate, warn at or below warnRate, fail above. */
function grade(badFraction: number, passRate = 0.01, warnRate = 0.05): CheckStatus {
  return badFraction <= passRate ? "pass" : badFraction <= warnRate ? "warn" : "fail";
}

const pct = (x: number) => `${(100 * x).toFixed(x < 0.01 ? 2 : 1)}%`;

class ChannelStats {
  n = 0;
  min = Infinity;
  max = -Infinity;
  outOfRange = 0;
  rateChecked = 0;
  rateViolations = 0;
  distinct = new Set<number>();
  sum = 0;
  sumSq = 0;
  firstDevUs: number | null = null;
  lastDevUs: number | null = null;
  devCount = 0;
  /** Gaps between consecutive device timestamps (first few thousand), for the spacing check. */
  intervalsUs: number[] = [];
  private prev: { v: number; t: number } | null = null;

  add(s: VerifiableSample, bounds?: { min?: number; max?: number; maxRatePerSec?: number }): void {
    this.n++;
    this.min = Math.min(this.min, s.value);
    this.max = Math.max(this.max, s.value);
    this.sum += s.value;
    this.sumSq += s.value * s.value;
    if (this.distinct.size < 16) this.distinct.add(s.value);
    if (bounds && ((bounds.min !== undefined && s.value < bounds.min) || (bounds.max !== undefined && s.value > bounds.max))) {
      this.outOfRange++;
    }
    const t = s.deviceTimestampUs !== undefined ? s.deviceTimestampUs / 1000 : s.timestamp;
    if (bounds?.maxRatePerSec !== undefined && this.prev && t > this.prev.t) {
      this.rateChecked++;
      if (Math.abs(s.value - this.prev.v) / ((t - this.prev.t) / 1000) > bounds.maxRatePerSec) this.rateViolations++;
    }
    this.prev = { v: s.value, t };
    if (s.deviceTimestampUs !== undefined) {
      if (this.lastDevUs !== null && this.intervalsUs.length < 5000) this.intervalsUs.push(s.deviceTimestampUs - this.lastDevUs);
      this.firstDevUs ??= s.deviceTimestampUs;
      this.lastDevUs = s.deviceTimestampUs;
      this.devCount++;
    }
  }

  sd(): number {
    const mean = this.sum / this.n;
    return Math.sqrt(Math.max(0, this.sumSq / this.n - mean * mean));
  }

  /**
   * Fraction of sample intervals more than 25% away from the median interval. A sampled signal is evenly
   * spaced; a wrong period or count makes samples bunch up inside each frame and jump between frames,
   * even when the average rate comes out right. Occasional gaps (a lost frame) stay under the threshold.
   */
  irregularSpacing(): { fraction: number; medianUs: number } | null {
    if (this.intervalsUs.length < MIN_SAMPLES) return null;
    const sorted = [...this.intervalsUs].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    if (med <= 0) return { fraction: 1, medianUs: med };
    const off = this.intervalsUs.filter((d) => Math.abs(d - med) > 0.25 * med).length;
    return { fraction: off / this.intervalsUs.length, medianUs: med };
  }

  /** Samples per second from device timestamps, if the device timestamps its samples. */
  measuredRateHz(): number | null {
    if (this.devCount < MIN_SAMPLES || this.firstDevUs === null || this.lastDevUs === null) return null;
    const spanS = (this.lastDevUs - this.firstDevUs) / 1e6;
    return spanS > 0 ? (this.devCount - 1) / spanS : null;
  }
}

/** Verifies one device's decoded stream against its descriptor. Feed samples, then ask for a report. */
export class StreamVerifier {
  private readonly descriptor: Descriptor;
  private channels = new Map<string, ChannelStats>();
  private info: Record<string, number | string> = {};

  constructor(descriptor: Descriptor) {
    this.descriptor = descriptor;
  }

  observe(s: VerifiableSample): void {
    let c = this.channels.get(s.channel);
    if (!c) {
      c = new ChannelStats();
      this.channels.set(s.channel, c);
    }
    c.add(s, this.descriptor.plausibility?.[s.channel]);
  }

  setInfo(info: Record<string, number | string>): void {
    this.info = info;
  }

  report(stats: DecoderStats): VerificationReport {
    const checks: CheckResult[] = [...this.structural(stats), ...this.plausibility()];
    return { verdict: verdictOf(checks), checks };
  }

  private structural(st: DecoderStats): CheckResult[] {
    const checks: CheckResult[] = [];
    const binary = this.descriptor.framing.kind !== "delimited";
    if (st.bytesIn === 0) {
      return [{ id: "frames", oracle: "structural", name: "Frames decode", status: "pending", detail: "no bytes yet" }];
    }
    // Nothing decoding after a couple of KiB means the framing or message matching is wrong.
    const decodeStatus: CheckStatus = st.framesOk > 0 ? "pass" : st.bytesIn > 2048 ? "fail" : "pending";
    checks.push({
      id: "frames",
      oracle: "structural",
      name: "Frames decode",
      status: decodeStatus,
      detail: `${st.framesOk} ${binary ? "frames" : "lines"} from ${st.bytesIn} bytes`,
    });
    if (this.descriptor.framing.kind === "magic-length-crc") {
      const total = st.framesOk + st.crcErrors;
      checks.push({
        id: "crc",
        oracle: "structural",
        name: "Checksums",
        status: total === 0 ? "pending" : grade(st.crcErrors / total),
        detail: `${st.crcErrors} CRC failures`,
      });
    }
    const parsed = st.framesOk + st.malformed;
    checks.push({
      id: "malformed",
      oracle: "structural",
      name: "Messages match the descriptor",
      status: parsed === 0 ? "pending" : grade(st.malformed / parsed),
      detail: `${st.malformed} of ${parsed} unmatched or too short`,
    });
    if (this.descriptor.messages?.some((m) => m.seq)) {
      checks.push({
        id: "sequence",
        oracle: "structural",
        name: "Sequence continuity",
        status: st.framesOk < 20 ? "pending" : grade(st.seqGaps / (st.framesOk + st.seqGaps)),
        detail: `${st.seqGaps} frames missing`,
      });
    }
    return checks;
  }

  private plausibility(): CheckResult[] {
    const checks: CheckResult[] = [];
    const specs = new Map(this.descriptor.channels.map((c) => [c.id, c]));
    for (const [ch, c] of this.channels) {
      const spec = specs.get(ch);
      if (spec?.display === "hidden") continue;
      const bounds = this.descriptor.plausibility?.[ch];
      const enough = c.n >= (spec?.display === "waveform" ? MIN_SAMPLES : 5);
      const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toPrecision(3));

      if (bounds && (bounds.min !== undefined || bounds.max !== undefined)) {
        checks.push({
          id: `range:${ch}`,
          oracle: "plausibility",
          name: `${ch} within physical range`,
          status: enough ? grade(c.outOfRange / c.n) : "pending",
          detail: `observed ${fmt(c.min)} … ${fmt(c.max)}; allowed ${bounds.min ?? "−∞"} … ${bounds.max ?? "∞"}; ${pct(c.outOfRange / c.n)} outside`,
        });
      }
      if (bounds?.maxRatePerSec !== undefined) {
        checks.push({
          id: `rate:${ch}`,
          oracle: "plausibility",
          name: `${ch} changes plausibly fast`,
          status: c.rateChecked >= 5 ? grade(c.rateViolations / c.rateChecked) : "pending",
          detail: `${c.rateViolations} of ${c.rateChecked} steps faster than ${bounds.maxRatePerSec}/s`,
        });
      }
      if (spec?.display === "waveform") {
        // A mis-placed field often reads padding or a constant header byte: a flat or near-binary "signal".
        const flat = c.distinct.size < 3 || c.sd() === 0;
        checks.push({
          id: `alive:${ch}`,
          oracle: "plausibility",
          name: `${ch} is a live signal`,
          status: enough ? (flat ? "fail" : "pass") : "pending",
          detail: flat ? `only ${c.distinct.size} distinct value(s)` : `sd ${fmt(c.sd())}`,
        });
        const spacing = c.irregularSpacing();
        if (spacing) {
          checks.push({
            id: `spacing:${ch}`,
            oracle: "plausibility",
            name: `${ch} samples evenly spaced`,
            status: grade(spacing.fraction, 0.02, 0.05),
            detail: `median interval ${(spacing.medianUs / 1000).toFixed(2)} ms; ${pct(spacing.fraction)} of intervals off by >25%`,
          });
        }
        const declared = typeof this.info.sampleRateHz === "number" ? this.info.sampleRateHz : null;
        const measured = c.measuredRateHz();
        if (declared !== null && measured !== null) {
          const err = Math.abs(measured - declared) / declared;
          checks.push({
            id: `samplerate:${ch}`,
            oracle: "plausibility",
            name: `${ch} sample rate matches the device`,
            status: grade(err, 0.05, 0.15),
            detail: `measured ${measured.toFixed(1)} Hz from device timestamps; device announces ${declared} Hz`,
          });
        }
      }
    }
    return checks;
  }
}

export function verdictOf(checks: CheckResult[]): Verdict {
  if (checks.some((c) => c.status === "fail")) return "failed";
  if (checks.some((c) => c.status === "warn")) return "suspect";
  if (checks.length === 0 || checks.every((c) => c.status === "pending")) return "pending";
  return "verified";
}

// ---- cross-sensor oracle ------------------------------------------------------------------------------

/** One source's heart-rate estimate, e.g. ECG-derived HR on Node A or PPG pulse rate on Node B. */
export type RateEstimate = { source: string; kind: string; bpm: number };

const RATE_KINDS: Record<string, string> = {
  heartRate: "device-reported HR",
  heartRate_computed: "ECG R-peak HR",
  pulseRate_ppg: "PPG pulse rate",
};

/** Channels that carry heart/pulse rate, and what kind of estimate each is. */
export function rateKind(channel: string): string | null {
  return RATE_KINDS[channel] ?? null;
}

/**
 * Compares heart-rate estimates that come from physically different measurements. A descriptor that
 * mis-scales time or swaps channels usually breaks this agreement even when every value looks plausible.
 */
export function crossSensorChecks(estimates: RateEstimate[], tolBpm = 5, tolFrac = 0.08): CheckResult[] {
  const checks: CheckResult[] = [];
  for (let i = 0; i < estimates.length; i++) {
    for (let j = i + 1; j < estimates.length; j++) {
      const a = estimates[i];
      const b = estimates[j];
      if (a.source === b.source && a.kind === b.kind) continue;
      const diff = Math.abs(a.bpm - b.bpm);
      const tol = Math.max(tolBpm, tolFrac * (a.bpm + b.bpm) / 2);
      checks.push({
        id: `agree:${a.source}/${a.kind}|${b.source}/${b.kind}`,
        oracle: "cross-sensor",
        name: `${a.kind} (${a.source}) vs ${b.kind} (${b.source})`,
        status: diff <= tol ? "pass" : diff <= 2 * tol ? "warn" : "fail",
        detail: `${a.bpm.toFixed(0)} vs ${b.bpm.toFixed(0)} bpm (Δ ${diff.toFixed(1)}, tolerance ${tol.toFixed(1)})`,
      });
    }
  }
  return checks;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
