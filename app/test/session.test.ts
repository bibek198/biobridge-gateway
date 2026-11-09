import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESCRIPTORS } from "../src/descriptors/library";
import { DescriptorDriver } from "../src/drivers/descriptorDriver";
import type { DeviceReading } from "../src/drivers/types";
import { FrameType, frame, nodeASamplesPayload } from "../src/protocol/nodes";
import { parseRecording, serializeRecording, type RecordingMeta } from "../src/session/recording";
import { ReplayTransport } from "../src/transports/replayTransport";
import { SimulatedNodeATransport, SimulatedNodeBTransport } from "../src/transports/simulatedTransports";
import { simEnv } from "./helpers/simRecording";

// Fake timers also drive performance.now(), so hostNowMs() advances with the clock.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance", "Date"] }));
afterEach(() => vi.useRealTimers());

function collect(driver: DescriptorDriver): DeviceReading[] {
  const out: DeviceReading[] = [];
  driver.onData((r) => out.push(r));
  return out;
}

describe("simulated nodes through their descriptors", () => {
  it("Node A: ~250 Hz ECG, HELLO info, boot log skipped, no CRC errors or gaps", async () => {
    const driver = new DescriptorDriver(DESCRIPTORS.nodeA, new SimulatedNodeATransport(simEnv()));
    const readings = collect(driver);
    await driver.connect();
    await vi.advanceTimersByTimeAsync(2000);
    await driver.disconnect();

    const ecg = readings.filter((r) => r.channel === "ecg");
    expect(ecg.length).toBeGreaterThan(450); // 2 s at 250 Hz minus the in-flight batch
    expect(driver.getInfo()).toMatchObject({ nodeKind: 1, sampleRateHz: 250 });
    expect(driver.getStats()).toMatchObject({ crcErrors: 0, seqGaps: 0, malformed: 0 });
    expect(driver.getStats().bytesDiscarded).toBeGreaterThan(0); // the boot log
    const dts = ecg.slice(1).map((r, i) => r.deviceTimestampUs! - ecg[i].deviceTimestampUs!);
    expect(new Set(dts)).toEqual(new Set([4000]));
    // Mapped time follows device spacing, not arrival batching.
    expect(ecg[20].timestamp - ecg[19].timestamp).toBeCloseTo(4, 0);
  });

  it("Node B: red and IR at ~100 Hz, PPG pulsatile", async () => {
    const driver = new DescriptorDriver(DESCRIPTORS.nodeB, new SimulatedNodeBTransport(simEnv()));
    const readings = collect(driver);
    await driver.connect();
    await vi.advanceTimersByTimeAsync(3000);
    await driver.disconnect();

    const ir = readings.filter((r) => r.channel === "ppg_ir").map((r) => r.value);
    expect(readings.filter((r) => r.channel === "ppg_red").length).toBe(ir.length);
    expect(ir.length).toBeGreaterThan(280);
    expect(Math.max(...ir) - Math.min(...ir)).toBeGreaterThan(1000); // ~2% perfusion of ~120k counts
    expect(driver.getStats()).toMatchObject({ crcErrors: 0, seqGaps: 0, malformed: 0 });
  });
});

describe("recordings", () => {
  const meta: RecordingMeta = {
    id: "rec-1",
    name: "test",
    startedAt: 1000,
    endedAt: 1100,
    connections: [
      { key: "c1", factoryId: "node-a", label: "Node A", transportKind: "webserial", descriptor: DESCRIPTORS.nodeA, joinedAt: 1000 },
    ],
    chunkCount: 2,
    byteCount: 0,
  };
  const f0 = frame(FrameType.SAMPLES, 0, 0, nodeASamplesPayload(4000, [1650, 1750]));
  const f1 = frame(FrameType.SAMPLES, 1, 8000, nodeASamplesPayload(4000, [1550]));

  it("round-trips through the .bbrec.jsonl format byte-exactly", () => {
    const chunks = [
      { t: 1010, c: "c1", bytes: f0 },
      { t: 1050, c: "c1", bytes: f1 },
    ];
    const parsed = parseRecording(serializeRecording(meta, chunks));
    expect(parsed.meta).toEqual(meta);
    expect(parsed.chunks).toEqual(chunks);
  });

  it("rejects files with unknown connections or invalid descriptors", () => {
    const text = serializeRecording(meta, [{ t: 1, c: "c9", bytes: f0 }]);
    expect(() => parseRecording(text)).toThrow(/unknown connection "c9"/);
    const bad = { ...meta, connections: [{ ...meta.connections[0], descriptor: { schema: "nope" } as never }] };
    expect(() => parseRecording(serializeRecording(bad, []))).toThrow(/invalid descriptor/);
  });

  it("replays recorded bytes with their original spacing and decodes them again", async () => {
    const transport = new ReplayTransport([{ t: 1010, bytes: f0 }, { t: 1050, bytes: f1 }], 1000, "Node A");
    const driver = new DescriptorDriver(DESCRIPTORS.nodeA, transport);
    const readings = collect(driver);
    await driver.connect();

    await vi.advanceTimersByTimeAsync(20);
    expect(readings.map((r) => r.value)).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(40);
    expect(readings.map((r) => r.value)).toEqual([0, 1, -1]);
    expect(driver.getStatus()).toBe("disconnected"); // replay finished cleanly, not an error
    expect(readings[2].hostTimestamp! - readings[0].hostTimestamp!).toBeCloseTo(40, 5);
  });
});
