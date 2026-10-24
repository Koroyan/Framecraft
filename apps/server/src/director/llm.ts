import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';

export type LlmTier = 'fast' | 'smart';

export type LlmUsage = { model: string; inputTokens: number; outputTokens: number; costUsd: number };

/** Image passed to the model (base64, already downscaled by the caller). */
export type LlmImage = { label: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string };

/** Provider-independent structured-output LLM interface used by the AI Director. */
export interface LlmClient {
  readonly available: boolean;
  structured<S extends z.ZodType>(p: { tier: LlmTier; system: string; prompt: string; schema: S; maxTokens?: number; images?: LlmImage[] }): Promise<{ data: z.infer<S>; usage: LlmUsage }>;
}

export class LlmError extends Error {
  constructor(message: string, public readonly code: 'refusal' | 'parse' | 'api' | 'unavailable') {
    super(message);
  }
}

// USD per million tokens (input, output) — used to record LLM planning cost.
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};

/**
 * Claude-backed planner.
 * - `fast` tier (default claude-haiku-5-5): prompt enhancement, hooks, captions — high volume, low cost.
 * - `smart` tier (default claude-opus-5-5): screenplay and shot planning, with server-side refusal fallback.
 */
export class AnthropicLlm implements LlmClient {
  private client?: Anthropic;
  constructor(
    apiKey: string | undefined,
    private readonly models: { fast: string; smart: string },
  ) {
    if (apiKey) this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  get available() {
    return Boolean(this.client);
  }

  async structured<S extends z.ZodType>(p: { tier: LlmTier; system: string; prompt: string; schema: S; maxTokens?: number; images?: LlmImage[] }) {
    if (!this.client) throw new LlmError('AI Director is not configured (ANTHROPIC_API_KEY missing)', 'unavailable');
    const model = this.models[p.tier];
    // Images precede the text, each introduced by its label (e.g. photo1) so the model can refer to it.
    const content: Anthropic.ContentBlockParam[] = [
      ...(p.images ?? []).flatMap((img): Anthropic.ContentBlockParam[] => [
        { type: 'text', text: img.label },
        { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
      ]),
      { type: 'text', text: p.prompt },
    ];
    try {
      if (p.tier === 'smart') {
        const res = await this.client.beta.messages.parse({
          model,
          max_tokens: p.maxTokens ?? 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: p.system,
          output_config: { effort: 'medium', format: betaZodOutputFormat(p.schema) },
          messages: [{ role: 'user', content }],
        });
        if (res.stop_reason === 'refusal') throw new LlmError('The AI Director declined this request.', 'refusal');
        if (res.parsed_output == null) throw new LlmError('The AI Director returned an unexpected format.', 'parse');
        return { data: res.parsed_output as z.infer<S>, usage: this.usage(res.model ?? model, res.usage) };
      }
      const res = await this.client.messages.parse({
        model,
        max_tokens: p.maxTokens ?? 4000,
        cache_control: { type: 'ephemeral' },
        system: p.system,
        output_config: { effort: 'low', format: zodOutputFormat(p.schema) },
        messages: [{ role: 'user', content }],
      });
      if (res.stop_reason === 'refusal') throw new LlmError('The AI Director declined this request.', 'refusal');
      if (res.parsed_output == null) throw new LlmError('The AI Director returned an unexpected format.', 'parse');
      return { data: res.parsed_output as z.infer<S>, usage: this.usage(model, res.usage) };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Anthropic.RateLimitError) throw new LlmError('AI Director is rate limited, please retry shortly.', 'api');
      if (err instanceof Anthropic.AuthenticationError) throw new LlmError('AI Director credentials were rejected.', 'unavailable');
      if (err instanceof Anthropic.APIError) throw new LlmError(`AI Director error (${err.status ?? 'network'})`, 'api');
      throw new LlmError((err as Error).message, 'api');
    }
  }

  private usage(model: string, u: { input_tokens: number; output_tokens: number }): LlmUsage {
    const [pin, pout] = PRICES[model] ?? [4, 20];
    return { model, inputTokens: u.input_tokens, outputTokens: u.output_tokens, costUsd: (u.input_tokens * pin + u.output_tokens * pout) / 1e6 };
  }
}

/** Test double: returns canned structured data. */
export class FakeLlm implements LlmClient {
  readonly available = true;
  calls: { tier: LlmTier; prompt: string; images: number }[] = [];
  constructor(private readonly respond: (p: { tier: LlmTier; prompt: string; system: string }) => unknown) {}
  async structured<S extends z.ZodType>(p: { tier: LlmTier; system: string; prompt: string; schema: S; images?: LlmImage[] }) {
    this.calls.push({ tier: p.tier, prompt: p.prompt, images: p.images?.length ?? 0 });
    const data = p.schema.parse(this.respond(p));
    return { data, usage: { model: 'fake', inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}
