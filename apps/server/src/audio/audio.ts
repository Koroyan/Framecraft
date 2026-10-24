import crypto from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { assets, generationJobs } from '../db/schema';
import { chooseTtsModel, DEFAULT_VOICES, estimateTtsUsd } from '../providers/audio/elevenlabs';
import { AUDIO_MODELS } from '../catalog/media-models';
import { reserveCredits, settleReservation } from '../billing/wallet';
import { quoteCredits } from '../pricing/pricing';
import { getConfig } from '../services/admin-config';
import { recordProviderSpend } from '../services/common';
import { downloadAssetToTemp, getOwnedAsset, storeBuffer } from '../services/assets';
import { enqueue, type JobResult, type QueueJob } from '../queue/queue';
import { ProviderError, ProviderHttpError } from '../providers/video/types';
import { wordsToCues } from '../media/subtitles';
import { badRequest, configurationRequired } from '../lib/errors';
import type { SessionLike } from '../generation/service';
import fsp from 'node:fs/promises';

export type AudioJobInput =
  | { kind: 'tts'; text: string; voiceId?: string; language: string; quality?: 'standard' | 'high'; projectId?: string; idempotencyKey: string; /** Record a new take instead of reusing an identical one. */ fresh?: boolean }
  | { kind: 'music'; prompt: string; durationSec: number; projectId?: string; idempotencyKey: string }
  | { kind: 'sfx'; prompt: string; durationSec?: number; projectId?: string; idempotencyKey: string }
  | { kind: 'transcribe'; assetId: string; language?: string; projectId?: string; idempotencyKey: string };

function estimateUsd(input: AudioJobInput, mediaDurationSec = 0): { usd: number; model: string } {
  switch (input.kind) {
    case 'tts': {
      const model = chooseTtsModel(input.language, input.quality);
      return { usd: estimateTtsUsd(input.text, model), model };
    }
    case 'music':
      return { usd: (AUDIO_MODELS.find((m) => m.task === 'music')!.usdPerUnit * Math.max(input.durationSec, 10)) / 60, model: 'music_v2_5' };
    case 'sfx':
      // Conservative: one-minute minimum while the per-generation vs per-minute pricing is unresolved.
      return { usd: AUDIO_MODELS.find((m) => m.task === 'sfx')!.usdPerUnit, model: 'eleven_text_to_sound_v2' };
    case 'transcribe':
      return { usd: (0.22 * Math.max(mediaDurationSec, 60)) / 3600, model: 'scribe_v2' };
  }
}

/** Identical narration (same text, voice, model, language) is generated once and reused. */
export function ttsCacheKey(text: string, voiceId: string, model: string, language: string) {
  return crypto.createHash('sha256').update([text.trim(), voiceId, model, language].join('\u0000')).digest('hex');
}

export async function estimateAudio(ctx: AppContext, user: SessionLike, input: AudioJobInput) {
  let mediaDuration = 0;
  if (input.kind === 'transcribe') mediaDuration = ((await getOwnedAsset(ctx, user.id, input.assetId)).durationMs ?? 0) / 1000;
  const { usd, model } = estimateUsd(input, mediaDuration);
  const rules = await getConfig(ctx.db, 'pricing');
  const q = quoteCredits(usd, 0, input.kind === 'sfx' ? 'partial' : 'verified', rules);
  return { credits: q.credits, providerCostUsd: q.providerCostUsd, model, available: ctx.liveEnabled && ctx.audio.isConfigured() };
}

/** `link` attaches the job to a film (dialogue dubbing): the film continues when it finishes. */
export async function createAudioJob(ctx: AppContext, user: SessionLike, input: AudioJobInput, link: { parentJobId?: string; shotId?: string } = {}) {
  const [existing] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.userId, user.id), eq(generationJobs.idempotencyKey, input.idempotencyKey)));
  if (existing) return { job: existing, reused: false };
  if (input.kind === 'tts' && !input.text.trim()) throw badRequest('Text is required');

  // Reuse an identical narration the user already paid for.
  if (input.kind === 'tts' && !input.fresh) {
    const model = chooseTtsModel(input.language, input.quality);
    const voice = input.voiceId ?? DEFAULT_VOICES[0]!.id;
    const key = ttsCacheKey(input.text, voice, model, input.language);
    // The newest take wins (a shot may have been re-voiced since the first recording).
    const [cached] = await ctx.db
      .select()
      .from(assets)
      .where(and(eq(assets.userId, user.id), sql`${assets.source}->>'cacheKey' = ${key}`, sql`${assets.deletedAt} is null`))
      .orderBy(desc(assets.createdAt))
      .limit(1);
    if (cached) {
      const [job] = await ctx.db
        .insert(generationJobs)
        .values({ userId: user.id, projectId: input.projectId, ...link, kind: 'audio', status: 'completed', phase: 'Reused existing narration (no charge)', request: input, idempotencyKey: input.idempotencyKey, outputAssetId: cached.id, chargedCredits: 0, completedAt: new Date(), progress: 1 })
        .returning();
      return { job: job!, reused: true };
    }
  }

  const est = await estimateAudio(ctx, user, input);
  if (!est.available) throw configurationRequired('Audio generation needs ELEVENLABS_API_KEY and LIVE_GENERATION_ENABLED=true.');
  const job = await ctx.db.transaction(async (tx) => {
    const [j] = await tx
      .insert(generationJobs)
      .values({ userId: user.id, projectId: input.projectId, ...link, kind: 'audio', status: 'queued', phase: 'Waiting in queue', request: input, modelKey: `elevenlabs:${est.model}`, providerKey: 'elevenlabs', estimatedCredits: est.credits, estimatedCostUsd: est.providerCostUsd, idempotencyKey: input.idempotencyKey })
      .returning();
    const r = await reserveCredits(tx as never, { userId: user.id, amount: est.credits, jobId: j!.id, description: `Audio: ${input.kind}`, idempotencyKey: `reserve:${j!.id}` });
    await tx.update(generationJobs).set({ reservationId: r.reservationId }).where(eq(generationJobs.id, j!.id));
    await enqueue(tx as never, 'audio.run', { jobId: j!.id }, { queue: 'generation', dedupeKey: `audio:${j!.id}`, maxAttempts: 3 });
    return j!;
  });
  return { job, reused: false };
}

