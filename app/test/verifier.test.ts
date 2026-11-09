import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DESCRIPTORS } from "../src/descriptors/library";
import type { Descriptor } from "../src/descriptors/types";
import type { RecordedChunk, RecordingMeta } from "../src/session/recording";
import { verifyRecording } from "../src/verify/verifyRecording";
import { crossSensorChecks, StreamVerifier } from "../src/verify/verifier";
import { seedMathRandom } from "./helpers/seededRandom";
import { FAKE_TIMERS, simRecording } from "./helpers/simRecording";

// Oracle mini-benchmark: one simulated capture of Node A (c1) + Node B (c2), re-decoded with deliberately
// broken descriptors of the kinds an LLM (or a person) gets wrong. Each case records which oracles must
// catch it. The swapped-channel case documents a known blind spot.

let rec: { meta: RecordingMeta; chunks: RecordedChunk[] };

beforeAll(async () => {
  const restore = seedMathRandom(7);
  vi.useFakeTimers(FAKE_TIMERS);
  rec = await simRecording(60_000);
  vi.useRealTimers();
  restore();
});
afterAll(() => vi.useRealTimers());

type Mutable = Record<string, any>;
const mutate = (d: Descriptor, f: (m: Mutable) => void): Descriptor => {
  const copy = structuredClone(d) as unknown as Mutable;
  f(copy);
  return copy as unknown as Descriptor;
};
const samplesField = (m: Mutable, i = 0) => m.messages.find((x: Mutable) => x.name === "samples").fields[i];

describe("verifier on correct descriptors", () => {
  it("verifies both nodes and finds ECG and PPG rates in agreement", () => {
    const v = verifyRecording(rec);
    for (const c of v.connections) {
      expect(c.report.checks.filter((x) => x.status !== "pass"), c.label).toEqual([]);
    }
    expect(v.verdicts).toEqual({ c1: "verified", c2: "verified" });
    expect(v.crossSensor).toHaveLength(1);
    expect(v.crossSensor[0].status).toBe("pass");
  });
});

type Case = {
  name: string;
  conn: "c1" | "c2";
  descriptor: Descriptor;
  /** Check ids (prefix match) that must fail; empty = expected to slip through. */
  caughtBy: string[];
};

const cases: Case[] = [
  {
    name: "ECG endianness wrong (i16be)",
    conn: "c1",
    descriptor: mutate(DESCRIPTORS.nodeA, (m) => (samplesField(m).type = "i16be")),
    caughtBy: ["range:ecg"],
  },
  {
    name: "ECG scale wrong (raw mV, no ×0.01)",
    conn: "c1",
    descriptor: mutate(DESCRIPTORS.nodeA, (m) => {
      samplesField(m).scale = 1;
      samplesField(m).bias = 0;
    }),
    caughtBy: ["range:ecg"],
  },
  {
    name: "ECG sample period hard-coded to 2000 µs",
    conn: "c1",
    descriptor: mutate(DESCRIPTORS.nodeA, (m) => (samplesField(m).periodUs = 2000)),
    caughtBy: ["spacing:ecg"],
  },
  {
    name: "ECG sample count hard-coded to 8 (frames carry 10)",
    conn: "c1",
    descriptor: mutate(DESCRIPTORS.nodeA, (m) => (samplesField(m).count = 8)),
    caughtBy: ["samplerate:ecg"],
  },
  {
    name: "PPG field misaligned by one byte",
    conn: "c2",
    descriptor: mutate(DESCRIPTORS.nodeB, (m) => (samplesField(m, 1).offset = 18)),
    caughtBy: ["range:ppg_ir"],
  },
  {
    name: "CRC byte order wrong",
    conn: "c2",
    descriptor: mutate(DESCRIPTORS.nodeB, (m) => (m.framing.crc.endian = "be")),
    caughtBy: ["crc"], // a few frames still pass when the swapped CRC happens to equal the real one (1 in 256)
  },
  {
    name: "Samples message matched on the wrong type byte",
    conn: "c1",
    descriptor: mutate(DESCRIPTORS.nodeA, (m) => (m.messages.find((x: Mutable) => x.name === "samples").match[0].equals = 6)),
    caughtBy: ["malformed"],
  },
  {
    name: "Red and IR swapped (known blind spot)",
    conn: "c2",
    descriptor: mutate(DESCRIPTORS.nodeB, (m) => {
      samplesField(m, 0).offset = 17;
      samplesField(m, 1).offset = 14;
    }),
    caughtBy: [],
  },
];

describe("verifier catches broken descriptors", () => {
  it.each(cases)("$name", ({ conn, descriptor, caughtBy }) => {
    const v = verifyRecording(rec, { [conn]: descriptor });
    const failed = [
      ...v.connections.find((c) => c.key === conn)!.report.checks,
      ...v.crossSensor,
    ].filter((c) => c.status === "fail").map((c) => c.id);
    if (caughtBy.length === 0) {
      expect(v.verdicts[conn]).toBe("verified");
      return;
    }
    expect(v.verdicts[conn]).toBe("failed");
    for (const id of caughtBy) expect(failed.some((f) => f.startsWith(id)), `${id} in ${failed.join(", ")}`).toBe(true);
  });
});

describe("StreamVerifier basics", () => {
  it("stays pending until there is enough data", () => {
    const v = new StreamVerifier(DESCRIPTORS.nodeA);
    expect(v.report({ bytesIn: 0, framesOk: 0, crcErrors: 0, bytesDiscarded: 0, malformed: 0, seqGaps: 0 }).verdict).toBe("pending");
  });

  it("flags bytes arriving with nothing decoding", () => {
    const v = new StreamVerifier(DESCRIPTORS.nodeA);
    const r = v.report({ bytesIn: 5000, framesOk: 0, crcErrors: 0, bytesDiscarded: 5000, malformed: 0, seqGaps: 0 });
    expect(r.verdict).toBe("failed");
  });

  it("cross-sensor tolerance scales with rate", () => {
    const [ok] = crossSensorChecks([
      { source: "A", kind: "ECG R-peak HR", bpm: 150 },
      { source: "B", kind: "PPG pulse rate", bpm: 160 },
    ]);
    expect(ok.status).toBe("pass"); // 8% of 155 = 12.4 bpm
    const [bad] = crossSensorChecks([
      { source: "A", kind: "ECG R-peak HR", bpm: 72 },
      { source: "B", kind: "PPG pulse rate", bpm: 144 },
    ]);
    expect(bad.status).toBe("fail");
  });
});
