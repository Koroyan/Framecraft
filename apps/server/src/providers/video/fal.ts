import crypto from 'node:crypto';
import type { CatalogVideoModel } from '../../catalog/types';
import { BaseVideoProvider, requestJson } from './base';
import { ProviderError, ProviderHttpError, type HttpFetch, type ProviderStatus, type ProviderVideoRequest, type SubmitContext, type SubmitResult } from './types';

/**
 * fal.ai queue adapter.
 * Docs: https://fal.ai/docs/model-apis/model-endpoints/queue
 * Submit: POST https://queue.fal.run/{endpoint_id}[?fal_webhook=URL] with `Authorization: Key $FAL_KEY`.
 * Status/result/cancel URLs use only {owner}/{app}: .../requests/{id}/status, .../requests/{id}, PUT .../requests/{id}/cancel.
 */
export const FAL_QUEUE_URL = 'https://queue.fal.run';
export const FAL_JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';

type FalInputOptions = {
  image?: string;
  endImage?: string;
  aspect?: string;
  audio?: string;
  durationType?: 'integer' | 'string' | 'seconds-suffix';
};

export function falAppPath(endpointId: string): string {
  const [owner, app] = endpointId.split('/');
  return `${owner}/${app}`;
}

export class FalProvider extends BaseVideoProvider {
  readonly key = 'fal' as const;
  readonly displayName = 'fal.ai';

  constructor(apiKey: string | undefined, fetchImpl?: HttpFetch, private readonly baseUrl = FAL_QUEUE_URL) {
    super(apiKey, fetchImpl);
  }

  private headers() {
    return { Authorization: `Key ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  buildPayload(req: ProviderVideoRequest, webhookUrl?: string): { url: string; body: Record<string, unknown> } {
    const opts = (req.model.providerOptions ?? {}) as { input?: FalInputOptions; endpoints?: Record<string, string> };
    const o = opts.input ?? {};
    // Some fal models use a separate endpoint per mode (text-to-video vs image-to-video).
    const endpoint = opts.endpoints?.[req.mode] ?? req.model.providerModelId;
    const c = req.model.capabilities;
    const input: Record<string, unknown> = { prompt: req.prompt };
    if (o.durationType === 'string') input.duration = String(req.durationSec);
    else if (o.durationType === 'seconds-suffix') input.duration = `${req.durationSec}s`;
    else input.duration = req.durationSec;
    if (o.aspect && req.mode === 'text-to-video') input[o.aspect] = req.aspectRatio;
    if (c.resolutions.length > 1) input.resolution = req.resolution;
    if (o.audio) input[o.audio] = req.audio;
    if (req.image && req.mode !== 'text-to-video') input[o.image ?? 'image_url'] = req.image;
    if (req.endImage && req.mode === 'first-last-frame') input[o.endImage ?? 'end_image_url'] = req.endImage;
    if (c.negativePrompt && req.negativePrompt) input.negative_prompt = req.negativePrompt;
    if (c.seed && req.seed !== undefined) input.seed = req.seed;
    const qs = webhookUrl ? `?fal_webhook=${encodeURIComponent(webhookUrl)}` : '';
    return { url: `${this.baseUrl}/${endpoint}${qs}`, body: input };
  }

  async submitGeneration(req: ProviderVideoRequest, ctx: SubmitContext): Promise<SubmitResult> {
    this.assertValid(req);
    const { url, body } = this.buildPayload(req, ctx.webhookUrl);
    try {
      const res = await requestJson<{ request_id: string; status_url?: string; response_url?: string }>(this.fetchImpl, url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      if (!res?.request_id) throw new ProviderError({ code: 'unknown', message: 'fal.ai did not return a request id', retryable: false, providerRefunds: true });
      return { externalId: res.request_id, raw: res };
    } catch (err) {
      throw new ProviderError(this.normalizeError(err));
    }
  }

  async getGenerationStatus(externalId: string, model: CatalogVideoModel): Promise<ProviderStatus> {
    const app = falAppPath(model.providerModelId);
    const base = `${this.baseUrl}/${app}/requests/${encodeURIComponent(externalId)}`;
    let status: { status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'; queue_position?: number };
    try {
      status = await requestJson(this.fetchImpl, `${base}/status`, { headers: this.headers() });
    } catch (err) {
      throw new ProviderError(this.normalizeError(err));
    }
    if (status.status === 'IN_QUEUE') return { state: 'queued', raw: status };
    if (status.status === 'IN_PROGRESS') return { state: 'running', raw: status };
    try {
      const result = await requestJson<{ video?: { url?: string } }>(this.fetchImpl, base, { headers: this.headers() });
      const url = result?.video?.url;
      if (!url) return { state: 'failed', error: { code: 'bad_output', message: 'fal.ai result contained no video', retryable: true, providerRefunds: false }, raw: result };
      return { state: 'succeeded', outputs: [{ url, mimeType: 'video/mp4' }], raw: result };
    } catch (err) {
      const n = this.normalizeError(err);
      return { state: 'failed', error: err instanceof ProviderHttpError && err.status === 422 ? { ...n, code: 'content_policy', retryable: false } : n, raw: (err as ProviderHttpError).body };
    }
  }

  async cancelGeneration(externalId: string, model: CatalogVideoModel): Promise<boolean> {
    const url = `${this.baseUrl}/${falAppPath(model.providerModelId)}/requests/${encodeURIComponent(externalId)}/cancel`;
    try {
      const res = await this.fetchImpl(url, { method: 'PUT', headers: this.headers() });
      return res.status === 200 || res.status === 202;
    } catch {
      return false;
    }
  }
}

// ------------------------------------------------------------ webhook verification

type Jwk = { kty: string; crv: string; x: string; kid?: string };
let jwksCache: { keys: Jwk[]; fetchedAt: number } | undefined;

export async function fetchFalJwks(fetchImpl: HttpFetch = fetch): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 12 * 3600_000) return jwksCache.keys;
  const body = await requestJson<{ keys: Jwk[] }>(fetchImpl, FAL_JWKS_URL);
  jwksCache = { keys: body.keys ?? [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

/**
 * Verify a fal.ai webhook (Ed25519). Message:
 * request_id \n user_id \n timestamp \n hex(sha256(raw body)).
 */
export function verifyFalWebhookSignature(
  headers: Record<string, string | undefined>,
  rawBody: Buffer,
  keys: Jwk[],
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const requestId = headers['x-fal-webhook-request-id'];
  const userId = headers['x-fal-webhook-user-id'];
  const timestamp = headers['x-fal-webhook-timestamp'];
  const signature = headers['x-fal-webhook-signature'];
  if (!requestId || !userId || !timestamp || !signature) return false;
  if (Math.abs(nowSec - Number(timestamp)) > 300) return false;
  const digest = crypto.createHash('sha256').update(rawBody).digest('hex');
  const message = Buffer.from([requestId, userId, timestamp, digest].join('\n'), 'utf8');
  let sig: Buffer;
  try {
    sig = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return keys.some((k) => {
    try {
      const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' });
      return crypto.verify(null, message, key, sig);
    } catch {
      return false;
    }
  });
}
