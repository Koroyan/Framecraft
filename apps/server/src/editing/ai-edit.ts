import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AI_EDIT_MODES, aiEditModeSchema, describeMaskRegion, editMaskSchema, maskIsEmpty, type AiEditMode, type EditMask } from '@framecraft/shared';
import type { AppContext } from '../context';
import { assets, editOperations, generationJobs, shotComments, shotVersions } from '../db/schema';
import { enqueue, type JobResult, type QueueJob } from '../queue/queue';
import { reserveCredits, settleReservation } from '../billing/wallet';
import { quoteCredits } from '../pricing/pricing';
import { getConfig } from '../services/admin-config';
import { notify, recordProviderSpend } from '../services/common';
import { downloadAssetToTemp, fetchProviderOutput, getOwnedAsset, providerInputUrl, storeAsset, type Asset } from '../services/assets';
import { ffmpeg, probe } from '../media/ffmpeg';
import { ProviderHttpError } from '../providers/video/types';
import { httpErrorToNormalized } from '../providers/video/base';
import { ALEPH } from '../providers/video/aleph';
import { badRequest, conflict, configurationRequired, notFound } from '../lib/errors';
import type { SessionLike } from '../generation/service';
import { activateShotVersion, ownedShot, recordShotVersion, syncShotVersions } from './versions';
import { adoptWholeShot, extractWindow, spliceEdit } from './localize';

/*
 * Localized AI editing: take one shot version, edit only the selected time range (and, with a mask,
 * only the selected area) with Runway aleph2, put the result back into the untouched original, and
 * save it as a NEW version for review. The active version — and every other shot — is never changed
 * until the user accepts the result.
 */

