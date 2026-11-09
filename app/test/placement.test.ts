import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WasmEcgModule, WasmPpgModule } from "../src/compute/modules/edgeDsp";
import { DESCRIPTORS } from "../src/descriptors/library";
import { EdgeDsp } from "../src/dsp/edgeDsp";
import { DescriptorDriver } from "../src/drivers/descriptorDriver";
import type { DeviceReading } from "../src/drivers/types";
import { estimatePower } from "../src/placement/energy";
import { ComputeMode, configFrame, parseConfigFrame } from "../src/protocol/nodes";
import { SimulatedNodeATransport, SimulatedNodeBTransport } from "../src/transports/simulatedTransports";
import { seedMathRandom } from "./helpers/seededRandom";
import { FAKE_TIMERS, simEnv } from "./helpers/simRecording";

// Compute placement end to end on the simulated nodes: CONFIG commands switch where the firmware DSP runs;
// the node then sends DERIVED results and/or samples, and STATS report what the link carried.

let dsp: EdgeDsp;
let restore: () => void;
beforeAll(async () => {
  dsp = await EdgeDsp.fromBytes(readFileSync(new URL("../src/dsp/bbdsp.wasm", import.meta.url)));
});
beforeEach(() => {
  restore = seedMathRandom(21);
  vi.useFakeTimers(FAKE_TIMERS);
});
afterEach(() => {
  vi.useRealTimers();
  restore();
});

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

async function run(node: "A" | "B", mode: number | null, seconds: number) {
  const env = { ...simEnv(), dsp };
  const transport = node === "A" ? new SimulatedNodeATransport(env) : new SimulatedNodeBTransport(env);
  const driver = new DescriptorDriver(node === "A" ? DESCRIPTORS.nodeA : DESCRIPTORS.nodeB, transport);
  const readings: DeviceReading[] = [];
  driver.onData((r) => readings.push(r));
  await driver.connect();
  if (mode !== null) await driver.sendCommand(["mode-raw", "mode-edge", "mode-gated", "mode-both"][mode]);
  await vi.advanceTimersByTimeAsync(seconds * 1000);
  await driver.disconnect();
  const values = (ch: string) => readings.filter((r) => r.channel === ch).map((r) => r.value);
  return { readings, values, info: driver.getInfo(), stats: driver.getStats() };
}

describe("CONFIG frames", () => {
  it("round-trip through the parser the simulated firmware uses", () => {
    for (const m of Object.values(ComputeMode)) expect(parseConfigFrame(configFrame(m))).toBe(m);
    expect(parseConfigFrame(Uint8Array.of(1, 2, 3))).toBeNull();
  });
});

describe("Node A (ECG)", () => {
  it("raw by default: samples, no device results", async () => {
    const r = await run("A", null, 12);
    expect(r.values("ecg").length).toBeGreaterThan(2500);
    expect(r.values("heartRate_edge")).toEqual([]);
    expect(r.info.mode).toBe(ComputeMode.RAW);
  });

  it("edge: heart rate computed on the node, no samples, a fraction of the traffic", async () => {
    const raw = await run("A", null, 22);
    const edge = await run("A", ComputeMode.EDGE, 22);
    expect(edge.values("ecg")).toEqual([]);
    expect(median(edge.values("heartRate_edge"))).toBeCloseTo(72, -0.5);
    expect(edge.info.mode).toBe(ComputeMode.EDGE);
    expect(edge.info.txBytes as number).toBeLessThan((raw.info.txBytes as number) * 0.2);
  });

  it("both: the device's heart rate matches the browser's (same C code, same samples)", async () => {
    const r = await run("A", ComputeMode.BOTH, 30);
    const browser = new WasmEcgModule(() => dsp);
    const wasm = r.readings.filter((x) => x.channel === "ecg").flatMap((x) => browser.process(x).derivedReadings ?? []);
    const device = r.values("heartRate_edge");
    expect(device.length).toBeGreaterThan(15);
    expect(median(wasm.map((x) => x.value))).toBeCloseTo(median(device), 0);
  });
});

describe("Node B (PPG)", () => {
  it("edge: pulse rate, SpO2 and signal quality computed on the node", async () => {
    const r = await run("B", ComputeMode.EDGE, 30);
    expect(r.values("ppg_ir")).toEqual([]);
    expect(median(r.values("pulseRate_edge"))).toBeCloseTo(72, -0.5);
    expect(median(r.values("spo2_edge"))).toBeCloseTo(97, -0.5);
    expect(median(r.values("sqi_edge"))).toBeGreaterThan(0.9);
  });

  it("gated: with a clean signal, samples stop once quality is established", async () => {
    const r = await run("B", ComputeMode.GATED, 30);
    const irTimes = r.readings.filter((x) => x.channel === "ppg_ir").map((x) => x.timestamp);
    const firstSqi = r.readings.find((x) => x.channel === "sqi_edge")!.timestamp;
    expect(irTimes.length).toBeGreaterThan(0); // raw while quality is still unknown
    expect(Math.max(...irTimes)).toBeLessThan(firstSqi + 1000);
  });

  it("browser modules reproduce the node's results from raw samples", async () => {
    const r = await run("B", ComputeMode.BOTH, 30);
    const browser = new WasmPpgModule(() => dsp);
    const wasm = r.readings.filter((x) => x.channel === "ppg_red" || x.channel === "ppg_ir").flatMap((x) => browser.process(x).derivedReadings ?? []);
    const of = (ch: string) => wasm.filter((x) => x.channel === ch).map((x) => x.value);
    expect(median(of("pulseRate_wasm"))).toBeCloseTo(median(r.values("pulseRate_edge")), 0);
    expect(median(of("spo2_wasm"))).toBeCloseTo(median(r.values("spo2_edge")), 0);
  });

  it("modelled node power: edge mode needs much less radio than raw", async () => {
    const raw = await run("B", null, 12);
    const edge = await run("B", ComputeMode.EDGE, 12);
    const p = (x: typeof raw) =>
      estimatePower({
        transport: "ble",
        linkBytesPerS: ((x.info.txBytes as number) / (x.info.statsPeriodMs as number)) * 1000,
        dspUsPerS: ((x.info.dspUs as number) / (x.info.statsPeriodMs as number)) * 1000,
      });
    expect(p(edge).radioMw!).toBeLessThan(p(raw).radioMw! * 0.2);
  });
});
