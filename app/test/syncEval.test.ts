import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRecording, serializeRecording } from "../src/session/recording";
import { evaluateSync, formatReport, seriesToCsv, TRUTH, type SyncEvalReport } from "../src/sync/evaluate";
import { CLOCK_METHODS } from "../src/time/clock";
import { seedMathRandom } from "./helpers/seededRandom";
import { FAKE_TIMERS, simRecording } from "./helpers/simRecording";

// Paper 1 evaluation runner. As a plain test it is a quick, seeded regression check.
//   SYNC_EVAL_MINUTES=30 SYNC_EVAL_SEEDS=10 npm run eval:sync      longer / more simulated runs
//   SYNC_EVAL_OUT=../eval/results/sim npm run eval:sync            write reports, series CSVs, recordings
//   SYNC_EVAL_FILE=path/to/recording.bbrec.jsonl npm run eval:sync evaluate a real (hardware) recording

const methods = CLOCK_METHODS.map((m) => m.id);
const env = process.env;
const outDir = env.SYNC_EVAL_OUT ? resolve(env.SYNC_EVAL_OUT) : null;

function write(dir: string, report: SyncEvalReport, rec?: Parameters<typeof serializeRecording>) {
  mkdirSync(dir, { recursive: true });
  const { series, ...summary } = report;
  writeFileSync(resolve(dir, "report.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(resolve(dir, "report.txt"), formatReport(report) + "\n");
  writeFileSync(resolve(dir, "series.csv"), seriesToCsv(series));
  if (rec) writeFileSync(resolve(dir, "recording.bbrec.jsonl"), serializeRecording(...rec));
}

const byMethod = (r: SyncEvalReport, m: string) => r.methods.find((x) => x.method === m)!;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

describe.runIf(!env.SYNC_EVAL_FILE)("clock sync on the simulator", () => {
  beforeEach(() => vi.useFakeTimers(FAKE_TIMERS));
  afterEach(() => vi.useRealTimers());

  it(
    "affine + transport model beats the baselines; timing probes help (mean over seeds, probes on vs off)",
    { timeout: 3_600_000 },
    async () => {
      const minutes = Number(env.SYNC_EVAL_MINUTES ?? 3);
      const seeds = Number(env.SYNC_EVAL_SEEDS ?? 5);
      // results[probes][metric][method] = per-seed RMSEs; the same seeds are used with probes on and off.
      const results = { on: { pulse: new Map<string, number[]>(), ptt: new Map<string, number[]>() }, off: { pulse: new Map<string, number[]>(), ptt: new Map<string, number[]>() } };
      const push = (m: Map<string, number[]>, k: string, v: number) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);

      for (const probes of [true, false]) {
        const r = results[probes ? "on" : "off"];
        for (let seed = 1; seed <= seeds; seed++) {
          const restore = seedMathRandom(seed);
          const rec = await simRecording(minutes * 60_000, { probes });
          restore();
          const report = evaluateSync(rec, methods);
          if (outDir) write(resolve(outDir, `seed-${seed}-probes-${probes ? "on" : "off"}`), report, [rec.meta, rec.chunks]);

          const truthPulse = byMethod(report, TRUTH).pulsePairs[0].stats;
          expect(truthPulse.n).toBeGreaterThan(minutes * 60 * 2 * 0.7); // ~2 edges/s
          expect(truthPulse.maxAbsMs).toBeLessThan(0.05); // truth recovers the rig's simultaneity (ISR µs)
          for (const m of methods) {
            push(r.pulse, m, byMethod(report, m).pulsePairs[0].stats.rmseMs);
            push(r.ptt, m, byMethod(report, m).ptt!.errorVsTruth!.rmseMs);
          }
        }
      }

      const f = (xs: number[]) => mean(xs).toFixed(2).padStart(10);
      const lines = [
        `${seeds} seeds × ${minutes} min simulated; mean RMSE over seeds (ms). Same seeds with timing probes on and off.`,
        `${"method".padEnd(24)}${"pulse:on".padStart(10)}${"pulse:off".padStart(10)}${"PTT:on".padStart(10)}${"PTT:off".padStart(10)}`,
      ];
      for (const m of methods) {
        lines.push(`${m.padEnd(24)}${f(results.on.pulse.get(m)!)}${f(results.off.pulse.get(m)!)}${f(results.on.ptt.get(m)!)}${f(results.off.ptt.get(m)!)}`);
      }
      const summary = lines.join("\n");
      console.log(summary);
      if (outDir) writeFileSync(resolve(outDir, "summary.txt"), summary + "\n");

      const best = "lower-hull-transport";
      for (const m of methods.filter((x) => x !== best)) {
        expect(mean(results.on.pulse.get(best)!), `pulse-pair RMSE vs ${m}`).toBeLessThan(mean(results.on.pulse.get(m)!));
        expect(mean(results.on.ptt.get(best)!), `PTT RMSE vs ${m}`).toBeLessThan(mean(results.on.ptt.get(m)!));
      }
      expect(mean(results.on.pulse.get(best)!), "probes help the transport-aware method").toBeLessThan(mean(results.off.pulse.get(best)!));
    }
  );
});

describe.runIf(!!env.SYNC_EVAL_FILE)("clock sync on a recording file", () => {
  it("evaluates", () => {
    const rec = parseRecording(readFileSync(resolve(env.SYNC_EVAL_FILE!), "utf8"));
    const report = evaluateSync(rec, methods);
    console.log(formatReport(report));
    if (outDir) write(outDir, report);
    expect(report.methods.length).toBeGreaterThan(0);
  });
});
