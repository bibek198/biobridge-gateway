import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inferConnectionIntervalMs, LowerHullAffineMapper, lowerHull, serialFloorMs } from "../src/time/clock";
import { PulsePairTracker } from "../src/sync/pulsePairs";
import { summarize } from "../src/sync/stats";
import { seedMathRandom } from "./helpers/seededRandom";

let restore: () => void;
beforeEach(() => (restore = seedMathRandom(42)));
afterEach(() => restore());

describe("lowerHull", () => {
  it("keeps only the lower envelope", () => {
    const pts = [
      { x: 0, y: 5 },
      { x: 1, y: 1 },
      { x: 2, y: 4 },
      { x: 3, y: 2 },
      { x: 4, y: 6 },
    ];
    expect(lowerHull(pts)).toEqual([
      { x: 0, y: 5 },
      { x: 1, y: 1 },
      { x: 3, y: 2 },
      { x: 4, y: 6 },
    ]);
  });
});

describe("LowerHullAffineMapper", () => {
  it("recovers offset and skew from one-way observations with random positive delay", () => {
    const offsetMs = 1_700_000_000_000;
    const skew = 37e-6; // host runs 37 ppm faster than the device clock
    const trueHost = (deviceUs: number) => offsetMs + (deviceUs / 1000) * (1 + skew);
    const m = new LowerHullAffineMapper();
    for (let i = 0; i < 4000; i++) {
      const deviceUs = i * 25_000; // 40 messages/s for 100 s
      const delay = 0.2 + -Math.log(1 - Math.random()) * 3; // exponential queueing delay
      m.observe(deviceUs, trueHost(deviceUs) + delay);
    }
    const probe = 100_000_000;
    expect(Math.abs(m.toHostMs(probe) - trueHost(probe))).toBeLessThan(0.3); // the 0.2 ms floor plus fit noise
    expect(m.skewPpm()).toBeCloseTo(37, 0);
  });

  it("subtracts a known transport floor before fitting", () => {
    const floor = serialFloorMs(115200);
    expect(floor(36)).toBeCloseTo(3.125, 3); // 36 bytes × 10 bits at 115200 baud
    const m = new LowerHullAffineMapper({ latencyFloorMs: floor });
    for (let i = 0; i < 400; i++) m.observe(i * 40_000, 5000 + i * 40 + floor(36) + Math.random() * 0.01, { bytes: 36 });
    expect(m.toHostMs(0)).toBeCloseTo(5000, 1);
  });
});

describe("inferConnectionIntervalMs", () => {
  it("finds a 15 ms BLE event grid despite host jitter, preferring it over its divisors", () => {
    const arrivals: number[] = [];
    let event = 0;
    for (let i = 0; i < 200; i++) {
      event += 1 + Math.floor(Math.random() * 4); // skip 0-3 events between notifications
      arrivals.push(1_000_000 + event * 15 + 0.3 + Math.random() * 0.7);
    }
    expect(inferConnectionIntervalMs(arrivals)).toBe(15);
  });

  it("returns null for irregular arrivals with no event grid", () => {
    let t = 0;
    const arrivals = Array.from({ length: 200 }, () => (t += 5 + Math.random() * 40));
    expect(inferConnectionIntervalMs(arrivals)).toBeNull();
  });
});

describe("PulsePairTracker", () => {
  it("pairs the same edge across devices, signs a − b, and ignores other groups", () => {
    const t = new PulsePairTracker();
    t.add("c1", 1, 1000.0);
    t.add("c2", 1, 1001.5); // same rising edge, 1.5 ms later on c2
    t.add("c2", 0, 1050.2);
    t.add("c1", 0, 1050.0); // falling edge, c1 first this time
    t.add("r1", 1, 1000.0, "replay"); // a replay must not pair with live devices
    const [s] = t.getSeries();
    expect(t.getSeries()).toHaveLength(1);
    expect(s.a).toBe("c1");
    expect(s.points.map((p) => p.errMs)).toEqual([expect.closeTo(-1.5, 9), expect.closeTo(-0.2, 9)]);
  });

  it("does not pair edges further apart than the pairing window", () => {
    const t = new PulsePairTracker(250);
    t.add("c1", 1, 0);
    t.add("c2", 1, 400);
    expect(t.getSeries()).toEqual([]);
  });
});

describe("summarize", () => {
  it("computes bias, RMSE and spread", () => {
    const s = summarize([1, -1, 3, -3]);
    expect(s).toMatchObject({ n: 4, meanMs: 0, maxAbsMs: 3 });
    expect(s.rmseMs).toBeCloseTo(Math.sqrt(5), 9);
  });
});
