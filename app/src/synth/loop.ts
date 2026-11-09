import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { BenchDevice } from "../bench/devices";
import { withPlatformChannelSemantics } from "../bench/vocabulary";
import { compileDescriptor } from "../descriptors/compile";
import type { Descriptor } from "../descriptors/types";
import { validateDescriptor } from "../descriptors/validate";
import type { RecordedChunk, RecordingMeta } from "../session/recording";
import type { CheckResult, Oracle } from "../verify/verifier";
import { verifyRecording } from "../verify/verifyRecording";
import { costUsd, type LlmProvider, type Usage } from "./providers";
import { SYSTEM_PROMPT, taskPrompt } from "./prompt";
import { scoreDescriptor, type SynthScore } from "./score";

// The Paper 2 loop: the model proposes a descriptor; the validator and the verifier (structural,
// plausibility and cross-sensor oracles) run it against the capture; their findings go back to the model;
// repeat until the verifier accepts or the iteration budget runs out. Ground-truth scoring happens once,
// at the end, and is never part of the feedback.

export type OracleSet = Record<Oracle, boolean>;
export const ALL_ORACLES: OracleSet = { structural: true, plausibility: true, "cross-sensor": true };

export type SynthOptions = { maxIterations?: number; oracles?: OracleSet };

export type Attempt = {
  iteration: number;
  replyText: string;
  stopReason: string | null;
  outcome: "no-json" | "invalid" | "rejected" | "accepted";
  validationErrors?: string[];
  /** Checks from enabled oracles that did not pass. */
  findings?: CheckResult[];
  missingChannels?: string[];
  feedback?: string;
  usage: Usage;
};

export type SynthResult = {
  deviceId: string;
  model: string;
  oracles: OracleSet;
  attempts: Attempt[];
  /** The last descriptor that passed validation (accepted or not); null if none ever did. */
  final: Descriptor | null;
  accepted: boolean;
  usage: Usage;
  costUsd: number | null;
  wallMs: number;
  score: SynthScore;
  error?: string;
};

export type Capture = { meta: RecordingMeta; chunks: RecordedChunk[] };

/** The last ```json fenced block in a reply, parsed. */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return { ok: false, reason: "No ```json fenced block found in your reply." };
  try {
    return { ok: true, value: JSON.parse(blocks[blocks.length - 1][1]) };
  } catch (e) {
    return { ok: false, reason: `The JSON block does not parse: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : Math.abs(v) >= 1000 ? v.toFixed(1) : v.toPrecision(5));

/** What decoding the capture produced, per channel: the model's main evidence. */
function decodeSummary(d: Descriptor, chunks: RecordedChunk[]): { text: string; channels: Set<string> } {
  const dec = compileDescriptor(d);
  const values = new Map<string, number[]>();
  for (const c of chunks) {
    for (const s of dec.push(c.bytes).samples) {
      if (!values.has(s.channel)) values.set(s.channel, []);
      values.get(s.channel)!.push(s.value);
    }
  }
  const st = dec.stats;
  const lines = [
    `Decoder: ${st.framesOk} frames/lines decoded from ${st.bytesIn} bytes; ${st.crcErrors} checksum failures; ${st.malformed} unmatched or too short; ${st.bytesDiscarded} bytes skipped; ${st.seqGaps} sequence gaps.`,
  ];
  for (const [ch, vs] of values) {
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    lines.push(`- ${ch}: ${vs.length} values, range ${fmt(min)} … ${fmt(max)}, first: ${vs.slice(0, 8).map(fmt).join(", ")}`);
  }
  if (values.size === 0) lines.push("- no channel produced any value");
  return { text: lines.join("\n"), channels: new Set(values.keys()) };
}

export async function synthesize(device: BenchDevice, capture: Capture, provider: LlmProvider, opts: SynthOptions = {}): Promise<SynthResult> {
  const maxIterations = opts.maxIterations ?? 4;
  const oracles = opts.oracles ?? ALL_ORACLES;
  const deviceChunks = capture.chunks.filter((c) => c.c === "dev");
  const deviceLabel = capture.meta.connections.find((c) => c.key === "dev")!.label;
  const messages: BetaMessageParam[] = [{ role: "user", content: taskPrompt(device, deviceChunks) }];
  const attempts: Attempt[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let final: Descriptor | null = null;
  let accepted = false;
  let error: string | undefined;
  const started = Date.now();

  for (let iteration = 1; iteration <= maxIterations && !accepted; iteration++) {
    let reply;
    try {
      reply = await provider.complete(SYSTEM_PROMPT, messages);
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      break;
    }
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += reply.usage[k];
    // Append-only conversation: the assistant turn goes back exactly as received.
    messages.push({ role: "assistant", content: reply.content });
    const attempt: Attempt = { iteration, replyText: reply.text, stopReason: reply.stopReason, outcome: "no-json", usage: reply.usage };
    attempts.push(attempt);

    if (reply.stopReason === "refusal") {
      error = "model refused";
      break;
    }

    const parsed = extractJson(reply.text);
    let feedback: string;
    if (!parsed.ok) {
      feedback = `${parsed.reason}${reply.stopReason === "max_tokens" ? " (Your reply hit the output limit.)" : ""} Reply with the complete descriptor in one \`\`\`json block.`;
    } else {
      const v = validateDescriptor(parsed.value);
      if (!v.ok) {
        attempt.outcome = "invalid";
        attempt.validationErrors = v.errors;
        feedback = `The descriptor does not validate:\n${v.errors.map((e) => `- ${e}`).join("\n")}\n\nFix these and reply with the complete descriptor.`;
      } else {
        final = v.descriptor;
        const candidate = withPlatformChannelSemantics(v.descriptor);
        const summary = decodeSummary(candidate, deviceChunks);
        const verification = verifyRecording(capture, { dev: candidate });
        const own = verification.connections.find((c) => c.key === "dev")!.report.checks;
        const cross = verification.crossSensor.filter((c) => c.name.includes(`(${deviceLabel})`));
        const findings = [...own, ...cross].filter((c) => oracles[c.oracle] && (c.status === "fail" || c.status === "warn"));
        const missing = device.requiredChannels.filter((ch) => !summary.channels.has(ch));
        attempt.findings = findings;
        attempt.missingChannels = missing;

        if (findings.length === 0 && missing.length === 0) {
          attempt.outcome = "accepted";
          accepted = true;
          continue;
        }
        attempt.outcome = "rejected";
        const parts = ["Result of running your descriptor on the capture:", summary.text];
        if (missing.length) parts.push(`\nRequired channels that produced no values: ${missing.join(", ")}.`);
        if (findings.length) {
          parts.push("\nVerifier findings:");
          for (const f of findings) parts.push(`- [${f.status}] ${f.oracle} / ${f.name}: ${f.detail}`);
        }
        parts.push("\nFix the descriptor and reply with the complete corrected version.");
        feedback = parts.join("\n");
      }
    }
    attempt.feedback = feedback;
    if (iteration < maxIterations) messages.push({ role: "user", content: feedback });
  }

  return {
    deviceId: device.id,
    model: provider.model,
    oracles,
    attempts,
    final,
    accepted,
    usage,
    costUsd: costUsd(provider.model, usage),
    wallMs: Date.now() - started,
    score: scoreDescriptor(final, device.groundTruth, deviceChunks, device.requiredChannels),
    error,
  };
}
