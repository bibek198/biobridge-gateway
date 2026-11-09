import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { compileDescriptor } from "../src/descriptors/compile";
import { seedMathRandom } from "./helpers/seededRandom";
import { FAKE_TIMERS, simRecording } from "./helpers/simRecording";

// Data for Paper 1 figures that the sync evaluator does not already export:
//   PAPER1_DATA_OUT=../eval/results/paper1 npx vitest run test/paperData.test.ts
// writes delays.csv: one row per timed frame, with its true one-way delay (arrival − true send time).
// The figure shows Node B's fixed-cadence sample frames landing on a few delay values (aliasing against
// BLE connection events) while randomly timed probes spread over the whole interval.

const out = process.env.PAPER1_DATA_OUT;

describe.runIf(!!out)("paper 1 data", () => {
  beforeEach(() => vi.useFakeTimers(FAKE_TIMERS));
  afterEach(() => vi.useRealTimers());

  it("exports true one-way delays per frame kind", { timeout: 600_000 }, async () => {
    const restore = seedMathRandom(1);
    const rec = await simRecording(5 * 60_000);
    restore();
    const rows = ["device,kind,t_s,delay_ms"];
    for (const c of rec.meta.connections) {
      const g = c.groundTruth!;
      const truth = (us: number) => g.bootHostMs + us / 1000 / (1 + g.driftPpm * 1e-6);
      const dec = compileDescriptor(c.descriptor);
      const t0 = rec.chunks[0].t;
      for (const ch of rec.chunks.filter((x) => x.c === c.key)) {
        for (const m of dec.push(ch.bytes).timedMessages ?? []) {
          // 13-byte frames are timing probes; other send-time frames are sample batches; the rest are events.
          const kind = m.bytes === 13 ? "probe" : m.sentWhenReady ? "samples" : "event";
          rows.push(`${c.label.startsWith("Node A") ? "A" : "B"},${kind},${((ch.t - t0) / 1000).toFixed(3)},${(ch.t - truth(m.deviceUs)).toFixed(4)}`);
        }
      }
    }
    mkdirSync(resolve(out!), { recursive: true });
    writeFileSync(resolve(out!, "delays.csv"), rows.join("\n") + "\n");
  });
});
