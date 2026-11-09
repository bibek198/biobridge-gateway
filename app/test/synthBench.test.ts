import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BENCH_DEVICES, type BenchDevice } from "../src/bench/devices";
import { ALL_ORACLES, extractJson, synthesize, type OracleSet, type SynthResult } from "../src/synth/loop";
import { captureExcerpt, SYSTEM_PROMPT, taskPrompt } from "../src/synth/prompt";
import { AnthropicProvider, PRICING, ScriptedProvider, SYNTH_MODELS, type SynthModel } from "../src/synth/providers";
import { benchCapture, type BenchCapture } from "./helpers/benchCapture";
import { FAKE_TIMERS } from "./helpers/simRecording";

// Paper 2 runner. Without SYNTH_LIVE it checks the loop's mechanics with a scripted model (no API calls).
//   SYNTH_LIVE=1 npm run eval:synth                                  Opus 5.5 on every device
//   SYNTH_LIVE=1 SYNTH_MODELS=claude-opus-5-5,claude-haiku-5-5 SYNTH_DEVICES=fingertip-oximeter,wrist-imu npm run eval:synth
//   SYNTH_ORACLES=structural            only that oracle's findings are fed back (ablation); "none" = validator only
//   SYNTH_OUT=../eval/results/synth-x   where transcripts and reports go (default eval/results/synth-<timestamp>)
//   SYNTH_ITERATIONS=4 SYNTH_SEED=11 SYNTH_EFFORT=high
// The API key comes from the environment, or from the repo-root .env (gitignored; see .env.example).

const env = process.env;
const fence = (o: unknown) => "```json\n" + JSON.stringify(o, null, 2) + "\n```";
const device = (id: string) => BENCH_DEVICES.find((d) => d.id === id)!;

describe("synthesis loop mechanics (scripted model)", () => {
  const ox = device("fingertip-oximeter");
  let cap: BenchCapture;

  beforeAll(async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    cap = await benchCapture(ox, 20_000, 3);
    vi.useRealTimers();
  });
  afterAll(() => vi.useRealTimers());

  it("feeds verifier findings back and accepts the repaired descriptor", async () => {
    const wrong = structuredClone(ox.groundTruth) as any;
    wrong.messages[0].fields[1].offset = 3; // spo2 read from the pleth byte (swings 10-90)
    wrong.messages[0].fields[3].scale = 1; // perfusion in 0.1 % units, not scaled
    wrong.messages[0].fields[3].offset = 3; // ...and read from the pleth byte too
    let feedbackSeen = "";
    const provider = new ScriptedProvider([
      "Here is my first attempt.\n" + fence(wrong),
      (msgs) => {
        feedbackSeen = String(msgs[msgs.length - 1].content);
        return "Fixed.\n" + fence(ox.groundTruth);
      },
    ]);
    const r = await synthesize(ox, cap, provider);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["rejected", "accepted"]);
    expect(feedbackSeen).toMatch(/perfusion within physical range/);
    expect(feedbackSeen).toMatch(/spo2: \d+ values/);
    expect(r.accepted).toBe(true);
    expect(r.score.success).toBe(true);
    expect(r.score.fieldAccuracy).toBe(1);
  });

  it("known blind spot: SpO2 read from the pulse-rate byte stays plausible and is accepted", async () => {
    const swapped = structuredClone(ox.groundTruth) as any;
    swapped.messages[0].fields[1].offset = 5; // "SpO2" ≈ 72 %: physically possible, no SpO2 reference to compare
    const r = await synthesize(ox, cap, new ScriptedProvider([fence(swapped)]));
    expect(r.accepted).toBe(true);
    expect(r.score.success).toBe(false);
  });

  it("asks again when a reply has no JSON or invalid JSON, and reports validation errors", async () => {
    const invalid = { ...structuredClone(ox.groundTruth), framing: { kind: "magic-fixed", magic: [0xaa, 0x55] } };
    const provider = new ScriptedProvider(["I think it is an oximeter.", "```json\n{ not json\n```", fence(invalid), fence(ox.groundTruth)]);
    const r = await synthesize(ox, cap, provider);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["no-json", "no-json", "invalid", "accepted"]);
    expect(r.attempts[2].validationErrors!.join("\n")).toMatch(/\$\.framing\.frameLength/);
  });

  it("stops at the iteration budget and scores the last valid descriptor", async () => {
    const wrong = structuredClone(ox.groundTruth) as any;
    wrong.messages[0].fields[2].offset = 4; // heartRate from the SpO2 byte: plausible range, wrong data
    const r = await synthesize(ox, cap, new ScriptedProvider([fence(wrong)]), { maxIterations: 2 });
    expect(r.attempts).toHaveLength(2);
    expect(r.accepted).toBe(false); // cross-sensor oracle: ~97 "bpm" vs the reference ECG's ~72
    expect(r.score.success).toBe(false);
    expect(r.score.channels.find((c) => c.channel === "heartRate")!.fraction).toBeLessThan(0.1);
  });

  it("with every oracle off, accepts the first valid descriptor that has the channels (ablation baseline)", async () => {
    const wrong = structuredClone(ox.groundTruth) as any;
    wrong.messages[0].fields[2].offset = 4;
    const none: OracleSet = { structural: false, plausibility: false, "cross-sensor": false };
    const r = await synthesize(ox, cap, new ScriptedProvider([fence(wrong)]), { oracles: none });
    expect(r.attempts.map((a) => a.outcome)).toEqual(["accepted"]);
    expect(r.score.success).toBe(false);
  });

  it("extracts the last JSON block", () => {
    expect(extractJson('```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```')).toEqual({ ok: true, value: { a: 2 } });
  });

  it("never puts the ground truth in the prompt", () => {
    for (const d of BENCH_DEVICES) {
      const p = SYSTEM_PROMPT + taskPrompt(d, []);
      expect(p).not.toContain(JSON.stringify(d.groundTruth.messages ?? d.groundTruth.text));
    }
  });

  it("shows binary serial captures as hex, text as text, BLE as notifications", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(captureExcerpt([{ t: 0, c: "dev", bytes: Uint8Array.of(0xaa, 0x55, 1) }], "serial")).toMatch(/as hex[\s\S]*aa 55 01/);
    expect(captureExcerpt([{ t: 0, c: "dev", bytes: bytes("ecg,1\r\n") }], "serial")).toMatch(/as text[\s\S]*ecg,1\\r/);
    expect(captureExcerpt([{ t: 0, c: "dev", bytes: Uint8Array.of(0x16, 72) }], "ble")).toMatch(/#00 .*16 48/);
  });
});

