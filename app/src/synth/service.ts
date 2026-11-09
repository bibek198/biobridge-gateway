import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { DESCRIPTORS } from "../descriptors/library";
import type { Descriptor } from "../descriptors/types";
import { base64ToBytes, type RecordedChunk, type RecordingConnection } from "../session/recording";
import type { CheckResult } from "../verify/verifier";
import { synthesize, type Attempt } from "./loop";
import type { SynthTask } from "./prompt";
import { createProvider, listGeminiModels, SYNTH_MODELS, type LlmProvider } from "./providers";

// Descriptor synthesis as a local service for the app's "Add a device" tab. Runs in Node inside the Vite
// dev server (vite-plugin-synth.ts), so API keys stay in this process and never reach the browser.

// Keys from the repo-root .env, without overriding the environment.
const dotenv = new URL("../../../.env", import.meta.url);
if (existsSync(dotenv)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(dotenv, "utf8")))) if (!process.env[k] && v) process.env[k] = v;
}

export type WireChunk = { t: number; b64: string };

export type SynthRequest = {
  task: SynthTask;
  model: string;
  chunks: WireChunk[];
  /** Optional independent device in the same capture (e.g. Node A ECG), for the cross-sensor oracle. */
  reference?: { descriptor: Descriptor; label: string; chunks: WireChunk[] };
  maxIterations?: number;
};

export type AttemptView = {
  iteration: number;
  outcome: Attempt["outcome"];
  replyText: string;
  validationErrors: string[];
  findings: Pick<CheckResult, "id" | "oracle" | "name" | "status" | "detail">[];
  missingChannels: string[];
  latencyMs: number;
  retries: number;
};

export type JobView = {
  id: string;
  model: string;
  status: "running" | "done" | "error";
  startedAt: number;
  attempts: AttemptView[];
  accepted: boolean;
  descriptor: Descriptor | null;
  error: string | null;
};

const jobs = new Map<string, JobView>();

const view = (a: Attempt): AttemptView => ({
  iteration: a.iteration,
  outcome: a.outcome,
  replyText: a.replyText,
  validationErrors: a.validationErrors ?? [],
  findings: (a.findings ?? []).map(({ id, oracle, name, status, detail }) => ({ id, oracle, name, status, detail })),
  missingChannels: a.missingChannels ?? [],
  latencyMs: a.latencyMs,
  retries: a.retries,
});

const toChunks = (wire: WireChunk[], key: string): RecordedChunk[] => wire.map((c) => ({ t: c.t, c: key, bytes: base64ToBytes(c.b64) }));

let geminiCache: { at: number; ids: string[] } | null = null;

/** Models usable with the keys this process has: Claude ids, and gemini:<id> for text models. */
export async function availableModels(): Promise<{ id: string; label: string }[]> {
  const out: { id: string; label: string }[] = [];
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    for (const m of SYNTH_MODELS) out.push({ id: m, label: `Claude: ${m}` });
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    if (!geminiCache || Date.now() - geminiCache.at > 10 * 60_000) {
      const ids = (await listGeminiModels()).filter((id) => id.startsWith("gemini-") && !/tts|image|transcribe|live|embedding/.test(id));
      geminiCache = { at: Date.now(), ids };
    }
    for (const id of geminiCache.ids) out.push({ id: `gemini:${id}`, label: `Gemini: ${id}` });
  }
  return out;
}

/** Validates the request and starts a job; returns its id immediately. makeProvider is replaceable for tests. */
export function startJob(req: SynthRequest, makeProvider: (model: string) => LlmProvider = (m) => createProvider(m)): string {
  if (!req?.task?.id || !req.task.datasheet || !req.task.transport || !Array.isArray(req.task.requiredChannels)) {
    throw new Error("task needs id, datasheet, transport and requiredChannels");
  }
  if (!Array.isArray(req.chunks) || req.chunks.length === 0) throw new Error("capture is empty");
  const provider = makeProvider(req.model); // throws on an unknown model
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const job: JobView = { id, model: req.model, status: "running", startedAt: Date.now(), attempts: [], accepted: false, descriptor: null, error: null };
  jobs.set(id, job);

  const t0 = req.chunks[0].t;
  // The loop overrides the device's descriptor with each candidate; the recording needs some valid one.
  const connections: RecordingConnection[] = [
    { key: "dev", factoryId: "unknown", label: req.task.id, transportKind: req.task.transport.kind, descriptor: DESCRIPTORS.genericSerialCsv, joinedAt: t0 },
  ];
  const chunks = toChunks(req.chunks, "dev");
  if (req.reference) {
    connections.push({ key: "ref", factoryId: "reference", label: req.reference.label, transportKind: "serial", descriptor: req.reference.descriptor, joinedAt: t0 });
    chunks.push(...toChunks(req.reference.chunks, "ref"));
  }
  const capture = {
    meta: { id, name: req.task.id, startedAt: t0, endedAt: null, connections, chunkCount: chunks.length, byteCount: 0 },
    chunks,
  };

  synthesize(req.task, capture, provider, {
    maxIterations: Math.min(6, Math.max(1, req.maxIterations ?? 4)),
    onAttempt: (a) => job.attempts.push(view(a)),
  })
    .then((r) => {
      job.accepted = r.accepted;
      job.descriptor = r.final;
      job.error = r.error ?? null;
      job.status = r.error && !r.final ? "error" : "done";
    })
    .catch((err) => {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
    });
  return id;
}

export function getJob(id: string): JobView | null {
  return jobs.get(id) ?? null;
}
