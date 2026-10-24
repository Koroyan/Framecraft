import type { AspectRatio } from '@framecraft/shared';
import { IMAGE_MODELS } from '../../catalog/media-models';
import { requestJson } from '../video/base';
import { RUNWAY_API_VERSION, RUNWAY_BASE_URL } from '../video/runway';
import { ProviderError, type HttpFetch } from '../video/types';

/**
 * Image generation for storyboards, character sheets and first frames.
 * fal.ai FLUX schnell (cheapest drafts) and Runway text_to_image (reference-aware).
 */
export type ImageRequest = { prompt: string; aspectRatio: AspectRatio; references?: string[]; modelKey?: string };
export type ImageResult = { url: string; modelKey: string; costUsd: number };

const FAL_SIZES: Record<AspectRatio, string> = { '9:16': 'portrait_16_9', '16:9': 'landscape_16_9', '1:1': 'square_hd', '4:5': 'portrait_4_3' };
// Runway muse_image ratio values (documented list).
const MUSE_RATIOS: Record<AspectRatio, string> = { '9:16': '1152:2016', '16:9': '2016:1152', '1:1': '1600:1600', '4:5': '1344:1792' };

/** muse_image rejects `tag` on reference images (validated 2026-10-25); gen4 image models take one per image. */
const runwayReferences = (modelId: string, uris: string[]) => uris.map((uri, i) => (modelId.startsWith('muse') ? { uri } : { uri, tag: `ref${i + 1}` }));

export class ImageService {
  constructor(
    private readonly keys: { fal?: string; runway?: string },
    private readonly fetchImpl: HttpFetch = fetch,
  ) {}

  available(): boolean {
    return Boolean(this.keys.fal || this.keys.runway);
  }

  /** Cheapest configured model that supports the request (references need a reference-aware model). */
  pickModel(needsReferences: boolean, preferred?: string): string | undefined {
    const usable = IMAGE_MODELS.filter(
      (m) => m.status === 'active' && ((m.provider === 'fal' && this.keys.fal) || (m.provider === 'runway' && this.keys.runway)) && (!needsReferences || m.maxReferences > 0),
    );
    if (preferred && usable.some((m) => m.key === preferred)) return preferred;
    return usable.filter((m) => !m.requiresReferences || needsReferences).sort((a, b) => a.usdPerImage - b.usdPerImage)[0]?.key;
  }

  private runwayHeaders() {
    return { Authorization: `Bearer ${this.keys.runway}`, 'X-Runway-Version': RUNWAY_API_VERSION, 'Content-Type': 'application/json' };
  }

  /**
   * Non-blocking start: fal returns the image directly; Runway returns a task id to poll with
   * `check` (so a worker slot is never held while the provider queue is busy).
   */
  async start(req: ImageRequest): Promise<{ modelKey: string; costUsd: number; url?: string; taskId?: string }> {
    const key = this.pickModel(Boolean(req.references?.length), req.modelKey);
    if (!key) throw new ProviderError({ code: 'auth', message: 'No image provider configured (FAL_KEY or RUNWAYML_API_SECRET)', retryable: false, providerRefunds: true });
    const model = IMAGE_MODELS.find((m) => m.key === key)!;
    if (model.provider === 'fal') return { ...(await this.generate({ ...req, modelKey: key })), modelKey: key };
    const body: Record<string, unknown> = { model: model.providerModelId, promptText: req.prompt.slice(0, 1000), ratio: MUSE_RATIOS[req.aspectRatio] };
    if (req.references?.length) body.referenceImages = runwayReferences(model.providerModelId, req.references.slice(0, model.maxReferences));
    const task = await requestJson<{ id: string }>(this.fetchImpl, `${RUNWAY_BASE_URL}/v1/text_to_image`, { method: 'POST', headers: this.runwayHeaders(), body: JSON.stringify(body) });
    return { modelKey: key, costUsd: model.usdPerImage, taskId: task.id };
  }

  async check(taskId: string): Promise<{ state: 'waiting' | 'running' | 'succeeded' | 'failed'; url?: string; note?: string; error?: string }> {
    const t = await requestJson<{ status: string; output?: string[]; failure?: string }>(this.fetchImpl, `${RUNWAY_BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}`, { headers: this.runwayHeaders() });
    if (t.status === 'SUCCEEDED' && t.output?.[0]) return { state: 'succeeded', url: t.output[0] };
    if (t.status === 'FAILED' || t.status === 'CANCELLED' || t.status === 'CANCELED') return { state: 'failed', error: t.failure ?? 'Image generation failed' };
    if (t.status === 'THROTTLED') return { state: 'waiting', note: 'Waiting in Runway’s queue — starts automatically, no extra charge' };
    return { state: t.status === 'RUNNING' ? 'running' : 'waiting', note: t.status === 'RUNNING' ? 'Rendering at Runway' : 'Queued at Runway' };
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    const key = this.pickModel(Boolean(req.references?.length), req.modelKey);
    if (!key) throw new ProviderError({ code: 'auth', message: 'No image provider configured (FAL_KEY or RUNWAYML_API_SECRET)', retryable: false, providerRefunds: true });
    const model = IMAGE_MODELS.find((m) => m.key === key)!;
    if (model.provider === 'fal') {
      const res = await requestJson<{ images?: { url: string }[] }>(this.fetchImpl, `https://fal.run/${model.providerModelId}`, {
        method: 'POST',
        headers: { Authorization: `Key ${this.keys.fal}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: req.prompt, image_size: FAL_SIZES[req.aspectRatio], num_images: 1, output_format: 'jpeg', enable_safety_checker: true }),
        timeoutMs: 120_000,
      });
      const url = res.images?.[0]?.url;
      if (!url) throw new ProviderError({ code: 'bad_output', message: 'Image model returned no image', retryable: true, providerRefunds: false });
      return { url, modelKey: key, costUsd: model.usdPerImage };
    }
    // Runway: task-based.
    const headers = { Authorization: `Bearer ${this.keys.runway}`, 'X-Runway-Version': RUNWAY_API_VERSION, 'Content-Type': 'application/json' };
    const body: Record<string, unknown> = { model: model.providerModelId, promptText: req.prompt.slice(0, 1000), ratio: MUSE_RATIOS[req.aspectRatio] };
    if (req.references?.length) body.referenceImages = runwayReferences(model.providerModelId, req.references.slice(0, model.maxReferences));
    const task = await requestJson<{ id: string }>(this.fetchImpl, `${RUNWAY_BASE_URL}/v1/text_to_image`, { method: 'POST', headers, body: JSON.stringify(body) });
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const t = await requestJson<{ status: string; output?: string[]; failure?: string }>(this.fetchImpl, `${RUNWAY_BASE_URL}/v1/tasks/${task.id}`, { headers });
      if (t.status === 'SUCCEEDED' && t.output?.[0]) return { url: t.output[0], modelKey: key, costUsd: model.usdPerImage };
      if (t.status === 'FAILED' || t.status === 'CANCELLED') throw new ProviderError({ code: 'bad_output', message: t.failure ?? 'Image generation failed', retryable: true, providerRefunds: true });
    }
    throw new ProviderError({ code: 'timeout', message: 'Image generation timed out', retryable: true, providerRefunds: true });
  }
}
