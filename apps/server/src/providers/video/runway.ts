import type { CatalogVideoModel } from '../../catalog/types';
import { BaseVideoProvider, requestJson } from './base';
import { ProviderError, ProviderHttpError, type HttpFetch, type NormalizedError, type ProviderStatus, type ProviderVideoRequest, type SubmitContext, type SubmitResult } from './types';

/**
 * Runway Developer API adapter.
 * Docs: https://docs.dev.runwayml.com/ (API version 2024-11-06).
 * Auth: `Authorization: Bearer $RUNWAYML_API_SECRET`, `X-Runway-Version: 2024-11-06`.
 * Tasks: POST /v1/{text_to_video|image_to_video} → { id }; GET /v1/tasks/{id}; DELETE /v1/tasks/{id}.
 */
export const RUNWAY_BASE_URL = 'https://api.dev.runwayml.com';
export const RUNWAY_API_VERSION = '2024-11-06';
const USD_PER_CREDIT = 0.01;

type RunwayOptions = {
  endpoints: Record<string, string>;
  ratios?: Record<string, string>;
  keyframeRatios?: Record<string, string>;
  imageRatios?: Record<string, string>;
  aspectParam?: 'ratio';
  resolutionParam?: boolean;
  resolutionValues?: Record<string, string>;
};

type RunwayTask = {
  id: string;
  status: 'PENDING' | 'THROTTLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'CANCELED';
  progress?: number;
  output?: string[];
  failure?: string;
  failureCode?: string | null;
  cost?: { credits?: number };
  estimatedCost?: { credits?: number };
};

const REFERENCE_FIELD: Record<string, 'references' | 'promptImage'> = {
  'gemini_omni_flash_1.1': 'references',
  seedance2_5: 'promptImage',
};

export class RunwayProvider extends BaseVideoProvider {
  readonly key = 'runway' as const;
  readonly displayName = 'Runway';

