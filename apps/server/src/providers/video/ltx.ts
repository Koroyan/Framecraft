import type { AspectRatio, Resolution } from '@framecraft/shared';
import { BaseVideoProvider, requestJson } from './base';
import { ProviderError, type HttpFetch, type ProviderStatus, type ProviderVideoRequest, type SubmitContext, type SubmitResult } from './types';

/**
 * LTX API adapter (direct).
 * Docs: https://docs.ltx.io/ — async jobs: POST /v2/{text-to-video|image-to-video} → 202 { id },
 * poll GET /v2/{endpoint}/{id} → { status: pending|processing|completed|failed, result.video_url }.
 * Auth: `Authorization: Bearer <key>` (examples use $LTX_API_KEY).
 */
export const LTX_BASE_URL = 'https://api.ltx.io';

const DIMENSIONS: Record<string, Partial<Record<AspectRatio, string>>> = {
  '720p': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '720x720' },
  '1080p': { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1080x1080' },
  '1440p': { '16:9': '2560x1440', '9:16': '1440x2560', '1:1': '1440x1440' },
  '4k': { '16:9': '3840x2160', '9:16': '2160x3840', '1:1': '2160x2160' },
};

/** Framecraft camera presets that map onto LTX's real `camera_motion` parameter. */
const CAMERA_MAP: Record<string, string> = {
  dolly_in: 'dolly_in',
  dolly_out: 'dolly_out',
  crane: 'jib_up',
  static: 'static',
};

type LtxJob = {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: { video_url?: string };
  error?: { message?: string; type?: string };
};

export class LtxProvider extends BaseVideoProvider {
  readonly key = 'ltx' as const;
  readonly displayName = 'LTX';

  constructor(apiKey: string | undefined, fetchImpl?: HttpFetch, private readonly baseUrl = LTX_BASE_URL) {
    super(apiKey, fetchImpl);
  }

  private headers() {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  static resolutionString(aspect: AspectRatio, resolution: Resolution): string | undefined {
    return DIMENSIONS[resolution]?.[aspect];
  }

  /** Camera preset → API parameter; returns undefined when the preset must stay in the prompt. */
  static cameraMotion(camera?: string): string | undefined {
    return camera ? CAMERA_MAP[camera] : undefined;
  }

  buildPayload(req: ProviderVideoRequest): { url: string; body: Record<string, unknown> } {
    const endpoint = req.mode === 'text-to-video' ? 'text-to-video' : 'image-to-video';
    const resolution = LtxProvider.resolutionString(req.aspectRatio, req.resolution);
    if (!resolution) throw new ProviderError({ code: 'invalid_request', message: `LTX has no ${req.aspectRatio} at ${req.resolution}`, retryable: false, providerRefunds: true });
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      model: req.model.providerModelId,
      // `duration` must be present; LTX rejects it together with last_frame_uri, so it is null then.
      duration: req.endImage ? null : req.durationSec,
      resolution,
      fps: 24,
      generate_audio: req.audio,
    };
    const motion = LtxProvider.cameraMotion(req.camera);
    if (motion && req.model.capabilities.cameraControl?.includes(motion)) body.camera_motion = motion;
    if (endpoint === 'image-to-video') {
      body.image_uri = req.image;
      if (req.endImage) body.last_frame_uri = req.endImage;
    }
    return { url: `${this.baseUrl}/v2/${endpoint}`, body };
  }

  async submitGeneration(req: ProviderVideoRequest, ctx: SubmitContext): Promise<SubmitResult> {
    this.assertValid(req);
    const { url, body } = this.buildPayload(req);
    try {
      const res = await requestJson<{ id: string }>(this.fetchImpl, url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ctx.signal });
      if (!res?.id) throw new ProviderError({ code: 'unknown', message: 'LTX did not return a job id', retryable: false, providerRefunds: true });
      const endpoint = url.endsWith('text-to-video') ? 'text-to-video' : 'image-to-video';
      // The status URL needs the endpoint, so it is encoded into the external id.
      return { externalId: `${endpoint}:${res.id}`, raw: res };
    } catch (err) {
      throw new ProviderError(this.normalizeError(err));
    }
  }

  async getGenerationStatus(externalId: string): Promise<ProviderStatus> {
    const [endpoint, id] = externalId.includes(':') ? (externalId.split(':', 2) as [string, string]) : ['text-to-video', externalId];
    let job: LtxJob;
    try {
      job = await requestJson<LtxJob>(this.fetchImpl, `${this.baseUrl}/v2/${endpoint}/${encodeURIComponent(id)}`, { headers: this.headers() });
    } catch (err) {
      throw new ProviderError(this.normalizeError(err));
    }
    switch (job.status) {
      case 'pending':
        return { state: 'queued', raw: job };
      case 'processing':
        return { state: 'running', raw: job };
      case 'completed':
        if (!job.result?.video_url) return { state: 'failed', error: { code: 'bad_output', message: 'LTX completed without a video URL', retryable: true, providerRefunds: false }, raw: job };
        return { state: 'succeeded', outputs: [{ url: job.result.video_url, mimeType: 'video/mp4' }], raw: job };
      default: {
        const msg = job.error?.message ?? 'LTX job failed';
        const policy = /safety|moderat|policy/i.test(msg + (job.error?.type ?? ''));
        return {
          state: 'failed',
          error: { code: policy ? 'content_policy' : 'provider_unavailable', message: msg, retryable: !policy, providerRefunds: true, providerCode: job.error?.type },
          raw: job,
        };
      }
    }
  }
}
