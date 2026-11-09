import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessageParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

// LLM access for descriptor synthesis. Runs in Node only (test runner / scripts): API credentials never
// reach the browser app.

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type Reply = {
  /** Assistant content exactly as returned; appended to the conversation unchanged. */
  content: BetaContentBlock[];
  text: string;
  stopReason: string | null;
  usage: Usage;
};

export interface LlmProvider {
  readonly model: string;
  complete(system: string, messages: BetaMessageParam[]): Promise<Reply>;
}

export const SYNTH_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type SynthModel = (typeof SYNTH_MODELS)[number];

/** USD per million tokens (input, output, cache read, cache write) for cost reporting; prompts under 100K. */
export const PRICING: Record<SynthModel, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function costUsd(model: string, u: Usage): number | null {
  const p = PRICING[model as SynthModel];
  if (!p) return null;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1e6;
}

/** Server-side refusal fallback is offered for Opus 5.5 and Sonnet 5.5 on the Claude API; Haiku 5.5 has none. */
const SUPPORTS_SERVER_FALLBACK = new Set<string>(["claude-opus-5-5", "claude-sonnet-5-5"]);

export class AnthropicProvider implements LlmProvider {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: "low" | "medium" | "high" | "xhigh" | "max";

  constructor(model: SynthModel = "claude-opus-5-5", effort: AnthropicProvider["effort"] = "high") {
    this.model = model;
    this.effort = effort;
    // Credentials from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
    this.client = new Anthropic({ maxRetries: 4 });
  }

  async complete(system: string, messages: BetaMessageParam[]): Promise<Reply> {
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
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    return {
      content: msg.content,
      text,
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

/** Deterministic stand-in for tests: replies are given up front or computed from the conversation. */
export class ScriptedProvider implements LlmProvider {
  readonly model = "scripted";
  private readonly replies: Array<string | ((messages: BetaMessageParam[]) => string)>;
  private i = 0;

  constructor(replies: Array<string | ((messages: BetaMessageParam[]) => string)>) {
    this.replies = replies;
  }

  async complete(_system: string, messages: BetaMessageParam[]): Promise<Reply> {
    const r = this.replies[Math.min(this.i++, this.replies.length - 1)];
    const text = typeof r === "function" ? r(messages) : r;
    return {
      content: [{ type: "text", text, citations: null } as BetaContentBlock],
      text,
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