  constructor(apiKey: string | undefined, fetchImpl?: HttpFetch, private readonly baseUrl = RUNWAY_BASE_URL) {
    super(apiKey, fetchImpl);
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'X-Runway-Version': RUNWAY_API_VERSION,
      'Content-Type': 'application/json',
    };
  }

  buildPayload(req: ProviderVideoRequest): { url: string; body: Record<string, unknown> } {
    const opts = (req.model.providerOptions ?? {}) as RunwayOptions;
    const endpoint = opts.endpoints?.[req.mode];
    if (!endpoint) throw new ProviderError({ code: 'invalid_request', message: `${req.model.displayName} has no endpoint for ${req.mode}`, retryable: false, providerRefunds: true });
    const modelId = req.model.providerModelId;
    const c = req.model.capabilities;
    const body: Record<string, unknown> = { model: modelId, promptText: req.prompt, duration: req.durationSec };

    const keyframes = req.mode === 'image-to-video' || req.mode === 'first-last-frame';
    if (keyframes) {
      body.promptImage = req.endImage
        ? [
            { uri: req.image, position: 'first' },
            { uri: req.endImage, position: 'last' },
          ]
        : req.image;
    }
    if (req.mode === 'reference-to-video' && req.references?.length) {
      const field = REFERENCE_FIELD[modelId] ?? 'references';
      body[field] = req.references.map((uri) => ({ uri }));
    }

    // Aspect ratio / resolution parameters differ per model family.
    const aspectKey = `${req.aspectRatio}@${req.resolution}`;
    if (opts.aspectParam === 'ratio') {
      if (!(keyframes && c.aspectFollowsImage)) body.ratio = req.aspectRatio;
      if (opts.resolutionValues) body.resolution = opts.resolutionValues[req.resolution] ?? req.resolution;
      else if (opts.resolutionParam) body.resolution = req.resolution;
    } else if (req.mode === 'first-last-frame' && opts.keyframeRatios?.[req.resolution]) {
      body.ratio = opts.keyframeRatios[req.resolution];
    } else if (keyframes && opts.imageRatios?.[req.resolution]) {
      body.ratio = opts.imageRatios[req.resolution];
    } else if (opts.ratios?.[aspectKey]) {
      body.ratio = opts.ratios[aspectKey];
    }

    if (c.nativeAudio !== 'none') body.audio = req.audio;
    if (req.speechAudio && c.referenceAudio) {
      // Lip-sync: the picture follows the recorded line; no generated voice on top of it.
      body.referenceAudio = [{ type: 'audio', uri: req.speechAudio }];
      // Audio cannot be combined with a first-frame keyframe: the keyframe becomes an (unpositioned)
      // reference image — the look of the person and the place — and the ratio is set explicitly.
      const anchored = typeof body.promptImage === 'string';
      if (anchored) {
        body.promptImage = [{ uri: body.promptImage }];
        if (opts.aspectParam === 'ratio' && !body.ratio) body.ratio = req.aspectRatio;
      }
      body.promptText = `${req.prompt}\n\n${anchored ? 'The person and the setting look exactly as in the reference image. ' : ''}The speaking character says exactly the words of @Audio1, with natural lip and jaw movement precisely in sync with @Audio1 from the first frame. No other speech.`.slice(0, c.maxPromptChars);
      if (c.nativeAudio !== 'none') body.audio = false;
    }
    if (c.negativePrompt && req.negativePrompt) body.negativePrompt = req.negativePrompt;
    if (c.seed && req.seed !== undefined) body.seed = req.seed;
    if (req.draft && c.draftMode) body.draft = true;

    return { url: `${this.baseUrl}/v1/${endpoint}`, body };
  }

  async submitGeneration(req: ProviderVideoRequest, ctx: SubmitContext): Promise<SubmitResult> {
    this.assertValid(req);
    const { url, body } = this.buildPayload(req);
    try {
      const res = await requestJson<{ id: string; estimatedCost?: { credits?: number } }>(this.fetchImpl, url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      if (!res?.id) throw new ProviderError({ code: 'unknown', message: 'Runway did not return a task id', retryable: false, providerRefunds: true });
      return {
        externalId: res.id,
        raw: res,
        estimatedCostUsd: res.estimatedCost?.credits !== undefined ? res.estimatedCost.credits * USD_PER_CREDIT : undefined,
      };
    } catch (err) {
      throw new ProviderError(this.normalizeError(err));
    }
  }

  async getGenerationStatus(externalId: string): Promise<ProviderStatus> {
    let task: RunwayTask;
    try {
      task = await requestJson<RunwayTask>(this.fetchImpl, `${this.baseUrl}/v1/tasks/${encodeURIComponent(externalId)}`, { headers: this.headers() });
    } catch (err) {
      throw new ProviderError(this.normalizeError(err));
    }
    const costUsd = task.cost?.credits !== undefined ? task.cost.credits * USD_PER_CREDIT : undefined;
    switch (task.status) {
      case 'PENDING':
        return { state: 'queued', progress: task.progress, note: 'Queued at Runway — starting shortly', raw: task };
      case 'THROTTLED':
        // Runway limits how many tasks an account runs at once; extra tasks wait (no extra charge).
        return { state: 'queued', note: 'Waiting in Runway’s queue — your Runway plan renders one video per model at a time, so it starts as soon as the previous one finishes. No extra charge.', raw: task };
      case 'RUNNING':
        return { state: 'running', progress: task.progress, note: 'Rendering at Runway', raw: task };
      case 'SUCCEEDED':
        return { state: 'succeeded', progress: 1, outputs: (task.output ?? []).map((url) => ({ url, mimeType: 'video/mp4' })), costUsd, raw: task };
      case 'CANCELLED':
      case 'CANCELED':
        return { state: 'cancelled', costUsd, raw: task };
      case 'FAILED':
      default:
        return { state: 'failed', error: this.mapFailureCode(task.failureCode ?? null, task.failure), costUsd, raw: task };
    }
  }

  /** Map Runway `failureCode` (see /errors/task-failures/) to our error model. */
  mapFailureCode(code: string | null, failure?: string): NormalizedError {
    const message = failure ?? 'Runway task failed';
    const c = code ?? 'INTERNAL';
    if (c.startsWith('SAFETY.INPUT')) return { code: 'content_policy', message: 'The prompt or input was rejected by content moderation.', retryable: false, providerRefunds: false, providerCode: c };
    if (c.startsWith('SAFETY.OUTPUT')) return { code: 'content_policy', message: 'The generated output was rejected by content moderation.', retryable: false, providerRefunds: true, providerCode: c };
    if (c === 'INPUT_PREPROCESSING.SAFETY.TEXT') return { code: 'content_policy', message: 'The prompt text was rejected by content moderation.', retryable: false, providerRefunds: true, providerCode: c };
    if (c.startsWith('INTERNAL.BAD_OUTPUT')) return { code: 'bad_output', message: 'The model produced an unusable result. Avoid logos or overlaid text in inputs.', retryable: true, providerRefunds: true, providerCode: c };
    if (c === 'ASSET.INVALID') return { code: 'invalid_request', message: 'An input image or video was not accepted (size, format or duration).', retryable: false, providerRefunds: true, providerCode: c };
    if (c === 'THIRD_PARTY.UNAVAILABLE') return { code: 'provider_unavailable', message: 'The upstream model is temporarily unavailable.', retryable: true, providerRefunds: true, providerCode: c };
    return { code: 'provider_unavailable', message, retryable: true, providerRefunds: true, providerCode: c };
  }

  async cancelGeneration(externalId: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/tasks/${encodeURIComponent(externalId)}`, { method: 'DELETE', headers: this.headers() });
      return res.ok || res.status === 204;
    } catch {
      return false;
    }
  }

  async checkCredentials(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey) return { ok: false, message: 'RUNWAYML_API_SECRET is not set' };
    try {
      // Organization endpoint returns credit balance and tier without generating anything.
      const org = await requestJson<{ creditBalance?: number }>(this.fetchImpl, `${this.baseUrl}/v1/organization`, { headers: this.headers() });
      return { ok: true, message: `Authenticated. Credit balance: ${org?.creditBalance ?? 'unknown'}` };
    } catch (err) {
      const e = err instanceof ProviderHttpError ? `HTTP ${err.status}` : (err as Error).message;
      return { ok: false, message: `Runway credential check failed: ${e}` };
    }
  }

  getModel(modelKey: string): CatalogVideoModel | undefined {
    return this.getSupportedModels().find((m) => m.key === modelKey);
  }
}
