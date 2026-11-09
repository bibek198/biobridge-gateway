import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BENCH_DEVICES } from "../src/bench/devices";
import { VOCABULARY, withPlatformChannelSemantics } from "../src/bench/vocabulary";
import { compileDescriptor } from "../src/descriptors/compile";
import { verifyRecording } from "../src/verify/verifyRecording";
import { benchCapture, type BenchCapture } from "./helpers/benchCapture";
import { FAKE_TIMERS } from "./helpers/simRecording";

// Ground-truth sanity for the Paper 2 benchmark: every device's generator and its ground-truth descriptor
// were written independently from the datasheet, so they must agree, and the verifier must accept them.

const captures = new Map<string, BenchCapture>();

beforeAll(async () => {
  vi.useFakeTimers(FAKE_TIMERS);
  for (const d of BENCH_DEVICES) captures.set(d.id, await benchCapture(d, 30_000, 11));
  vi.useRealTimers();
}, 120_000);
afterAll(() => vi.useRealTimers());

describe.each(BENCH_DEVICES)("benchmark device $id", (device) => {
  it("uses only vocabulary channels for its required channels", () => {
    for (const ch of device.requiredChannels) expect(VOCABULARY[ch], ch).toBeDefined();
  });

  it("ground truth decodes the generator's intended values", () => {
    const cap = captures.get(device.id)!;
    const decoded = new Map<string, number[]>();
    const dec = compileDescriptor(device.groundTruth);
    for (const c of cap.chunks.filter((x) => x.c === "dev")) {
      for (const s of dec.push(c.bytes).samples) (decoded.get(s.channel) ?? decoded.set(s.channel, []).get(s.channel)!).push(s.value);
    }
    for (const ch of device.requiredChannels) {
      const got = decoded.get(ch) ?? [];
      expect(got.length, `${ch} decoded`).toBeGreaterThan(0);
      if (!cap.intended) continue;
      const want = cap.intended.get(ch)!;
      // The last frame may still be in flight when the capture stops (one frame, or 10% at high rates).
      expect(got.length, `${ch} count`).toBeGreaterThanOrEqual(want.length - Math.max(1, Math.ceil(0.1 * want.length)));
      got.forEach((v, i) => expect(v, `${ch}[${i}]`).toBeCloseTo(want[i], 6));
    }
    expect(dec.stats.crcErrors, "no checksum failures on a clean link").toBe(0);
  });

  it("ground truth passes the verifier (with platform channel semantics)", () => {
    const cap = captures.get(device.id)!;
    const v = verifyRecording(cap, { dev: withPlatformChannelSemantics(device.groundTruth) });
    const dev = v.connections.find((c) => c.key === "dev")!;
    expect(dev.report.checks.filter((c) => c.status === "fail" || c.status === "warn")).toEqual([]);
    expect(v.crossSensor.filter((c) => c.status !== "pass")).toEqual([]);
    expect(v.verdicts.dev).toBe("verified");
  });
});
