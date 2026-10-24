import fsp from 'node:fs/promises';
import { and, eq, sql } from 'drizzle-orm';
import { ASPECT_DIMENSIONS, type AspectRatio } from '@framecraft/shared';
import type { AppContext } from '../context';
import { characterReferences, generationJobs, shots } from '../db/schema';
import { IMAGE_MODELS } from '../catalog/media-models';
import { generatePlaceholderImage } from '../media/ffmpeg';
import { fetchProviderOutput, getOwnedAsset, providerInputUrl, storeAsset, tmpFile } from '../services/assets';
import { reserveCredits, settleReservation } from '../billing/wallet';
import { quoteCredits } from '../pricing/pricing';
import { getConfig } from '../services/admin-config';
import { recordProviderSpend } from '../services/common';
import { enqueue, type JobResult, type QueueJob } from '../queue/queue';
import { configurationRequired } from '../lib/errors';
import { ProviderHttpError } from '../providers/video/types';
import { httpErrorToNormalized } from '../providers/video/base';
import type { SessionLike } from '../generation/service';

export type ImagePurpose = 'storyboard' | 'character' | 'frame';

export type ImageJobInput = {
  prompt: string;
  aspectRatio: AspectRatio;
  purpose: ImagePurpose;
  referenceAssetIds?: string[];
  projectId?: string;
  shotId?: string;
  characterId?: string;
  idempotencyKey: string;
};

export async function estimateImage(ctx: AppContext, needsRefs: boolean) {
  const key = ctx.liveEnabled ? ctx.images.pickModel(needsRefs) : undefined;
  if (!key) return { available: false as const, credits: 0, modelKey: null };
  const m = IMAGE_MODELS.find((x) => x.key === key)!;
  const rules = await getConfig(ctx.db, 'pricing');
  return { available: true as const, credits: quoteCredits(m.usdPerImage, 0, 'verified', rules).credits, modelKey: key, usd: m.usdPerImage };
}

/**
 * Storyboard frames / character sheets. Without an image provider, development
 * mode produces clearly labelled placeholder frames (free, never presented as AI).
 */
/** `link.parentJobId` attaches the frame to a film job (keyframes): the film continues when it finishes. */
export async function createImageJob(ctx: AppContext, user: SessionLike, input: ImageJobInput, link: { parentJobId?: string } = {}) {
  const [existing] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.userId, user.id), eq(generationJobs.idempotencyKey, input.idempotencyKey)));
  if (existing) return existing;
  for (const id of input.referenceAssetIds ?? []) await getOwnedAsset(ctx, user.id, id);
  const est = await estimateImage(ctx, Boolean(input.referenceAssetIds?.length));
  const fixture = !est.available;
  if (fixture && !ctx.env.devFixturesEnabled) throw configurationRequired('Image generation needs FAL_KEY or RUNWAYML_API_SECRET and LIVE_GENERATION_ENABLED=true.');
  return ctx.db.transaction(async (tx) => {
    const [job] = await tx
      .insert(generationJobs)
      .values({
        userId: user.id,
        projectId: input.projectId,
        shotId: input.shotId,
        parentJobId: link.parentJobId,
        kind: 'image',
        status: 'queued',
        phase: fixture ? 'Creating placeholder frame' : 'Waiting in queue',
        request: input,
        modelKey: est.modelKey,
        providerKey: fixture ? 'fixture' : est.modelKey?.split(':')[0],
        estimatedCredits: est.credits,
        estimatedCostUsd: est.available ? est.usd : 0,
        idempotencyKey: input.idempotencyKey,
        isFixture: fixture,
      })
      .returning();
    if (!fixture && est.credits > 0) {
      const r = await reserveCredits(tx as never, { userId: user.id, amount: est.credits, jobId: job!.id, description: `Image: ${input.purpose}`, idempotencyKey: `reserve:${job!.id}` });
      await tx.update(generationJobs).set({ reservationId: r.reservationId }).where(eq(generationJobs.id, job!.id));
    }
    await enqueue(tx as never, 'image.run', { jobId: job!.id }, { queue: 'generation', dedupeKey: `image:${job!.id}`, maxAttempts: 3 });
    return job!;
  });
}

const IMAGE_TIMEOUT_MS = 30 * 60_000;

/**
 * Re-entrant image job: submit once (task id saved in the checkpoint), then poll by
 * rescheduling — a worker slot is never held while the provider queue is busy, and a
 * restart resumes the same provider task instead of paying for a new one.
 */
