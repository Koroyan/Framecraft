import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ASPECT_DIMENSIONS, type AspectRatio } from '@framecraft/shared';
import type { CatalogVideoModel } from '../../catalog/types';
import { generateFixtureClip } from '../../media/ffmpeg';
import { BaseVideoProvider } from './base';
import type { ProviderStatus, ProviderVideoRequest, SubmitContext, SubmitResult } from './types';

/**
 * Development fixture provider.
 *
 * Renders a synthetic FFmpeg test pattern with "DEV FIXTURE - NOT AI GENERATED"
 * burned into every frame, so the full pipeline (queue → provider → storage →
 * validation → editor) can be exercised locally without paid API calls.
 * Jobs that use it are flagged `isFixture` and are never charged.
 * It is impossible to enable in production (see config/env.ts).
 */
export class FixtureProvider extends BaseVideoProvider {
  readonly key = 'fixture' as const;
  readonly displayName = 'Development fixture (not AI)';

  constructor() {
    super('fixture');
  }

  override getSupportedModels(): CatalogVideoModel[] {
    return [];
  }

  override validateRequest(): string[] {
    return [];
  }

  override estimateCost() {
    return { usd: 0, confidence: 'verified' as const };
  }

  buildPayload(req: ProviderVideoRequest) {
    return { url: 'fixture://local', body: { prompt: req.prompt, wouldUse: req.model.key, durationSec: req.durationSec } };
  }

  async submitGeneration(req: ProviderVideoRequest, ctx: SubmitContext): Promise<SubmitResult> {
    const aspect = req.aspectRatio as AspectRatio;
    const dims = ASPECT_DIMENSIONS[aspect]?.['720p'] ?? { width: 720, height: 1280 };
    const out = path.join(os.tmpdir(), `fixture-${crypto.createHash('sha1').update(ctx.idempotencyKey).digest('hex').slice(0, 16)}.mp4`);
    await generateFixtureClip(out, {
      width: dims.width,
      height: dims.height,
      durationSec: Math.max(1, Math.round(req.durationSec)),
      title: req.prompt.slice(0, 42) + (req.prompt.length > 42 ? '…' : ''),
      subtitle: `Would use: ${req.model.displayName}`,
    });
    const immediate: ProviderStatus = { state: 'succeeded', progress: 1, outputs: [{ localPath: out, mimeType: 'video/mp4' }], costUsd: 0 };
    return { externalId: `fixture-${ctx.idempotencyKey}`, raw: { fixture: true }, immediate };
  }

  async getGenerationStatus(): Promise<ProviderStatus> {
    return { state: 'failed', error: { code: 'not_found', message: 'Fixture jobs complete synchronously', retryable: false, providerRefunds: true } };
  }

  static cleanup(p?: string) {
    if (p && p.includes('fixture-')) fs.rm(p, { force: true }, () => undefined);
  }
}