export const aiEditRequestSchema = z.object({
  shotId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  mode: aiEditModeSchema,
  instruction: z.string().trim().min(3).max(900),
  startSec: z.number().min(0),
  endSec: z.number().min(0.1),
  mask: editMaskSchema.nullable().optional(),
  /** An edited still to guide the change (frame edit → apply to video). */
  keyframe: z.object({ assetId: z.string().uuid(), atSec: z.number().min(0) }).optional(),
  referenceAssetIds: z.array(z.string().uuid()).max(4).default([]),
  targetAspectRatio: z.enum(ALEPH.aspectRatios).optional(),
  commentId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export type AiEditRequest = z.infer<typeof aiEditRequestSchema>;

/** Temporal context added around the selected range so motion stays continuous at the cut. */
const CONTEXT_SEC = 1;

export function editWindow(mode: AiEditMode, startSec: number, endSec: number, shotSec: number) {
  const whole = AI_EDIT_MODES.find((m) => m.key === mode)!.scope === 'shot';
  if (whole) {
    if (shotSec > ALEPH.maxInputSec) throw badRequest(`This mode edits the whole shot, and the editing model accepts at most ${ALEPH.maxInputSec} s. Split the shot first.`);
    return { whole: true, windowStart: 0, windowEnd: shotSec, rangeStart: 0, rangeEnd: shotSec };
  }
  const rangeStart = Math.max(0, Math.min(startSec, shotSec));
  const rangeEnd = Math.max(rangeStart + 0.1, Math.min(endSec, shotSec));
  let windowStart = Math.max(0, Math.floor(rangeStart) - CONTEXT_SEC);
  let windowEnd = Math.min(shotSec, Math.ceil(rangeEnd) + CONTEXT_SEC);
  // The provider bills at least 2 s — use that much context when the shot has it.
  if (windowEnd - windowStart < 2) {
    windowStart = Math.max(0, windowEnd - 2);
    windowEnd = Math.min(shotSec, windowStart + 2);
  }
  if (windowEnd - windowStart > ALEPH.maxInputSec) throw badRequest(`Select at most ${ALEPH.maxInputSec - 2 * CONTEXT_SEC} s to edit at once.`);
  return { whole: false, windowStart, windowEnd, rangeStart, rangeEnd };
}

function promptFor(mode: AiEditMode, instruction: string, mask: EditMask | null | undefined, refinementOf: string | null): string {
  const verb: Record<AiEditMode, string> = {
    fix: 'Fix this problem',
    replace: 'Replace',
    remove: 'Remove',
    add: 'Add',
    restyle: 'Restyle',
    relight: 'Relight the scene',
    background: 'Replace the background',
    motion: 'Change the motion',
    enhance: 'Improve detail and consistency',
    reframe: 'Extend the frame to the new aspect ratio, continuing the scene naturally',
    camera_remix: 'Show the same moment from a different camera angle',
  };
  const region = mask && !maskIsEmpty(mask) ? describeMaskRegion(mask) : null;
  const parts = [
    `${verb[mode]}: ${instruction.trim().replace(/\.$/, '')}.`,
    region ? `Change only ${region}.` : '',
    refinementOf ? `This refines an earlier edit ("${refinementOf.slice(0, 160)}").` : '',
    mode === 'camera_remix' ? 'Keep the same people, clothing, setting and lighting.' : 'Keep everything else exactly as in the input video: the same people and faces, clothing, background, camera framing and movement, lighting and colours.',
  ];
  return parts.filter(Boolean).join(' ').slice(0, ALEPH.maxPromptChars);
}

async function sourceVersion(ctx: AppContext, user: SessionLike, shotId: string, versionId?: string) {
  const { shot, project } = await ownedShot(ctx, user, shotId);
  await syncShotVersions(ctx, shot.projectId);
  const id = versionId ?? (await ctx.db.select().from(shotVersions).where(eq(shotVersions.shotId, shotId))).find((v) => v.assetId === shot.currentAssetId)?.id;
  if (!id) throw badRequest('Generate this shot before editing it');
  const [version] = await ctx.db.select().from(shotVersions).where(and(eq(shotVersions.id, id), eq(shotVersions.shotId, shotId)));
  if (!version) throw notFound('Version');
  const [asset] = await ctx.db.select().from(assets).where(eq(assets.id, version.assetId));
  if (!asset || asset.mediaType !== 'video') throw badRequest('This version has no video to edit');
  return { shot, project, version, asset: asset as Asset, durationSec: (asset.durationMs ?? 0) / 1000 };
}

export async function estimateAiEdit(ctx: AppContext, user: SessionLike, input: Omit<AiEditRequest, 'idempotencyKey'> & { idempotencyKey?: string }) {
  const src = await sourceVersion(ctx, user, input.shotId, input.versionId);
  const w = editWindow(input.mode, input.startSec, input.endSec, src.durationSec);
  const seconds = Math.round((w.windowEnd - w.windowStart) * 100) / 100;
  const usd = Math.max(ALEPH.minUsd, seconds * ALEPH.usdPerSecond);
  const rules = await getConfig(ctx.db, 'pricing');
  const credits = quoteCredits(usd, seconds, 'verified', rules).credits;
  const live = ctx.liveEnabled && ctx.editor.isConfigured();
  const notes = [
    w.whole ? 'This mode re-renders the whole shot.' : `Only ${(w.rangeEnd - w.rangeStart).toFixed(1)} s of this shot change; ${seconds.toFixed(0)} s (with ${CONTEXT_SEC} s of context each side) are sent to the model.`,
    input.mask && !maskIsEmpty(input.mask) ? 'Outside your selection the original pixels are kept exactly (the result is blended in only inside the mask).' : 'No area selected: the model may change anything inside the time range.',
    'The model is asked to preserve everything else, but it cannot guarantee identical pixels inside the edited area.',
    input.referenceAssetIds?.length ? 'The editing model does not take reference images; attach an edited frame (Edit frame) to guide it visually.' : '',
  ].filter(Boolean);
  return { available: live, fixture: !live && ctx.env.devFixturesEnabled, credits, usd: Math.round(usd * 100) / 100, seconds, model: 'Runway Aleph 2', ...w, notes };
}

export async function createAiEdit(ctx: AppContext, user: SessionLike, input: AiEditRequest) {
  const [existing] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.userId, user.id), eq(generationJobs.idempotencyKey, input.idempotencyKey)));
  if (existing) {
    const [op] = await ctx.db.select().from(editOperations).where(eq(editOperations.generationJobId, existing.id));
    return { operation: op!, job: existing };
  }
  const src = await sourceVersion(ctx, user, input.shotId, input.versionId);
  const est = await estimateAiEdit(ctx, user, input);
  if (!est.available && !est.fixture) throw configurationRequired('AI video editing needs RUNWAYML_API_SECRET and LIVE_GENERATION_ENABLED=true.');
  if (input.keyframe) {
    const kf = await getOwnedAsset(ctx, user.id, input.keyframe.assetId);
    if (kf.mediaType !== 'image') throw badRequest('The guide frame must be an image');
  }
  for (const id of input.referenceAssetIds) await getOwnedAsset(ctx, user.id, id);
  const busy = await ctx.db.select({ id: editOperations.id }).from(editOperations).where(and(eq(editOperations.shotId, input.shotId), eq(editOperations.status, 'processing')));
  if (busy.length >= 2) throw conflict('Two edits of this shot are already running — wait for one to finish.');
  const fixture = !est.available;
  return ctx.db.transaction(async (tx) => {
    const [op] = await tx
      .insert(editOperations)
      .values({
        projectId: src.shot.projectId,
        shotId: src.shot.id,
        userId: user.id,
        sourceVersionId: src.version.id,
        commentId: input.commentId,
        mode: input.mode,
        instruction: input.instruction,
        startSec: est.rangeStart,
        endSec: est.rangeEnd,
        mask: input.mask ?? null,
        referenceAssetIds: input.referenceAssetIds,
        keyframeAssetId: input.keyframe?.assetId,
        keyframeSec: input.keyframe?.atSec,
        params: { windowStart: est.windowStart, windowEnd: est.windowEnd, whole: est.whole, targetAspectRatio: input.targetAspectRatio ?? null },
        status: 'processing',
        estimateCredits: fixture ? 0 : est.credits,
      })
      .returning();
    const [job] = await tx
      .insert(generationJobs)
      .values({
        userId: user.id,
        projectId: src.shot.projectId,
        shotId: src.shot.id,
        kind: 'edit',
        status: 'queued',
        phase: fixture ? 'Preparing a test edit (development fixture — no AI model is called)' : 'Waiting in queue',
        request: { operationId: op!.id },
        modelKey: ALEPH.modelKey,
        providerKey: fixture ? 'fixture' : 'runway',
        estimatedCredits: fixture ? 0 : est.credits,
        estimatedCostUsd: fixture ? 0 : est.usd,
        idempotencyKey: input.idempotencyKey,
        isFixture: fixture,
      })
      .returning();
    if (!fixture) {
      const r = await reserveCredits(tx as never, { userId: user.id, amount: est.credits, jobId: job!.id, description: `AI edit (${input.mode}) of a shot`, idempotencyKey: `reserve:${job!.id}` });
      await tx.update(generationJobs).set({ reservationId: r.reservationId }).where(eq(generationJobs.id, job!.id));
    }
    await tx.update(editOperations).set({ generationJobId: job!.id }).where(eq(editOperations.id, op!.id));
    if (input.commentId) await tx.update(shotComments).set({ status: 'processing', operationId: op!.id, updatedAt: new Date() }).where(and(eq(shotComments.id, input.commentId), eq(shotComments.shotId, input.shotId)));
    await enqueue(tx as never, 'edit.run', { jobId: job!.id }, { queue: 'generation', dedupeKey: `edit:${job!.id}`, maxAttempts: 3 });
    return { operation: { ...op!, generationJobId: job!.id }, job: job! };
  });
}

