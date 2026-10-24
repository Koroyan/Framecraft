import { requestJson } from './base';
import { RUNWAY_API_VERSION, RUNWAY_BASE_URL } from './runway';
import type { HttpFetch } from './types';

/**
 * Runway video-to-video editing (model `aleph2`, POST /v1/video_to_video).
 *
 * Request shape validated against Runway's OpenAPI spec on 2026-10-25: `videoUri` (≤30 s; https URL
 * or data URI ≤5 MB), `promptText` (≤1000 chars), optional `keyframes` (≤5 guidance images, each at
 * `seconds` from the input start, optionally with a whole-second `range` edit window),
 * `targetAspectRatio` (outpaint), `seed`. It takes no mask and no reference images — masking is
 * done locally by compositing the result (see editing/localize.ts).
 * Price: 28 credits ($0.28) per second, 56 credit minimum (docs.dev.runwayml.com/guides/pricing).
 */
export const ALEPH = {
  modelKey: 'runway:aleph2',
  usdPerSecond: 0.28,
  minUsd: 0.56,
  maxInputSec: 30,
  maxInlineBytes: 5 * 1024 * 1024,
  maxPromptChars: 1000,
  maxKeyframes: 5,
  aspectRatios: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '21:9'] as const,
};

export type AlephKeyframe = { uri: string; seconds: number; range?: { start_seconds: number; end_seconds: number } };

export class RunwayVideoEditor {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: HttpFetch,
  ) {}

  isConfigured() {
    return Boolean(this.apiKey);
  }

  private headers() {
    return { Authorization: `Bearer ${this.apiKey}`, 'X-Runway-Version': RUNWAY_API_VERSION, 'Content-Type': 'application/json' };
  }

  async submit(p: { videoUri: string; promptText: string; keyframes?: AlephKeyframe[]; targetAspectRatio?: string; seed?: number }): Promise<{ taskId: string }> {
    const body: Record<string, unknown> = { model: 'aleph2', videoUri: p.videoUri, promptText: p.promptText.slice(0, ALEPH.maxPromptChars) };
    if (p.keyframes?.length) body.keyframes = p.keyframes.slice(0, ALEPH.maxKeyframes);
    if (p.targetAspectRatio) body.targetAspectRatio = p.targetAspectRatio;
    if (p.seed !== undefined) body.seed = p.seed;
    const r = await requestJson<{ id: string }>(this.fetchImpl, `${RUNWAY_BASE_URL}/v1/video_to_video`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), timeoutMs: 120_000 });
    return { taskId: r.id };
  }

  async status(taskId: string): Promise<{ state: 'waiting' | 'running' | 'succeeded' | 'failed'; progress?: number; url?: string; error?: string; note?: string }> {
    const t = await requestJson<{ status: string; progress?: number; output?: string[]; failure?: string; failureCode?: string }>(this.fetchImpl, `${RUNWAY_BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}`, { headers: this.headers() });
    if (t.status === 'SUCCEEDED' && t.output?.[0]) return { state: 'succeeded', url: t.output[0] };
    if (t.status === 'FAILED' || t.status === 'CANCELLED') return { state: 'failed', error: t.failure ?? t.failureCode ?? 'The edit failed at Runway' };
    if (t.status === 'THROTTLED') return { state: 'waiting', note: 'Waiting in Runway’s queue — starts automatically, no extra charge' };
    if (t.status === 'RUNNING') return { state: 'running', progress: t.progress, note: 'Editing at Runway' };
    return { state: 'waiting', note: 'Queued at Runway' };
  }
}
