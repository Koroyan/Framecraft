import type { CatalogVideoModel } from '../../catalog/types';
import { BaseVideoProvider, requestJson } from './base';
import { ProviderError, type HttpFetch, type ProviderStatus, type ProviderVideoRequest, type SubmitContext, type SubmitResult } from './types';

/**
 * Replicate adapter (generic predictions API).
 * POST /v1/models/{owner}/{name}/predictions → { id }; GET /v1/predictions/{id}; POST /v1/predictions/{id}/cancel.
 * Auth: `Authorization: Bearer $REPLICATE_API_TOKEN`.
 *
 * No Replicate video models are enabled by default: each model's input schema
 * and price must be verified and added to the catalog by an administrator.
 * This adapter is also the path for commercially-licensed open-weight models
 * deployed on rented GPUs (Replicate deployments) — see docs/SELF_HOSTING.md.
 */
export const REPLICATE_BASE_URL = 'https://api.replicate.com/v1';

type Prediction = {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[] | null;
  error?: string | null;
  metrics?: { predict_time?: number };
};

type InputMap = { prompt?: string; image?: string; endImage?: string; duration?: string; aspect?: string; resolution?: string; seed?: string; audio?: string };

export class ReplicateProvider extends BaseVideoProvider {
  readonly key = 'replicate' as const;
  readonly displayName = 'Replicate';

  constructor(apiKey: string | undefined, fetchImpl?: HttpFetch, private readonly baseUrl = REPLICATE_BASE_URL) {
    super(apiKey, fetchImpl);
  }

  private headers() {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  buildPayload(req: ProviderVideoRequest, webhookUrl?: string): { url: string; body: Record<string, unknown> } {
    const map = ((req.model.providerOptions ?? {}) as { input?: InputMap }).input ?? {};
    const input: Record<string, unknown> = { [map.prompt ?? 'prompt']: req.prompt };
    if (map.duration !== '') input[map.duration ?? 'duration'] = req.durationSec;
    if (req.mode === 'text-to-video') input[map.aspect ?? 'aspect_ratio'] = req.aspectRatio;
    if (map.resolution) input[map.resolution] = req.resolution;
    if (req.image) input[map.image ?? 'image'] = req.image;
    if (req.endImage && map.endImage) input[map.endImage] = req.endImage;
    if (req.seed !== undefined) input[map.seed ?? 'seed'] = req.seed;
    if (map.audio) input[map.audio] = req.audio;
    const body: Record<string, unknown> = { input };
    if (webhookUrl) Object.assign(body, { webhook: webhookUrl, webhook_events_filter: ['completed'] });
    return { url: `${this.baseUrl}/models/${req.model.providerModelId}/predictions`, body };
  }

  async submitGeneration(req: ProviderVideoRequest, ctx: SubmitContext): Promise<SubmitResult> {
    this.assertValid(req);
    const { url, body } = this.buildPayload(req, ctx.webhookUrl);
    try {
      const res = await requestJson<Prediction>(this.fetchImpl, url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ctx.signal });
      return { externalId: res.id, raw: res };
    } catch (err) {
      throw new ProviderError(this.normalizeError(err));
    }
  }

  async getGenerationStatus(externalId: string, _model: CatalogVideoModel): Promise<ProviderStatus> {
    let p: Prediction;
    try {
      p = await requestJson<Prediction>(this.fetchImpl, `${this.baseUrl}/predictions/${encodeURIComponent(externalId)}`, { headers: this.headers() });
    } catch (err) {
      throw new ProviderError(this.normalizeError(err));
    }
    if (p.status === 'starting') return { state: 'queued', raw: p };
    if (p.status === 'processing') return { state: 'running', raw: p };
    if (p.status === 'canceled') return { state: 'cancelled', raw: p };
    if (p.status === 'failed') {
      const policy = /nsfw|safety|policy/i.test(p.error ?? '');
      return { state: 'failed', error: { code: policy ? 'content_policy' : 'provider_unavailable', message: p.error ?? 'Prediction failed', retryable: !policy, providerRefunds: false }, raw: p };
    }
    const urls = Array.isArray(p.output) ? p.output : p.output ? [p.output] : [];
    if (!urls.length) return { state: 'failed', error: { code: 'bad_output', message: 'Prediction returned no output', retryable: true, providerRefunds: false }, raw: p };
    return { state: 'succeeded', outputs: urls.map((url) => ({ url })), raw: p };
  }

  async cancelGeneration(externalId: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/predictions/${encodeURIComponent(externalId)}/cancel`, { method: 'POST', headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async checkCredentials(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey) return { ok: false, message: 'REPLICATE_API_TOKEN is not set' };
    try {
      const acct = await requestJson<{ username?: string }>(this.fetchImpl, `${this.baseUrl}/account`, { headers: this.headers() });
      return { ok: true, message: `Authenticated as ${acct.username ?? 'unknown'}` };
    } catch (err) {
      return { ok: false, message: `Replicate credential check failed: ${(err as Error).message}` };
    }
  }
}
