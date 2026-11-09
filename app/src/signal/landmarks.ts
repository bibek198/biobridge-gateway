// Streaming fiducial detectors for pulse transit time: ECG R-peaks and the PPG maximum-upstroke point.
// They work on any time base (device ms or host ms); only differences between timestamps matter.

/** R-peak detector: baseline-removed ECG crossing an adaptive threshold, peak = local maximum. */
export class RPeakDetector {
  private baseline: number | null = null;
  private envelope = 0;
  private lastT: number | null = null;
  private inPeak = false;
  private peakV = -Infinity;
  private peakT = 0;
  private lastPeakT = -Infinity;
  private readonly refractoryMs: number;

  constructor(refractoryMs = 250) {
    this.refractoryMs = refractoryMs;
  }

  /** Returns the time of a confirmed R-peak, or null. */
  push(t: number, v: number): number | null {
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    // ~1 s baseline EMA removes electrode offset and slow wander.
    this.baseline = this.baseline === null ? v : this.baseline + (v - this.baseline) * Math.min(1, dt / 1000);
    const x = v - this.baseline;
    // Envelope decays with a ~3 s time constant so it follows amplitude changes.
    this.envelope = Math.max(x, this.envelope * Math.exp(-dt / 3000));
    const threshold = 0.5 * this.envelope;

    if (x > threshold && this.envelope > 0) {
      if (!this.inPeak || x > this.peakV) {
        this.peakV = x;
        this.peakT = t;
      }
      this.inPeak = true;
      return null;
    }
    if (this.inPeak) {
      this.inPeak = false;
      this.peakV = -Infinity;
      if (this.peakT - this.lastPeakT >= this.refractoryMs) {
        this.lastPeakT = this.peakT;
        return this.peakT;
      }
    }
    return null;
  }
}

/**
 * PPG landmark detector: time of maximum upstroke slope of the blood-volume pulse. Raw MAX30102 counts
 * fall as blood volume rises, so the signal is inverted first. Max slope is a common, noise-robust PTT
 * landmark (more stable than the foot).
 */
export class PpgUpstrokeDetector {
  private window: Array<{ t: number; v: number }> = [];
  private prev: { t: number; s: number } | null = null;
  private envelope = 0;
  private inUpstroke = false;
  private bestSlope = 0;
  private bestT = 0;
  private lastT = -Infinity;
  private readonly refractoryMs: number;

  constructor(refractoryMs = 300) {
    this.refractoryMs = refractoryMs;
  }

  push(t: number, raw: number): number | null {
    // 5-point moving average of the inverted signal, timed at the window centre.
    this.window.push({ t, v: -raw });
    if (this.window.length > 5) this.window.shift();
    if (this.window.length < 5) return null;
    const s = this.window.reduce((acc, p) => acc + p.v, 0) / 5;
    const tc = this.window[2].t;

    const prev = this.prev;
    this.prev = { t: tc, s };
    if (!prev || tc <= prev.t) return null;
    const slope = (s - prev.s) / (tc - prev.t);
    const tm = (tc + prev.t) / 2;

    this.envelope = Math.max(slope, this.envelope * Math.exp(-(tc - prev.t) / 3000));
    if (slope > 0.5 * this.envelope && this.envelope > 0) {
      if (!this.inUpstroke || slope > this.bestSlope) {
        this.bestSlope = slope;
        this.bestT = tm;
      }
      this.inUpstroke = true;
      return null;
    }
    if (this.inUpstroke) {
      this.inUpstroke = false;
      this.bestSlope = 0;
      if (this.bestT - this.lastT >= this.refractoryMs) {
        this.lastT = this.bestT;
        return this.bestT;
      }
    }
    return null;
  }
}
