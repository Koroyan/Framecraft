import type { CatalogVideoModel } from '../../catalog/types';
import { BaseVideoProvider, requestJson } from './base';
import { ProviderError, type HttpFetch, type ProviderStatus, type ProviderVideoRequest, type SubmitContext, type SubmitResult } from './types';

/**
 * Google Gemini API adapter (direct).
 *
 * - Veo (`models/{id}:predictLongRunning` + operation polling). Veo 3.1 preview
 *   models were announced for shutdown on 2026-10-22 and are catalogued as
 *   discontinued; the code path remains for any future GA Veo model.
 * - Gemini Omni (`/v1beta/interactions`) returns the video inline (base64).
 *   Duration control is not documented, so the model is catalogued unverified.
 *
 * Auth: `x-goog-api-key: $GEMINI_API_KEY`.
 */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

type VeoOperation = {
  name: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[]; raiMediaFilteredReasons?: string[] } };
};

const parseDataUri = (uri?: string) => {
  const m = uri?.match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mimeType: m[1]!, data: m[2]! } : undefined;
};

export class GoogleProvider extends BaseVideoProvider {
  readonly key = 'google' as const;
  readonly displayName = 'Google Gemini API';

  constructor(apiKey: string | undefined, fetchImpl?: HttpFetch, private readonly baseUrl = GEMINI_BASE_URL) {
    super(apiKey, fetchImpl);
  }

  private headers() {
    return { 'x-goog-api-key': this.apiKey ?? '', 'Content-Type': 'application/json' };
  }

  private isOmni(model: CatalogVideoModel) {
    return model.providerModelId.startsWith('gemini-omni');
  }

  buildPayload(req: ProviderVideoRequest): { url: string; body: Record<string, unknown> } {
    if (this.isOmni(req.model)) {
      const input: unknown[] = [];
      const img = parseDataUri(req.image);
      if (img) input.push({ type: 'image', data: img.data, mime_type: img.mimeType });
      input.push({ type: 'text', text: req.prompt });
      return {
        url: `${this.baseUrl}/interactions`,
        body: {
          model: req.model.providerModelId,
          input: input.length === 1 ? req.prompt : input,
          response_format: { type: 'video', aspect_ratio: req.aspectRatio, resolution: req.resolution },
        },
      };
    }
    const instance: Record<string, unknown> = { prompt: req.prompt };
    const img = parseDataUri(req.image);
    if (img) instance.image = { inlineData: img };
    const last = parseDataUri(req.endImage);
    if (last) instance.lastFrame = { inlineData: last };
    const parameters: Record<string, unknown> = {
      aspectRatio: req.aspectRatio,
      durationSeconds: String(req.durationSec),
      resolution: req.resolution,
    };
    if (req.negativePrompt) parameters.negativePrompt = req.negativePrompt;
    return { url: `${this.baseUrl}/models/${req.model.providerModelId}:predictLongRunning`, body: { instances: [instance], parameters } };
  }

  async submitGeneration(req: ProviderVideoRequest, ctx: SubmitContext): Promise<SubmitResult> {
    this.assertValid(req);
    const { url, body } = this.buildPayload(req);
    try {
      if (this.isOmni(req.model)) {
        // Synchronous: the response carries the finished video.
        const res = await requestJson<{ id?: string; steps?: { content?: { type: string; data?: string; mime_type?: string }[] }[] }>(this.fetchImpl, url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: ctx.signal,
          timeoutMs: 15 * 60_000,
        });
        const video = res.steps?.flatMap((s) => s.content ?? []).find((c) => c.type === 'video' && c.data);
        const immediate: ProviderStatus = video
          ? { state: 'succeeded', outputs: [{ inlineBase64: video.data, mimeType: video.mime_type ?? 'video/mp4' }] }
          : { state: 'failed', error: { code: 'bad_output', message: 'Gemini returned no video', retryable: true, providerRefunds: true } };
        return { externalId: res.id ?? `omni-${ctx.idempotencyKey}`, raw: { id: res.id }, immediate };
      }
      const op = await requestJson<VeoOperation>(this.fetchImpl, url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ctx.signal });
      if (!op?.name) throw new ProviderError({ code: 'unknown', message: 'Gemini API did not return an operation', retryable: false, providerRefunds: true });
      return { externalId: op.name, raw: op };
    } catch (err) {
      throw new ProviderError(this.normalizeError(err));
    }
  }

  async getGenerationStatus(externalId: string): Promise<ProviderStatus> {
    let op: VeoOperation;
    try {
      op = await requestJson<VeoOperation>(this.fetchImpl, `${this.baseUrl}/${externalId}`, { headers: this.headers() });
    } catch (err) {
      throw new ProviderError(this.normalizeError(err));
    }
    if (!op.done) return { state: 'running', raw: op };
    if (op.error) return { state: 'failed', error: { code: 'provider_unavailable', message: op.error.message ?? 'Generation failed', retryable: true, providerRefunds: true }, raw: op };
    const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) {
      const filtered = op.response?.generateVideoResponse?.raiMediaFilteredReasons;
      return {
        state: 'failed',
        error: filtered?.length
          ? { code: 'content_policy', message: filtered.join('; '), retryable: false, providerRefunds: true }
          : { code: 'bad_output', message: 'No video in response', retryable: true, providerRefunds: true },
        raw: op,
      };
    }
    // Google's download example sends the API key header.
    return { state: 'succeeded', outputs: [{ url: uri, headers: { 'x-goog-api-key': this.apiKey ?? '' }, mimeType: 'video/mp4' }], raw: op };
  }

  async checkCredentials(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey) return { ok: false, message: 'GEMINI_API_KEY is not set' };
    try {
      const res = await requestJson<{ models?: unknown[] }>(this.fetchImpl, `${this.baseUrl}/models?pageSize=1`, { headers: this.headers() });
      return { ok: true, message: `Authenticated (${res.models?.length ?? 0} model listed)` };
    } catch (err) {
      return { ok: false, message: `Gemini credential check failed: ${(err as Error).message}` };
    }
  }
}
