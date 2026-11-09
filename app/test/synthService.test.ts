import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BENCH_DEVICES, benchTarget } from "../src/bench/devices";
import { DESCRIPTORS } from "../src/descriptors/library";
import { bytesToBase64 } from "../src/session/recording";
import { ScriptedProvider } from "../src/synth/providers";
import { getJob, startJob, type JobView, type SynthRequest } from "../src/synth/service";
import { benchCapture, type BenchCapture } from "./helpers/benchCapture";
import { FAKE_TIMERS } from "./helpers/simRecording";

// The local synthesis service behind the app's "Add a device" tab, with a scripted model (no API calls).

const ox = BENCH_DEVICES.find((d) => d.id === "fingertip-oximeter")!;
let cap: BenchCapture;

beforeAll(async () => {
  vi.useFakeTimers(FAKE_TIMERS);
  cap = await benchCapture(ox, 15_000, 4);
  vi.useRealTimers();
});
afterAll(() => vi.useRealTimers());

const wire = (key: string) => cap.chunks.filter((c) => c.c === key).map((c) => ({ t: c.t, b64: bytesToBase64(c.bytes) }));
const fence = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```";

async function finished(id: string): Promise<JobView> {
  for (let i = 0; i < 200; i++) {
    const j = getJob(id)!;
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job did not finish");
}

describe("synthesis service", () => {
  const { groundTruth: _hidden, ...task } = benchTarget(ox); // the app never has a ground truth
  const makeRequest = (): SynthRequest => ({
    task,
    model: "scripted",
    chunks: wire("dev"),
    reference: { descriptor: DESCRIPTORS.nodeA, label: "Reference ECG", chunks: wire("ref") },
  });

  it("runs the loop on a capture sent as base64 chunks and reports attempts as they happen", async () => {
    const wrong = structuredClone(ox.groundTruth) as any;
    wrong.messages[0].fields[1].offset = 5; // SpO2 from the pulse byte: the semantic oracle rejects it
    const id = startJob(makeRequest(), () => new ScriptedProvider([fence(wrong), fence(ox.groundTruth)]));
    const job = await finished(id);
    expect(job.status).toBe("done");
    expect(job.accepted).toBe(true);
    expect(job.attempts.map((a) => a.outcome)).toEqual(["rejected", "accepted"]);
    expect(job.attempts[0].findings.map((f) => f.id)).toContain("semantic:distinct-fields");
    expect(job.descriptor).toEqual(ox.groundTruth);
  });

  it("rejects malformed requests and unknown models before starting", () => {
    const request = makeRequest();
    expect(() => startJob({ ...request, chunks: [] })).toThrow(/capture is empty/);
    expect(() => startJob({ ...request, task: { ...task, datasheet: "" } })).toThrow(/datasheet/);
    expect(() => startJob({ ...request, model: "not-a-model" })).toThrow(/Unknown model/);
  });
});