type EditCheckpoint = { taskId?: string; outputUrl?: string };

/** Re-entrant job: submit once (task id checkpointed), poll by rescheduling, then compose. */
export async function runEditJob(ctx: AppContext, qj: QueueJob): Promise<JobResult> {
  const [job] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, String(qj.payload.jobId)));
  if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return;
  const opId = (job.request as { operationId: string }).operationId;
  const [op] = await ctx.db.select().from(editOperations).where(eq(editOperations.id, opId));
  if (!op) return;
  const cp = { ...(job.checkpoint as EditCheckpoint) };
  const set = (patch: Partial<typeof generationJobs.$inferInsert>) => ctx.db.update(generationJobs).set({ ...patch, updatedAt: new Date() }).where(eq(generationJobs.id, job.id));
  const params = op.params as { windowStart: number; windowEnd: number; whole: boolean; targetAspectRatio: string | null };
  const temps: string[] = [];
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'fc-edit-'));
  try {
    if (job.status === 'queued') await set({ status: 'processing', phase: 'Preparing the selected part of the shot', startedAt: new Date() });
    const [version] = await ctx.db.select().from(shotVersions).where(eq(shotVersions.id, op.sourceVersionId));
    const [srcAsset] = version ? await ctx.db.select().from(assets).where(eq(assets.id, version.assetId)) : [];
    if (!version || !srcAsset) throw new Error('The source version is no longer available');
    const original = await downloadAssetToTemp(ctx, srcAsset as Asset);
    temps.push(original);
    const windowFile = path.join(work, 'window.mp4');
    let edited: string;

    if (job.isFixture) {
      // Development fixture: a visibly marked, NON-AI change, run through the same compose pipeline.
      await extractWindow(original, windowFile, { startSec: params.windowStart, endSec: params.windowEnd, maxBytes: 50 * 1024 * 1024 });
      edited = path.join(work, 'fixture-edit.mp4');
      await ffmpeg(['-i', windowFile, '-vf', 'drawbox=x=0:y=0:w=iw:h=ih:color=magenta@0.55:t=fill,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', edited]);
    } else {
      if (!cp.taskId) {
        if (!ctx.liveEnabled || !ctx.editor.isConfigured()) throw configurationRequired('Runway is not configured for live editing');
        await extractWindow(original, windowFile, { startSec: params.windowStart, endSec: params.windowEnd, maxBytes: Math.floor(ALEPH.maxInlineBytes * 0.74) });
        const videoUri = `data:video/mp4;base64,${(await fsp.readFile(windowFile)).toString('base64')}`;
        const keyframes = [];
        if (op.keyframeAssetId && op.keyframeSec != null) {
          const kfAsset = await getOwnedAsset(ctx, job.userId, op.keyframeAssetId);
          const at = Math.min(params.windowEnd - params.windowStart - 0.05, Math.max(0, op.keyframeSec - params.windowStart));
          const rs = Math.floor(op.startSec - params.windowStart);
          const re = Math.max(rs + 1, Math.ceil(op.endSec - params.windowStart));
          keyframes.push({ uri: await providerInputUrl(ctx, kfAsset), seconds: Math.round(at * 100) / 100, ...(params.whole ? {} : { range: { start_seconds: Math.max(0, Math.min(rs, Math.floor(at))), end_seconds: Math.max(re, Math.floor(at) + 1) } }) });
        }
        const parent = version.operationId ? (await ctx.db.select().from(editOperations).where(eq(editOperations.id, version.operationId)))[0] : undefined;
        const promptText = promptFor(op.mode as AiEditMode, op.instruction, op.mask as EditMask | null, parent?.instruction ?? null);
        const { taskId } = await ctx.editor.submit({ videoUri, promptText, keyframes, targetAspectRatio: params.targetAspectRatio ?? undefined });
        cp.taskId = taskId;
        await set({ checkpoint: cp, status: 'generating', phase: 'Submitted to Runway Aleph', providerKey: 'runway' });
        await recordProviderSpend(ctx.db, 'runway', job.estimatedCostUsd ?? 0);
        return { rescheduleMs: 5000 };
      }
      if (!cp.outputUrl) {
        const st = await ctx.editor.status(cp.taskId);
        if (st.state === 'failed') throw new Error(st.error ?? 'The edit failed at Runway');
        if (st.state !== 'succeeded') {
          await set({ phase: st.note ?? 'Editing', ...(st.progress != null ? { progress: st.progress, progressSource: 'provider' } : {}) });
          return { rescheduleMs: st.state === 'waiting' ? 8000 : 4000 };
        }
        cp.outputUrl = st.url!;
        await set({ checkpoint: cp });
      }
      edited = await fetchProviderOutput(ctx, { url: cp.outputUrl }, 500 * 1024 * 1024);
      temps.push(edited);
    }

    // Compose: original outside the range / mask, the edit inside; original audio kept.
    await set({ status: 'processing', phase: 'Putting the edit back into the shot', progress: 0.95, progressSource: 'provider' });
    const out = path.join(work, 'result.mp4');
    if (params.whole) await adoptWholeShot({ original, edited, output: out });
    else await spliceEdit({ original, edited, output: out, windowStart: params.windowStart, rangeStart: op.startSec, rangeEnd: op.endSec, mask: (op.mask as EditMask | null) ?? null, workdir: work });
    const p = await probe(out);
    if (!p.hasVideo || p.durationSec < 0.2) throw new Error('The edited video could not be validated');

    const asset = await storeAsset(ctx, {
      userId: job.userId,
      projectId: job.projectId,
      kind: 'generated',
      mediaType: 'video',
      filePath: out,
      mimeType: 'video/mp4',
      isFixture: job.isFixture,
      source: { jobId: job.id, operationId: op.id, model: job.isFixture ? 'fixture' : ALEPH.modelKey, aiGenerated: !job.isFixture, editedFrom: version.assetId },
    });
    const label = `${job.isFixture ? 'Test fixture · ' : ''}${AI_EDIT_MODES.find((m) => m.key === op.mode)?.label ?? op.mode}: ${op.instruction}`.slice(0, 80);
    const result = await recordShotVersion(ctx.db, { projectId: op.projectId, shotId: op.shotId, assetId: asset.id, source: 'ai_edit', label, parentVersionId: version.id, operationId: op.id, prompt: op.instruction, settings: { mode: op.mode, startSec: op.startSec, endSec: op.endSec, masked: Boolean(op.mask) }, activate: false });
    let charged = 0;
    if (job.reservationId) charged = (await settleReservation(ctx.db, { reservationId: job.reservationId, chargeAmount: job.estimatedCredits, description: `AI edit (${op.mode})` })).charged;
    await ctx.db.update(editOperations).set({ status: 'ready', resultVersionId: result.id, updatedAt: new Date() }).where(eq(editOperations.id, op.id));
    if (op.commentId) await ctx.db.update(shotComments).set({ status: 'ready_for_review', updatedAt: new Date() }).where(eq(shotComments.id, op.commentId));
    await set({ status: 'completed', phase: 'Edit ready for review', progress: 1, outputAssetId: asset.id, chargedCredits: charged, actualCostUsd: job.isFixture ? 0 : job.estimatedCostUsd, completedAt: new Date() });
    await notify(ctx.db, { userId: job.userId, type: 'edit.ready', title: 'Your AI edit is ready to review', link: `/app/editor/${op.projectId}?shot=${op.shotId}` });
  } catch (err) {
    const message = err instanceof ProviderHttpError ? httpErrorToNormalized(err).message : (err as Error).message.split('\n')[0]!;
    ctx.log.warn(`edit job ${job.id} failed`, { message });
    if (job.reservationId) await settleReservation(ctx.db, { reservationId: job.reservationId, chargeAmount: 0, description: 'AI edit failed — credits returned' });
    await ctx.db.update(editOperations).set({ status: 'failed', error: { message: message.slice(0, 300) }, updatedAt: new Date() }).where(eq(editOperations.id, op.id));
    if (op.commentId) await ctx.db.update(shotComments).set({ status: 'failed', updatedAt: new Date() }).where(eq(shotComments.id, op.commentId));
    await set({ status: 'failed', phase: 'Edit failed', error: { code: 'edit_failed', message: message.slice(0, 300), retryable: true }, completedAt: new Date() });
  } finally {
    await Promise.all(temps.map((f) => fsp.rm(f, { force: true })));
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** Accept: the result becomes the shot's active version (atomic; the old one stays in history). */
export async function acceptAiEdit(ctx: AppContext, user: SessionLike, operationId: string) {
  const [op] = await ctx.db.select().from(editOperations).where(eq(editOperations.id, operationId));
  if (!op) throw notFound('Edit');
  await ownedShot(ctx, user, op.shotId);
  if (op.status !== 'ready' && op.status !== 'rejected') throw badRequest(op.status === 'accepted' ? 'This edit is already in use' : 'This edit is not ready yet');
  const activated = await activateShotVersion(ctx, user, op.resultVersionId!);
  await ctx.db.update(editOperations).set({ status: 'accepted', updatedAt: new Date() }).where(eq(editOperations.id, op.id));
  if (op.commentId) await ctx.db.update(shotComments).set({ status: 'accepted', updatedAt: new Date() }).where(eq(shotComments.id, op.commentId));
  return activated;
}

/** Reject: keep the active version; the result stays in the history (marked rejected). */
export async function rejectAiEdit(ctx: AppContext, user: SessionLike, operationId: string) {
  const [op] = await ctx.db.select().from(editOperations).where(eq(editOperations.id, operationId));
  if (!op) throw notFound('Edit');
  await ownedShot(ctx, user, op.shotId);
  if (op.status !== 'ready') throw badRequest('Only an edit waiting for review can be rejected');
  await ctx.db.update(editOperations).set({ status: 'rejected', updatedAt: new Date() }).where(eq(editOperations.id, op.id));
  if (op.commentId) await ctx.db.update(shotComments).set({ status: 'rejected', updatedAt: new Date() }).where(eq(shotComments.id, op.commentId));
}
