import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessageParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ApiError, GoogleGenAI, type Content } from "@google/genai";

// LLM access for descriptor synthesis. Runs in Node only (test runner / scripts): API credentials never
// reach the browser app. Providers share one conversation format; each assistant turn keeps the provider's
// own content (Claude thinking blocks, Gemini thought signatures) so it is sent back exactly as received.

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type Turn = { role: "user"; text: string } | { role: "assistant"; text: string; native: unknown };

export type Reply = {
  /** Provider-native assistant content, replayed unchanged on the next request. */
  native: unknown;
  text: string;
  /** Normalised: "end_turn", "max_tokens", "refusal", or the provider's own reason. */
  stopReason: string | null;
  usage: Usage;
  /** Retries after rate limits / server errors before this reply (providers that retry themselves). */
  retries?: number;
};

export interface LlmProvider {
  readonly model: string;
  complete(system: string, turns: Turn[]): Promise<Reply>;
}

export const SYNTH_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type SynthModel = (typeof SYNTH_MODELS)[number];

/** USD per million tokens (input, output, cache read, cache write) for cost reporting; prompts under 100K. */
export const PRICING: Record<SynthModel, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Cost in USD, or null for models without a price here (Gemini: free tier or account-specific). */
export function costUsd(model: string, u: Usage): number | null {
  const p = PRICING[model as SynthModel];
  if (!p) return null;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1e6;
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * "claude-opus-5-5" etc. for Claude; "gemini:<model id>" for Gemini (list ids with `npm run gemini:models`).
 * Credentials come from the environment: ANTHROPIC_API_KEY / GEMINI_API_KEY (see .env.example).
 */
export function createProvider(spec: string, effort: Effort = "high"): LlmProvider {
  if (spec.startsWith("gemini:")) return new GeminiProvider(spec.slice("gemini:".length));
  if ((SYNTH_MODELS as readonly string[]).includes(spec)) return new AnthropicProvider(spec as SynthModel, effort);
  throw new Error(`Unknown model "${spec}". Use one of ${SYNTH_MODELS.join(", ")} or gemini:<model id>.`);
}

// ---- Claude ---------------------------------------------------------------------------------------------

/** Server-side refusal fallback is offered for Opus 5.5 and Sonnet 5.5 on the Claude API; Haiku 5.5 has none. */
const SUPPORTS_SERVER_FALLBACK = new Set<string>(["claude-opus-5-5", "claude-sonnet-5-5"]);

export class AnthropicProvider implements LlmProvider {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;

  constructor(model: SynthModel = "claude-opus-5-5", effort: Effort = "high") {
    this.model = model;
    this.effort = effort;
    // Credentials from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
    this.client = new Anthropic({ maxRetries: 4 });
  }

  async complete(system: string, turns: Turn[]): Promise<Reply> {
    const messages: BetaMessageParam[] = turns.map((t) =>
      t.role === "user" ? { role: "user", content: t.text } : { role: "assistant", content: t.native as BetaContentBlock[] }
    );
    const params: MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: 32000,
      system,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort },
      // The system prompt (schema) and the growing conversation are re-sent every iteration.
      cache_control: { type: "ephemeral" },
      ...(SUPPORTS_SERVER_FALLBACK.has(this.model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    };
    const msg = await this.client.beta.messages.stream(params).finalMessage();
    return {
      native: msg.content,
      text: msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
      stopReason: msg.stop_reason,
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

// ---- Gemini ---------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A quota that will not recover within a run (e.g. Gemini free tier: requests per day). Not worth retrying. */
export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

/** Gemini signals daily quotas with a 429 whose quota id contains "PerDay" and a retry delay of hours. */
export function dailyQuota(err: ApiError, model: string): QuotaExhaustedError | null {
  if (err.status !== 429 || !/PerDay/.test(err.message)) return null;
  const limit = /"quotaValue":"(\d+)"/.exec(err.message)?.[1];
  const retry = /retry in ((?:\d+h)?(?:\d+m)?\d+)(?:\.\d+)?s/.exec(err.message)?.[1];
  return new QuotaExhaustedError(
    `daily request quota for ${model} exhausted${limit ? ` (${limit} requests/day)` : ""}${retry ? `; resets in ${retry}s` : ""}`
  );
}

export class GeminiProvider implements LlmProvider {
  readonly model: string;
  private readonly modelId: string;
  private readonly client: GoogleGenAI;

  constructor(modelId: string) {
    this.modelId = modelId;
    this.model = `gemini:${modelId}`;
    this.client = new GoogleGenAI({}); // reads GEMINI_API_KEY / GOOGLE_API_KEY
  }

  async complete(system: string, turns: Turn[]): Promise<Reply> {
    const contents: Content[] = turns.map((t) =>
      t.role === "user" ? { role: "user", parts: [{ text: t.text }] } : (t.native as Content)
    );
    // Free-tier rate limits are tight: back off and retry on 429 and server errors.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.client.models.generateContent({
          model: this.modelId,
          contents,
          config: { systemInstruction: system, maxOutputTokens: 32768 },
        });
        const candidate = res.candidates?.[0];
        const finish = candidate?.finishReason ?? null;
        const u = res.usageMetadata;
        const cached = u?.cachedContentTokenCount ?? 0;
        return {
          native: candidate?.content ?? { role: "model", parts: [] },
          text: res.text ?? "",
          stopReason:
            finish === "STOP" ? "end_turn" : finish === "MAX_TOKENS" ? "max_tokens" : finish === "SAFETY" || finish === "PROHIBITED_CONTENT" ? "refusal" : finish,
          retries: attempt,
          usage: {
            inputTokens: (u?.promptTokenCount ?? 0) - cached,
            outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
          },
        };
      } catch (err) {
        const daily = err instanceof ApiError ? dailyQuota(err, this.modelId) : null;
        if (daily) throw daily;
        // Rate limits, server errors, and dropped connections (fetch throws a TypeError) are worth retrying.
        const retryable = (err instanceof ApiError && (err.status === 429 || err.status >= 500)) || (err instanceof TypeError && /fetch failed/i.test(err.message));
        if (!retryable || attempt >= 5) throw err;
        console.warn(`${this.model}: ${err instanceof ApiError ? `HTTP ${err.status}` : err.message}, retry ${attempt + 1}/5`);
        await sleep(Math.min(60_000, 5_000 * 2 ** attempt));
      }
    }
  }
}

/** Gemini model ids that support generateContent, for choosing SYNTH_MODELS=gemini:<id>. */
export async function listGeminiModels(): Promise<string[]> {
  const out: string[] = [];
  const pager = await new GoogleGenAI({}).models.list();
  for await (const m of pager) {
    if (m.name && (m.supportedActions ?? []).includes("generateContent")) out.push(m.name.replace(/^models\//, ""));
  }
  return out;
}

// ---- tests ----------------------------------------------------------------------------------------------

/** Deterministic stand-in for tests: replies are given up front or computed from the conversation. */
export class ScriptedProvider implements LlmProvider {
  readonly model = "scripted";
  private readonly replies: Array<string | ((turns: Turn[]) => string)>;
  private i = 0;

  constructor(replies: Array<string | ((turns: Turn[]) => string)>) {
    this.replies = replies;
  }

  async complete(_system: string, turns: Turn[]): Promise<Reply> {
    const r = this.replies[Math.min(this.i++, this.replies.length - 1)];
    const text = typeof r === "function" ? r(turns) : r;
    return { native: text, text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}