// ---- live benchmark --------------------------------------------------------------------------------

function parseOracles(s: string | undefined): OracleSet {
  if (!s) return ALL_ORACLES;
  const on = new Set(s.split(",").map((x) => x.trim()));
  return { structural: on.has("structural"), plausibility: on.has("plausibility"), "cross-sensor": on.has("cross-sensor") };
}

function reportLine(r: SynthResult): string {
  const cost = r.costUsd === null ? "n/a" : `$${r.costUsd.toFixed(3)}`;
  return `${r.model.padEnd(18)} ${r.deviceId.padEnd(20)} ${r.accepted ? "accepted" : "NOT acc."} ${r.score.success ? "CORRECT" : "wrong  "} acc ${(r.score.fieldAccuracy * 100).toFixed(1).padStart(5)}%  iters ${r.attempts.length}  in ${r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens}  out ${r.usage.outputTokens}  ${cost}  ${(r.wallMs / 1000).toFixed(0)} s${r.error ? `  ERROR ${r.error}` : ""}`;
}

describe.runIf(env.SYNTH_LIVE === "1")("live descriptor synthesis", () => {
  const models = (env.SYNTH_MODELS?.split(",") ?? ["claude-opus-5-5"]) as SynthModel[];
  const devices: BenchDevice[] = env.SYNTH_DEVICES ? env.SYNTH_DEVICES.split(",").map(device) : BENCH_DEVICES;
  const oracles = env.SYNTH_ORACLES === "none" ? parseOracles("") : parseOracles(env.SYNTH_ORACLES);
  const maxIterations = Number(env.SYNTH_ITERATIONS ?? 4);
  const seed = Number(env.SYNTH_SEED ?? 11);
  const effort = (env.SYNTH_EFFORT ?? "high") as "low" | "medium" | "high" | "xhigh" | "max";
  const outDir = resolve(env.SYNTH_OUT ?? `../eval/results/synth-${new Date().toISOString().replace(/[:.]/g, "-")}`);

  it("runs", { timeout: 4 * 3_600_000 }, async () => {
    const dotenv = new URL("../../.env", import.meta.url);
    if (!env.ANTHROPIC_API_KEY && existsSync(dotenv)) process.loadEnvFile(dotenv);
    for (const m of models) expect(SYNTH_MODELS, `unknown model ${m}`).toContain(m);
    // Upper bound: every iteration used, ~12k input and ~8k output tokens each.
    const bound = models.reduce((s, m) => s + devices.length * maxIterations * (12_000 * PRICING[m].input + 8_000 * PRICING[m].output) / 1e6, 0);
    console.log(`Live run: ${models.join(", ")} × ${devices.length} devices, ≤${maxIterations} iterations, effort ${effort}. Worst-case cost ≈ $${bound.toFixed(2)}.`);

    vi.useFakeTimers(FAKE_TIMERS);
    const captures = new Map<string, BenchCapture>();
    for (const d of devices) captures.set(d.id, await benchCapture(d, 30_000, seed));
    vi.useRealTimers();

    mkdirSync(outDir, { recursive: true });
    const results: SynthResult[] = [];
    for (const m of models) {
      const provider = new AnthropicProvider(m, effort);
      for (const d of devices) {
        const r = await synthesize(d, captures.get(d.id)!, provider, { maxIterations, oracles });
        results.push(r);
        console.log(reportLine(r));
        mkdirSync(resolve(outDir, m), { recursive: true });
        writeFileSync(resolve(outDir, m, `${d.id}.json`), JSON.stringify(r, null, 2) + "\n");
      }
    }

    const lines = [`seed ${seed}, oracles ${JSON.stringify(oracles)}, effort ${effort}, max ${maxIterations} iterations`, ...results.map(reportLine)];
    for (const m of models) {
      const mine = results.filter((r) => r.model === m);
      const correct = mine.filter((r) => r.score.success).length;
      const cost = mine.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      lines.push(`${m}: ${correct}/${mine.length} correct, mean field accuracy ${((mine.reduce((s, r) => s + r.score.fieldAccuracy, 0) / mine.length) * 100).toFixed(1)}%, total $${cost.toFixed(2)}`);
    }
    writeFileSync(resolve(outDir, "report.txt"), lines.join("\n") + "\n");
    console.log(lines.slice(-models.length).join("\n"));
    console.log(`wrote ${outDir}`);
  });
});
