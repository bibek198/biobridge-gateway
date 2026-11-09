// One simulated subject shared by every simulated device in a session, on the host's true timeline.
// ECG (Node A) and PPG (Node B) sample the same beats, with the PPG pulse arriving pttMs after the
// R-peak, so the simulator has a real pulse transit time for the Paper 1 sync pipeline to recover.

export type SimScenario = "normal" | "tachycardia" | "desaturation";

const SCENARIO_TARGETS: Record<SimScenario, { hr: number; spo2: number; bpSys: number; bpDia: number }> = {
  normal: { hr: 72, spo2: 97, bpSys: 118, bpDia: 78 },
  tachycardia: { hr: 145, spo2: 96, bpSys: 138, bpDia: 88 },
  desaturation: { hr: 80, spo2: 84, bpSys: 118, bpDia: 78 },
};

/** R-peak position within a beat cycle (phase units) of qrsWaveValue(). */
export const R_PEAK_PHASE = 0.18;

function gaussian(x: number, center: number, width: number, height: number): number {
  return height * Math.exp(-((x - center) ** 2) / (2 * width * width));
}

/** Synthetic single-lead ECG (mV) over one beat, phase in [0, 1). */
export function qrsWaveValue(phase: number): number {
  return (
    gaussian(phase, 0.08, 0.02, 0.15) +
    gaussian(phase, 0.16, 0.006, -0.15) +
    gaussian(phase, R_PEAK_PHASE, 0.008, 1.2) +
    gaussian(phase, 0.2, 0.006, -0.3) +
    gaussian(phase, 0.35, 0.04, 0.25)
  );
}

/** Normalised PPG blood-volume pulse (0..~1), x = beat phase since the pulse foot. */
function ppgPulseValue(x: number): number {
  const shape = (u: number) => gaussian(u, 0.13, 0.05, 1) + gaussian(u, 0.38, 0.07, 0.4);
  return shape(x) + shape(x + 1) + shape(x - 1);
}

export type Vitals = { hr: number; spo2: number; bpSys: number; bpDia: number };

export class PhysiologyModel {
  readonly pttMs: number;
  private scenario: SimScenario = "normal";
  private beats: number[] = []; // beat start times, host ms
  private hr = SCENARIO_TARGETS.normal.hr;
  private vitals: Vitals = { ...SCENARIO_TARGETS.normal };
  private vitalsAt: number | null = null;

  constructor(pttMs = 220) {
    this.pttMs = pttMs;
  }

  getScenario(): SimScenario {
    return this.scenario;
  }

  setScenario(scenario: SimScenario): void {
    this.scenario = scenario;
  }

  /** ECG in mV at host time t, including a little measurement noise. */
  ecgMv(t: number): number {
    return qrsWaveValue(this.phaseAt(t)) + (Math.random() - 0.5) * 0.02;
  }

  /** Normalised PPG pulse at the fingertip at host time t (pulse foot = R-peak + PTT). */
  ppgPulse(t: number): number {
    const x = this.phaseAt(t - this.pttMs) - R_PEAK_PHASE;
    return ppgPulseValue(x < 0 ? x + 1 : x);
  }

  vitalsAtTime(t: number): Vitals {
    if (this.vitalsAt === null) this.vitalsAt = t;
    const target = SCENARIO_TARGETS[this.scenario];
    while (this.vitalsAt + 1000 <= t) {
      this.vitalsAt += 1000;
      const v = this.vitals;
      v.spo2 = Math.min(100, Math.max(70, v.spo2 + (target.spo2 - v.spo2) * 0.15 + (Math.random() - 0.5) * 0.4));
      v.bpSys += (target.bpSys - v.bpSys) * 0.1 + (Math.random() - 0.5) * 1.5;
      v.bpDia += (target.bpDia - v.bpDia) * 0.1 + (Math.random() - 0.5) * 1;
    }
    return { ...this.vitals, hr: this.hr };
  }

  private phaseAt(t: number): number {
    this.ensureBeatsThrough(t);
    for (let i = this.beats.length - 2; i >= 0; i--) {
      if (this.beats[i] <= t) return (t - this.beats[i]) / (this.beats[i + 1] - this.beats[i]);
    }
    return 0; // earlier than the retained history
  }

  private ensureBeatsThrough(t: number): void {
    if (this.beats.length === 0) this.beats.push(t - 2000);
    const target = SCENARIO_TARGETS[this.scenario];
    while (this.beats[this.beats.length - 1] <= t) {
      this.hr += (target.hr - this.hr) * 0.08 + (Math.random() - 0.5) * 1.2;
      this.beats.push(this.beats[this.beats.length - 1] + 60000 / Math.max(this.hr, 30));
    }
    // Keep ~15 s of history: devices query slightly in the past (PTT, batching).
    while (this.beats.length > 3 && this.beats[1] < t - 15000) this.beats.shift();
  }
}