/** ElevenLabs answers 429 when the account's concurrent-request limit is reached: wait and retry. */
const BUSY_RETRIES = 8;
const isBusy = (err: unknown) => (err instanceof ProviderHttpError && (err.status === 429 || err.status >= 500)) || (err instanceof ProviderError && err.normalized.retryable && err.normalized.code !== 'auth');

export async function runAudioJob(ctx: AppContext, qj: QueueJob): Promise<JobResult> {
  const [job] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, String(qj.payload.jobId)));
  if (!job || job.status !== 'queued') return;
  const input = job.request as unknown as AudioJobInput;
  const set = (patch: Partial<typeof generationJobs.$inferInsert>) => ctx.db.update(generationJobs).set({ ...patch, updatedAt: new Date() }).where(eq(generationJobs.id, job.id));
  await set({ status: 'generating', phase: input.kind === 'transcribe' ? 'Transcribing speech' : 'Generating audio', startedAt: job.startedAt ?? new Date() });
  try {
    let outputAssetId: string | undefined;
    let result: Record<string, unknown> = {};
    const model = job.modelKey!.split(':')[1]!;
    if (input.kind === 'transcribe') {
      const src = await getOwnedAsset(ctx, job.userId, input.assetId);
      const file = await downloadAssetToTemp(ctx, src);
      try {
        const t = await ctx.audio.transcribe({ audio: await fsp.readFile(file), filename: `media${src.mimeType.includes('video') ? '.mp4' : '.mp3'}`, language: input.language });
        result = { text: t.text, language: t.language, cues: wordsToCues(t.words) };
      } finally {
        await fsp.rm(file, { force: true });
      }
    } else {
      let data: Buffer;
      let source: Record<string, unknown> = { jobId: job.id, model, aiGenerated: true, kind: input.kind };
      if (input.kind === 'tts') {
        const voice = input.voiceId ?? DEFAULT_VOICES[0]!.id;
        const tts = await ctx.audio.textToSpeechTimed({ text: input.text, voiceId: voice, modelId: model, language: input.language });
        data = tts.audio;
        // Word timings travel with the recording (also when it is reused) to time the subtitles.
        source = { ...source, cacheKey: ttsCacheKey(input.text, voice, model, input.language), voiceId: voice, language: input.language, words: tts.words };
        result = { words: tts.words };
      } else if (input.kind === 'music') {
        data = await ctx.audio.music({ prompt: input.prompt, lengthSec: input.durationSec });
        source = { ...source, license: 'Subject to the ElevenLabs plan terms of the operator account' };
      } else {
        data = await ctx.audio.soundEffect({ text: input.prompt, durationSec: input.durationSec });
      }
      const asset = await storeBuffer(ctx, { userId: job.userId, projectId: job.projectId, kind: 'audio', mediaType: 'audio', data, ext: '.mp3', mimeType: 'audio/mpeg', source, makeThumbnail: false });
      outputAssetId = asset.id;
    }
    await recordProviderSpend(ctx.db, 'elevenlabs', job.estimatedCostUsd);
    const charged = (await settleReservation(ctx.db, { reservationId: job.reservationId!, chargeAmount: job.estimatedCredits, description: `Audio (${input.kind})` })).charged;
    await set({ status: 'completed', phase: 'Completed', outputAssetId, chargedCredits: charged, actualCostUsd: job.estimatedCostUsd, completedAt: new Date(), progress: 1, checkpoint: result });
  } catch (err) {
    if (isBusy(err) && job.attempts < BUSY_RETRIES) {
      // Back off (5s, 10s, 20s … capped at 60s) with jitter so a batch of lines doesn't retry in lockstep.
      const waitMs = Math.min(60_000, 5_000 * 2 ** job.attempts) + Math.floor(Math.random() * 3_000);
      await set({ status: 'queued', attempts: job.attempts + 1, phase: `ElevenLabs is busy — retrying in ${Math.round(waitMs / 1000)}s (no extra charge)` });
      return { rescheduleMs: waitMs };
    }
    await settleReservation(ctx.db, { reservationId: job.reservationId!, chargeAmount: 0, description: 'Audio generation failed — credits returned' });
    await set({ status: 'failed', phase: 'Failed', error: { code: 'audio_failed', message: (err as Error).message.slice(0, 300), retryable: true }, completedAt: new Date() });
  }
  if (job.parentJobId) await enqueue(ctx.db, 'movie.check', { movieJobId: job.parentJobId }, { queue: 'generation', dedupeKey: `movie-check:${job.parentJobId}:${job.id}` });
}
