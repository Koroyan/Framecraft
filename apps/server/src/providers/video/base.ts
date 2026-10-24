import { RESOLUTION_RANK } from '@framecraft/shared';
import type { CatalogVideoModel, PricingConfidence, ProviderKey, VideoCapabilities } from '../../catalog/types';
import { VIDEO_MODELS } from '../../catalog/video-models';
import {
  ProviderError,
  ProviderHttpError,
  type HttpFetch,
  type NormalizedError,
  type OutputRef,
  type ProviderStatus,
  type ProviderVideoRequest,
  type SubmitContext,
  type SubmitResult,
  type VideoProvider,
} from './types';

export async function requestJson<T = unknown>(fetchImpl: HttpFetch, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 60_000);
  try {
    const res = await fetchImpl(url, { ...init, signal: init.signal ?? controller.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) throw new ProviderHttpError(res.status, body, `HTTP ${res.status} from ${new URL(url).host}`);
    return body as T;
  } catch (err) {
    if (err instanceof ProviderHttpError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new ProviderError({ code: 'timeout', message: `Request to ${new URL(url).host} timed out`, retryable: true, providerRefunds: true });
    }
    throw new ProviderError({ code: 'provider_unavailable', message: `Network error contacting ${new URL(url).host}: ${(err as Error).message}`, retryable: true, providerRefunds: true });
  } finally {
    clearTimeout(timer);
  }
}

/** Redact anything that looks like inline media or secrets before persisting payloads. */
export function redactPayload(body: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.startsWith('data:') ? `[data-uri ${Math.round(v.length / 1024)}KB]` : v.length > 4000 ? `${v.slice(0, 4000)}…` : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(body) as Record<string, unknown>;
}

export function httpErrorToNormalized(err: ProviderHttpError): NormalizedError {
  const detail = extractMessage(err.body) ?? err.message;
  const base = { httpStatus: err.status, providerRefunds: true } as const;
  switch (true) {
    case err.status === 400 || err.status === 422:
      return { ...base, code: /safety|moderat|policy|nsfw/i.test(detail) ? 'content_policy' : 'invalid_request', message: detail, retryable: false };
    case err.status === 401 || err.status === 403:
      return { ...base, code: 'auth', message: 'Provider rejected the API credentials', retryable: false };
    case err.status === 402:
      return { ...base, code: 'insufficient_provider_balance', message: 'Provider account balance is insufficient', retryable: false };
    case err.status === 404:
      return { ...base, code: 'not_found', message: detail, retryable: false };
    case err.status === 413:
      return { ...base, code: 'invalid_request', message: 'Input file is too large for the provider', retryable: false };
    case err.status === 429:
      return { ...base, code: 'rate_limited', message: 'Provider rate limit reached', retryable: true };
    case err.status >= 500:
      return { ...base, code: 'provider_unavailable', message: `Provider error (${err.status})`, retryable: true };
    default:
      return { ...base, code: 'unknown', message: detail, retryable: false };
  }
}

function extractMessage(body: unknown): string | undefined {
  if (!body) return undefined;
  if (typeof body === 'string') return body.slice(0, 500);
  const b = body as Record<string, unknown>;
  const candidates = [b.error, b.message, b.detail, (b.error as Record<string, unknown> | undefined)?.message];
  // Zod-style validation issues (Runway): name the offending fields, not just "Validation of body failed".
  const issues = Array.isArray(b.issues) ? (b.issues as { path?: unknown[]; message?: string }[]).map((i) => `${(i.path ?? []).join('.') || 'body'}: ${i.message ?? 'invalid'}`).join('; ') : '';
  for (const c of candidates) {
    if (typeof c === 'string') return (issues ? `${c} (${issues})` : c).slice(0, 500);
    if (Array.isArray(c) && c.length) return JSON.stringify(c).slice(0, 500);
  }
  return undefined;
}

export abstract class BaseVideoProvider implements VideoProvider {
  abstract readonly key: ProviderKey;
  abstract readonly displayName: string;

