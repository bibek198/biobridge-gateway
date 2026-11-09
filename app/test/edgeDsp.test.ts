import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DspEventKind, EdgeDsp, type DspEvent } from "../src/dsp/edgeDsp";
import { PhysiologyModel, R_PEAK_PHASE } from "../src/sim/physiology";
import { seedMathRandom } from "./helpers/seededRandom";

// The firmware DSP library, compiled to Wasm, checked against the simulated subject's known truth.

let dsp: EdgeDsp;
let restore: () => void;
beforeAll(async () => {
  dsp = await EdgeDsp.fromBytes(readFileSync(new URL("../src/dsp/bbdsp.wasm", import.meta.url)));
});
beforeEach(() => (restore = seedMathRandom(5)));
afterEach(() => restore());

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const of = (evs: DspEvent[], kind: number) => evs.filter((e) => e.kind === kind);

/** Runs the ECG detector over the model at fs for durationS; returns events and the model's beat times. */
function runEcg(model: PhysiologyModel, fs: number, durationS: number, noiseMv = 0) {
  const ecg = dsp.ecg(fs);
  const events: DspEvent[] = [];
  const t0 = 1_000_000;
  for (let i = 0; i < durationS * fs; i++) {
    const tMs = t0 + (i * 1000) / fs;
    const mv = model.ecgMv(tMs) + 0.3 * Math.sin((2 * Math.PI * tMs) / 3000) + (Math.random() - 0.5) * 2 * noiseMv; // + baseline wander
    events.push(...ecg.push(mv, Math.round(tMs * 1000)));
  }
  ecg.free();
  return events;
}

/** PPG like Node B produces it: red/IR intensities falling with blood volume. */
function runPpg(model: PhysiologyModel, fs: number, durationS: number, motion = 0) {
  const ppg = dsp.ppg(fs);
  const events: DspEvent[] = [];
  for (let i = 0; i < durationS * fs; i++) {
    const tMs = 1_000_000 + (i * 1000) / fs;
    const { spo2 } = model.vitalsAtTime(tMs);
    const pulse = model.ppgPulse(tMs);
    const r = (110 - spo2) / 25;
    const art = motion * (Math.sin((2 * Math.PI * tMs) / 700) + (Math.random() - 0.5)); // motion artefact
    const ir = 120_000 * (1 - 0.02 * pulse + art * 0.02);
    const red = 90_000 * (1 - r * 0.02 * pulse + art * 0.02);
    events.push(...ppg.push(red, ir, Math.round(tMs * 1000)));
  }
  ppg.free();
  return events;
}

describe("ECG (Pan-Tompkins) in Wasm", () => {
  it.each([250, 500])("finds every beat and the right heart rate at %i Hz despite baseline wander and noise", (fs) => {
    const model = new PhysiologyModel();
    const ev = runEcg(model, fs, 60, 0.03);
    const peaks = of(ev, DspEventKind.R_PEAK);
    const hr = of(ev, DspEventKind.HEART_RATE);
    // ~72 bpm for 60 s, minus the 2 s learning phase.
    expect(peaks.length).toBeGreaterThanOrEqual(65);
    expect(peaks.length).toBeLessThanOrEqual(74);
    expect(median(hr.map((e) => e.value))).toBeCloseTo(72, -0.5); // within ±2.5 bpm
  });

  it("places R-peaks on the R apex (the sampled maximum of the beat)", () => {
    const model = new PhysiologyModel();
    const fs = 250;
    const ecg = dsp.ecg(fs);
    const samples: Array<{ tUs: number; mv: number }> = [];
    const peaks: DspEvent[] = [];
    for (let i = 0; i < 30 * fs; i++) {
      const tUs = Math.round((1_000_000 + (i * 1000) / fs) * 1000);
      const mv = model.ecgMv(tUs / 1000);
      samples.push({ tUs, mv });
      peaks.push(...of(ecg.push(mv, tUs), DspEventKind.R_PEAK));
    }
    ecg.free();
    expect(peaks.length).toBeGreaterThan(30);
    for (const p of peaks) {
      const i = samples.findIndex((s) => s.tUs === p.tUs);
      const window = samples.slice(Math.max(0, i - 10), i + 11).map((s) => s.mv); // ±40 ms
      expect(samples[i].mv).toBe(Math.max(...window));
    }
    expect(R_PEAK_PHASE).toBeGreaterThan(0);
  });

  it("follows a change of heart rate (tachycardia)", () => {
    const model = new PhysiologyModel();
    model.setScenario("tachycardia");
    const hr = of(runEcg(model, 250, 90), DspEventKind.HEART_RATE).map((e) => e.value);
    expect(median(hr.slice(-20))).toBeGreaterThan(135);
  });
});

describe("PPG in Wasm", () => {
  it("pulse rate, SpO2 and high signal quality on a clean signal", () => {
    const model = new PhysiologyModel();
    const ev = runPpg(model, 100, 60);
    expect(median(of(ev, DspEventKind.PULSE_RATE).map((e) => e.value))).toBeCloseTo(72, -0.5);
    expect(median(of(ev, DspEventKind.SPO2).map((e) => e.value))).toBeCloseTo(97, -0.5);
    expect(median(of(ev, DspEventKind.SQI).map((e) => e.value))).toBeGreaterThan(0.9);
  });

  it("tracks a desaturation", () => {
    const model = new PhysiologyModel();
    model.setScenario("desaturation");
    const spo2 = of(runPpg(model, 100, 90), DspEventKind.SPO2).map((e) => e.value);
    expect(median(spo2.slice(-15))).toBeLessThan(88);
  });

  it("signal quality drops under motion artefact", () => {
    const clean = median(of(runPpg(new PhysiologyModel(), 100, 60), DspEventKind.SQI).map((e) => e.value));
    const moving = median(of(runPpg(new PhysiologyModel(), 100, 60, 0.8), DspEventKind.SQI).map((e) => e.value));
    expect(moving).toBeLessThan(clean - 0.2);
  });
});