export async function runImageJob(ctx: AppContext, qj: QueueJob): Promise<JobResult> {
  const [job] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, String(qj.payload.jobId)));
  if (!job || !['queued', 'generating'].includes(job.status)) return;
  const input = job.request as unknown as ImageJobInput;
  const cp = (job.checkpoint ?? {}) as { taskId?: string; modelKey?: string; costUsd?: number; url?: string };
  const set = (patch: Partial<typeof generationJobs.$inferInsert>) => ctx.db.update(generationJobs).set({ ...patch, updatedAt: new Date() }).where(eq(generationJobs.id, job.id));
  if (job.status === 'queued') await set({ status: 'generating', phase: job.isFixture ? 'Creating placeholder frame' : 'Generating image', startedAt: new Date() });
  const file = tmpFile('.jpg');
  try {
    let costUsd = 0;
    if (job.isFixture) {
      const d = ASPECT_DIMENSIONS[input.aspectRatio]['720p'];
      await generatePlaceholderImage(file, { width: d.width, height: d.height, title: input.prompt.slice(0, 40), subtitle: 'Placeholder frame - not AI generated' });
    } else {
      let url = cp.url;
      if (!url && !cp.taskId) {
        const refs = await Promise.all((input.referenceAssetIds ?? []).map(async (id) => providerInputUrl(ctx, await getOwnedAsset(ctx, job.userId, id))));
        const res = await ctx.images.start({ prompt: input.prompt, aspectRatio: input.aspectRatio, references: refs, modelKey: job.modelKey ?? undefined });
        Object.assign(cp, { taskId: res.taskId, modelKey: res.modelKey, costUsd: res.costUsd, url: res.url });
        await set({ checkpoint: cp });
        await recordProviderSpend(ctx.db, res.modelKey.split(':')[0]!, res.costUsd);
        url = res.url;
        if (!url) return { rescheduleMs: 4000 };
      }
      if (!url) {
        const st = await ctx.images.check(cp.taskId!);
        if (st.state === 'failed') throw new Error(st.error);
        if (st.state !== 'succeeded') {
          if (job.startedAt && Date.now() - job.startedAt.getTime() > IMAGE_TIMEOUT_MS) throw new Error('Image generation timed out at the provider');
          if (st.note && st.note !== job.phase) await set({ phase: st.note });
          return { rescheduleMs: st.state === 'waiting' ? 8000 : 4000 };
        }
        url = st.url!;
      }
      const dl = await fetchProviderOutput(ctx, { url });
      await fsp.rename(dl, file).catch(async () => fsp.copyFile(dl, file));
      costUsd = cp.costUsd ?? 0;
    }
    const asset = await storeAsset(ctx, {
      userId: job.userId,
      projectId: job.projectId,
      kind: input.purpose === 'character' ? 'reference' : 'generated',
      mediaType: 'image',
      filePath: file,
      mimeType: 'image/jpeg',
      isFixture: job.isFixture,
      source: { jobId: job.id, purpose: input.purpose, model: job.modelKey, aiGenerated: !job.isFixture },
      makeThumbnail: false,
    });
    let charged = 0;
    if (job.reservationId) charged = (await settleReservation(ctx.db, { reservationId: job.reservationId, chargeAmount: job.estimatedCredits, description: `Image (${input.purpose})` })).charged;
    // Only a not-yet-generated shot changes status; a shot already queued for video keeps its state.
    if (input.shotId && input.purpose === 'storyboard')
      await ctx.db
        .update(shots)
        .set({ storyboardAssetId: asset.id, status: sql`case when ${shots.status} = 'planned' then 'storyboarded' else ${shots.status} end`, updatedAt: new Date() })
        .where(eq(shots.id, input.shotId));
    if (input.characterId && input.purpose === 'character') await ctx.db.insert(characterReferences).values({ characterId: input.characterId, assetId: asset.id, label: 'AI character sheet' }).onConflictDoNothing();
    await set({ status: 'completed', phase: job.isFixture ? 'Placeholder ready (not AI generated)' : 'Completed', outputAssetId: asset.id, chargedCredits: charged, actualCostUsd: costUsd, completedAt: new Date(), progress: 1 });
  } catch (err) {
    if (job.reservationId) await settleReservation(ctx.db, { reservationId: job.reservationId, chargeAmount: 0, description: 'Image generation failed — credits returned' });
    const message = err instanceof ProviderHttpError ? httpErrorToNormalized(err).message : (err as Error).message;
    ctx.log.warn(`image job ${job.id} failed`, { message });
    await set({ status: 'failed', phase: 'Failed', error: { code: 'image_failed', message: message.slice(0, 300), retryable: true }, completedAt: new Date() });
  } finally {
    await fsp.rm(file, { force: true });
  }
  if (job.parentJobId) await enqueue(ctx.db, 'movie.check', { movieJobId: job.parentJobId }, { queue: 'generation', dedupeKey: `movie-check:${job.parentJobId}:${job.id}` });
}