  constructor(
    protected readonly apiKey: string | undefined,
    protected readonly fetchImpl: HttpFetch = fetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getSupportedModels(): CatalogVideoModel[] {
    return VIDEO_MODELS.filter((m) => m.provider === this.key);
  }

  getCapabilities(modelKey: string): VideoCapabilities | undefined {
    return this.getSupportedModels().find((m) => m.key === modelKey)?.capabilities;
  }

  validateRequest(req: ProviderVideoRequest): string[] {
    const c = req.model.capabilities;
    const problems: string[] = [];
    if (req.model.provider !== this.key) problems.push(`model ${req.model.key} does not belong to ${this.key}`);
    if (!c.modes.includes(req.mode)) problems.push(`mode ${req.mode} not supported`);
    if (!c.resolutions.includes(req.resolution)) problems.push(`resolution ${req.resolution} not supported`);
    const allowed = c.durationsByResolution?.[req.resolution] ?? c.durations.allowed;
    if (allowed ? !allowed.includes(req.durationSec) : req.durationSec < c.durations.min || req.durationSec > c.durations.max)
      problems.push(`duration ${req.durationSec}s not supported`);
    if (req.mode === 'text-to-video' && !c.aspectRatios.includes(req.aspectRatio)) problems.push(`aspect ${req.aspectRatio} not supported`);
    if (req.mode !== 'text-to-video' && req.mode !== 'reference-to-video' && !req.image) problems.push('first frame image required');
    if (req.mode === 'first-last-frame' && !req.endImage) problems.push('last frame image required');
    if (req.mode === 'reference-to-video' && !req.references?.length) problems.push('reference images required');
    if (req.mode === 'reference-to-video' && (req.references?.length ?? 0) > c.maxReferenceImages) problems.push(`at most ${c.maxReferenceImages} reference images`);
    if (req.audio && c.nativeAudio === 'none') problems.push('native audio not supported');
    if (req.prompt.length > c.maxPromptChars) problems.push(`prompt longer than ${c.maxPromptChars} characters`);
    return problems;
  }

  estimateCost(req: ProviderVideoRequest): { usd: number; confidence: PricingConfidence } {
    const price =
      req.model.pricing.find((p) => p.resolution === req.resolution && p.audio === req.audio) ??
      req.model.pricing.find((p) => p.resolution === req.resolution && p.audio === 'any') ??
      [...req.model.pricing].sort((a, b) => RESOLUTION_RANK[b.resolution] - RESOLUTION_RANK[a.resolution])[0];
    if (!price) return { usd: 0, confidence: 'unverified' };
    const refs = req.mode === 'reference-to-video' ? (req.references?.length ?? 0) : req.mode === 'text-to-video' ? 0 : 1;
    const usd = Math.max(price.usdPerSecond * req.durationSec + (price.usdPerReference ?? 0) * refs, price.minimumUsd ?? 0);
    return { usd: Math.round(usd * 10000) / 10000, confidence: req.model.pricingConfidence };
  }

  protected assertValid(req: ProviderVideoRequest) {
    if (!this.apiKey) throw new ProviderError({ code: 'auth', message: `${this.displayName} API key is not configured`, retryable: false, providerRefunds: true });
    const problems = this.validateRequest(req);
    if (problems.length) throw new ProviderError({ code: 'invalid_request', message: problems.join('; '), retryable: false, providerRefunds: true });
  }

  abstract buildPayload(req: ProviderVideoRequest): { url: string; body: Record<string, unknown> };
  abstract submitGeneration(req: ProviderVideoRequest, ctx: SubmitContext): Promise<SubmitResult>;
  abstract getGenerationStatus(externalId: string, model: CatalogVideoModel): Promise<ProviderStatus>;

  retrieveOutput(status: ProviderStatus): OutputRef[] {
    if (status.state !== 'succeeded') return [];
    return status.outputs ?? [];
  }

  normalizeError(err: unknown): NormalizedError {
    if (err instanceof ProviderError) return err.normalized;
    if (err instanceof ProviderHttpError) return httpErrorToNormalized(err);
    return { code: 'unknown', message: (err as Error)?.message ?? String(err), retryable: false, providerRefunds: false };
  }
}
