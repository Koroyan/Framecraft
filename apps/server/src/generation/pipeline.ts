import fsp from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { ASPECT_DIMENSIONS, composePrompt, RESOLUTION_RANK, type AspectRatio, type GenerationMode, type VideoSpec } from '@framecraft/shared';
import type { AppContext } from '../context';
import { assets, generationJobs, providerJobs, shots } from '../db/schema';
import { VIDEO_MODELS } from '../catalog/video-models';
import type { CatalogVideoModel } from '../catalog/types';
import { ProviderError, ProviderHttpError, type NormalizedError, type ProviderStatus, type ProviderVideoRequest, type VideoProvider } from '../providers/video/types';
import { httpErrorToNormalized, redactPayload } from '../providers/video/base';
import { conformOutput, extractLastFrame, joinClips, probe } from '../media/ffmpeg';
import { downloadAssetToTemp, ensureThumbnail, fetchProviderOutput, getOwnedAsset, providerInputUrl, storeAsset, tmpFile, type Asset } from '../services/assets';
import { settleReservation } from '../billing/wallet';
import { reconcileCredits } from '../pricing/pricing';
import { getConfig } from '../services/admin-config';
import { audit, committedProviderSpendToday, notify, recordProviderSpend } from '../services/common';
import { invalidateRegistryCache } from '../services/registry';
import { enqueue, type JobResult, type QueueJob } from '../queue/queue';
import type { Job } from './service';

type SegmentState = {
  index: number;
  durationSec: number;
  billedDurationSec: number;
  status: 'pending' | 'submitted' | 'succeeded';
  attempt?: number;
  providerJobId?: string;
  externalId?: string;
  outputAssetId?: string;
  lastFrameAssetId?: string;
  costUsd?: number;
  costReported?: boolean;
  progress?: number;
  /** When the provider's progress last changed (ms epoch) — drives the "taking longer" hint. */
  progressAt?: number;
};

/** A running render with no progress change for this long gets an explicit "still waiting" hint. */
const STALL_HINT_MS = 10 * 60_000;

type Checkpoint = {
  segments: SegmentState[];
  /** First frame drawn from the cast's/location's photos (image task, then the stored frame). */
  keyframe?: { taskId?: string; url?: string; modelKey?: string; skipped?: string };
  keyframeAssetId?: string;
  prompt?: string;
  negativePrompt?: string;
  promptSource?: 'llm' | 'offline' | 'user';
};

type Routing = {
  chosen: {
    modelKey: string;
    provider: string;
    resolution: ProviderVideoRequest['resolution'];
    generationAspect: AspectRatio;
    cropToTarget: boolean;
    audio: boolean;
    supportsImageInput: boolean;
  };
  characterDescriptions: string[];
  settingDescriptions?: string[];
  referenceAssetIds: string[];
  keyframeRefs?: string[];
};

class JobFailure extends Error {
  constructor(public readonly err: NormalizedError) {
    super(err.message);
  }
}

const progressOf = (segs: SegmentState[]) => {
  const total = segs.reduce((s, x) => s + x.durationSec, 0) || 1;
  return segs.reduce((s, x) => s + x.durationSec * (x.status === 'succeeded' ? 1 : (x.progress ?? 0)), 0) / total;
};

async function save(ctx: AppContext, jobId: string, patch: Partial<typeof generationJobs.$inferInsert>) {
  await ctx.db.update(generationJobs).set({ ...patch, updatedAt: new Date() }).where(eq(generationJobs.id, jobId));
}

/** Queue handler: advance one video job as far as possible, then reschedule while the provider works. */
export async function runVideoJob(ctx: AppContext, queueJob: QueueJob): Promise<JobResult> {
  const jobId = String(queueJob.payload.jobId);
  const [job] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return;

  try {
    if (job.cancelRequestedAt) return await handleCancel(ctx, job);
    return await advance(ctx, job);
  } catch (err) {
    if (err instanceof JobFailure) {
      await failGeneration(ctx, job, err.err);
      return;
    }
    const normalized = err instanceof ProviderError ? err.normalized : err instanceof ProviderHttpError ? httpErrorToNormalized(err) : null;
    if (normalized) {
      if (normalized.retryable) {
        ctx.log.warn(`job ${jobId}: transient provider error`, normalized);
        return { rescheduleMs: normalized.code === 'rate_limited' ? 30_000 : 15_000 };
      }
      await failGeneration(ctx, job, normalized);
      return;
    }
    // Unknown error: let the queue retry with backoff; the checkpoint prevents repeated paid submissions.
    throw err;
  }
}

async function advance(ctx: AppContext, job: Job): Promise<JobResult> {
  const spec = job.request as unknown as VideoSpec;
  const routing = job.routing as unknown as Routing;
  const cp = structuredClone(job.checkpoint) as Checkpoint;
  const model = VIDEO_MODELS.find((m) => m.key === routing.chosen.modelKey);
  if (!model) throw new JobFailure({ code: 'invalid_request', message: 'Model no longer exists in the catalog', retryable: false, providerRefunds: true });
  const provider: VideoProvider = job.isFixture ? ctx.video.fixture : (ctx.video[model.provider] as VideoProvider);
  if (!job.isFixture && (!provider?.isConfigured() || !ctx.liveEnabled)) {
    throw new JobFailure({ code: 'auth', message: `${model.provider} is no longer configured for live generation`, retryable: false, providerRefunds: true });
  }
  if (!job.startedAt) await save(ctx, job.id, { startedAt: new Date() });

  // ---------------------------------------------------------------- 1. prepare prompt
  if (!cp.prompt) {
    await save(ctx, job.id, { status: 'preparing', phase: spec.enhancePrompt ? 'Enhancing your prompt' : 'Preparing prompt' });
    const directives = { ...spec, includeCamera: !(model.capabilities.cameraControl?.length && spec.camera) };
    if (spec.enhancePrompt) {
      const r = await ctx.director.enhancePrompt({ ...directives, prompt: spec.prompt, characters: routing.characterDescriptions });
      cp.prompt = r.prompt;
      cp.negativePrompt = spec.negativePrompt ?? r.negativePrompt;
      cp.promptSource = r.source;
    } else {
      cp.prompt = composePrompt(spec.prompt, directives, { includeCamera: directives.includeCamera });
      if (routing.characterDescriptions.length) cp.prompt += ` Characters: ${routing.characterDescriptions.join('; ')}.`;
      if (routing.settingDescriptions?.length) cp.prompt += ` Setting: ${routing.settingDescriptions.join('; ')}.`;
      cp.negativePrompt = spec.negativePrompt;
      cp.promptSource = 'user';
    }
    cp.prompt = cp.prompt.slice(0, model.capabilities.maxPromptChars);
    await save(ctx, job.id, { checkpoint: cp, enhancedPrompt: cp.prompt });
  }

  // ---------------------------------------------------------------- 1b. keyframe
  if (routing.keyframeRefs?.length && !cp.keyframeAssetId && !cp.keyframe?.skipped && !spec.imageAssetId && !job.isFixture) {
    const pending = await drawKeyframe(ctx, job, routing, cp);
    if (pending) return pending;
  }

  // ---------------------------------------------------------------- 2. generate segments
  const seg = cp.segments.find((s) => s.status !== 'succeeded');
  if (seg) {
    const label = cp.segments.length > 1 ? `Generating clip ${seg.index + 1} of ${cp.segments.length}` : 'Generating video';
    if (seg.status === 'pending') {
      // While polling, the phase holds the provider's live hint (queued / rendering), so only set it here.
      await save(ctx, job.id, { status: 'generating', phase: job.isFixture ? `${label} (development fixture — no AI model is called)` : `${label} with ${model.displayName}` });
      const status = await submitSegment(ctx, job, spec, routing, model, provider, cp, seg);
      if (status) return handleStatus(ctx, job, model, provider, cp, seg, status);
      return { rescheduleMs: ctx.env.PROVIDER_POLL_INTERVAL_MS };
    }
    const status = await provider.getGenerationStatus(seg.externalId!, model);
    return handleStatus(ctx, job, model, provider, cp, seg, status);
  }

  // ---------------------------------------------------------------- 3. post-process & complete
  await finalize(ctx, job, spec, routing, model, cp);
}

/**
 * Draw the shot's first frame from the cast's/location's photos (submitted once — the task id is
 * checkpointed — then polled by rescheduling). Returns a reschedule while the image is rendering.
 */
async function drawKeyframe(ctx: AppContext, job: Job, routing: Routing, cp: Checkpoint): Promise<JobResult | undefined> {
  const kf = (cp.keyframe ??= {});
  if (!kf.url && !kf.taskId) {
    await save(ctx, job.id, { status: 'preparing', phase: 'Drawing the first frame from your characters’ photos' });
    const refs = await Promise.all(routing.keyframeRefs!.map(async (id) => providerInputUrl(ctx, await getOwnedAsset(ctx, job.userId, id))));
    let res;
    try {
      res = await ctx.images.start({
        prompt: `${cp.prompt}\n\nOne photorealistic cinematic still: the first frame of this shot. Keep every person, place and object exactly consistent with the reference images. No text, captions or logos.`.slice(0, 1000),
        aspectRatio: routing.chosen.generationAspect,
        references: refs,
      });
    } catch (err) {
      // Rejected by the image model (validation / policy): go on without a first frame rather than stall.
      if (err instanceof ProviderHttpError && err.status < 500 && err.status !== 429) return skipKeyframe(ctx, job, cp, httpErrorToNormalized(err).message);
      throw err;
    }
    Object.assign(kf, { taskId: res.taskId, url: res.url, modelKey: res.modelKey });
    await save(ctx, job.id, { checkpoint: cp });
    await recordProviderSpend(ctx.db, res.modelKey.split(':')[0]!, res.costUsd);
  }
  if (!kf.url) {
    const st = await ctx.images.check(kf.taskId!);
    if (st.state === 'failed') return skipKeyframe(ctx, job, cp, st.error ?? 'image model failed');
    if (st.state !== 'succeeded') {
      if (st.note) await save(ctx, job.id, { phase: `First frame — ${st.note}` });
      return { rescheduleMs: st.state === 'waiting' ? 8000 : 4000 };
    }
    kf.url = st.url!;
  }
  const file = await fetchProviderOutput(ctx, { url: kf.url });
  try {
    const frame = await storeAsset(ctx, { userId: job.userId, projectId: job.projectId, kind: 'frame', mediaType: 'image', filePath: file, mimeType: 'image/jpeg', makeThumbnail: false, source: { jobId: job.id, keyframe: true, model: kf.modelKey, aiGenerated: true } });
    cp.keyframeAssetId = frame.id;
  } finally {
    await fsp.rm(file, { force: true });
  }
  await save(ctx, job.id, { checkpoint: cp });
  return undefined;
}

async function skipKeyframe(ctx: AppContext, job: Job, cp: Checkpoint, reason: string): Promise<undefined> {
  ctx.log.warn(`job ${job.id}: first frame not drawn, continuing without it`, { reason });
  cp.keyframe = { ...cp.keyframe, skipped: reason.slice(0, 300) };
  await save(ctx, job.id, { checkpoint: cp, phase: `The first frame could not be drawn (${reason.slice(0, 120)}) — generating from the description` });
  return undefined;
}

async function submitSegment(
  ctx: AppContext,
  job: Job,
  spec: VideoSpec,
  routing: Routing,
  model: CatalogVideoModel,
  provider: VideoProvider,
  cp: Checkpoint,
  seg: SegmentState,
): Promise<ProviderStatus | undefined> {
  const attempt = seg.attempt ?? 1;
  const idempotencyKey = `${job.id}:${seg.index}:${attempt}`;

  // A provider_job row is written *before* submitting. If one already exists without an
  // external id, a previous worker may have submitted and crashed — never resubmit blindly.
  const [prior] = await ctx.db.select().from(providerJobs).where(eq(providerJobs.idempotencyKey, idempotencyKey));
  if (prior?.externalId) {
    seg.status = 'submitted';
    seg.externalId = prior.externalId;
    seg.providerJobId = prior.id;
    await save(ctx, job.id, { checkpoint: cp });
    return undefined;
  }
  if (prior && prior.status === 'submitting') {
    await audit(ctx.db, { action: 'generation.submission_uncertain', targetType: 'generation_job', targetId: job.id, metadata: { providerJobId: prior.id } });
    throw new JobFailure({ code: 'unknown', message: 'The previous submission attempt was interrupted; to avoid double charges it was not resent. Please retry.', retryable: false, providerRefunds: false });
  }
  if (prior) {
    // This attempt was already rejected by the provider and the retry budget is spent.
    const e = (prior.error ?? {}) as Partial<NormalizedError>;
    throw new JobFailure({ code: e.code ?? 'unknown', message: e.message ?? 'Provider rejected the request', retryable: false, providerRefunds: e.providerRefunds ?? true });
  }

  if (!job.isFixture) {
    const spending = await getConfig(ctx.db, 'spending');
    // This job's own estimate is already included in the committed total, so only block when over.
    if ((await committedProviderSpendToday(ctx.db)) > Math.min(spending.globalDailyProviderBudgetUsd, ctx.env.GLOBAL_DAILY_PROVIDER_BUDGET_USD)) {
      throw new JobFailure({ code: 'provider_unavailable', message: 'Generation capacity is paused (daily spending cap reached). Your credits were released.', retryable: false, providerRefunds: true });
    }
  }

  // Inputs: first frame (user image, or the previous segment's last frame for continuity), end frame, references.
  const prev = cp.segments[seg.index - 1];
  let imageAsset: Asset | undefined;
  if (seg.index === 0 && spec.imageAssetId) imageAsset = await getOwnedAsset(ctx, job.userId, spec.imageAssetId);
  else if (seg.index === 0 && cp.keyframeAssetId) imageAsset = await getOwnedAsset(ctx, job.userId, cp.keyframeAssetId);
  else if (prev?.lastFrameAssetId && routing.chosen.supportsImageInput) imageAsset = await getOwnedAsset(ctx, job.userId, prev.lastFrameAssetId);
  const isLast = seg.index === cp.segments.length - 1;
  const endAsset = isLast && spec.endImageAssetId && model.capabilities.modes.includes('first-last-frame') ? await getOwnedAsset(ctx, job.userId, spec.endImageAssetId) : undefined;
  const refIds = !imageAsset ? routing.referenceAssetIds : [];
  let mode: GenerationMode = 'text-to-video';
  if (imageAsset && endAsset) mode = 'first-last-frame';
  else if (imageAsset) mode = 'image-to-video';
  else if (refIds.length && model.capabilities.modes.includes('reference-to-video')) mode = 'reference-to-video';
  if (!model.capabilities.modes.includes(mode)) mode = imageAsset && model.capabilities.modes.includes('image-to-video') ? 'image-to-video' : 'text-to-video';

  const continuation = seg.index > 0 ? ' Continue seamlessly from the previous shot, same subject, lighting and style.' : '';
  const req: ProviderVideoRequest = {
    model,
    mode,
    prompt: (cp.prompt! + continuation).slice(0, model.capabilities.maxPromptChars),
    negativePrompt: cp.negativePrompt,
    aspectRatio: routing.chosen.generationAspect,
    resolution: routing.chosen.resolution,
    durationSec: seg.billedDurationSec,
    audio: routing.chosen.audio,
    seed: spec.seed,
    image: imageAsset && mode !== 'text-to-video' ? await providerInputUrl(ctx, imageAsset) : undefined,
    endImage: endAsset && mode === 'first-last-frame' ? await providerInputUrl(ctx, endAsset) : undefined,
    references: mode === 'reference-to-video' ? await Promise.all((await Promise.all(refIds.map((id) => getOwnedAsset(ctx, job.userId, id)))).map((a) => providerInputUrl(ctx, a))) : undefined,
    camera: spec.camera,
    draft: spec.renderPass === 'draft',
    // Lip-sync: the first (and only) clip follows the recorded line.
    speechAudio: spec.speechAudioAssetId && seg.index === 0 ? await providerInputUrl(ctx, await getOwnedAsset(ctx, job.userId, spec.speechAudioAssetId)) : undefined,
  };

  const problems = job.isFixture ? [] : provider.validateRequest(req);
  if (problems.length) throw new JobFailure({ code: 'invalid_request', message: problems.join('; '), retryable: false, providerRefunds: true });
  const estimate = provider.estimateCost(req);
  const payload = provider.buildPayload(req);

  const [pj] = await ctx.db
    .insert(providerJobs)
    .values({
      generationJobId: job.id,
      segmentIndex: seg.index,
      attempt,
      providerKey: provider.key,
      modelKey: model.key,
      status: 'submitting',
      requestPayload: redactPayload({ url: payload.url, ...payload.body }),
      estimatedCostUsd: job.isFixture ? 0 : estimate.usd,
      idempotencyKey,
    })
    .returning();

  let result;
  try {
    result = await provider.submitGeneration(req, { idempotencyKey, webhookUrl: webhookUrlFor(ctx, provider.key) });
  } catch (err) {
    const n = provider.normalizeError(err);
    // The request was rejected before acceptance, so nothing is in flight.
    await ctx.db.update(providerJobs).set({ status: 'failed', error: n, completedAt: new Date() }).where(eq(providerJobs.id, pj!.id));
    if (n.retryable && attempt <= (await getConfig(ctx.db, 'spending')).maxProviderRetries) {
      seg.attempt = attempt + 1;
      await save(ctx, job.id, { checkpoint: cp, attempts: job.attempts + 1 });
      throw new ProviderError(n);
    }
    throw new JobFailure(n);
  }
  await ctx.db
    .update(providerJobs)
    .set({ externalId: result.externalId, status: 'submitted', submittedAt: new Date(), response: redactPayload((result.raw as Record<string, unknown>) ?? {}) })
    .where(eq(providerJobs.id, pj!.id));
  seg.status = 'submitted';
  seg.externalId = result.externalId;
  seg.providerJobId = pj!.id;
  seg.attempt = attempt;
  await save(ctx, job.id, { checkpoint: cp });
  return result.immediate;
}

function webhookUrlFor(ctx: AppContext, provider: string): string | undefined {
  if (!ctx.env.PROVIDER_WEBHOOK_BASE_URL) return undefined;
  // Only providers whose webhook signatures we verify; others are polled.
  if (provider !== 'fal') return undefined;
  return `${ctx.env.PROVIDER_WEBHOOK_BASE_URL.replace(/\/$/, '')}/api/webhooks/providers/${provider}`;
}

async function handleStatus(
  ctx: AppContext,
  job: Job,
  model: CatalogVideoModel,
  provider: VideoProvider,
  cp: Checkpoint,
  seg: SegmentState,
  status: ProviderStatus,
): Promise<JobResult> {
  if (status.state === 'queued' || status.state === 'running') {
    const clipLabel = cp.segments.length > 1 ? `Clip ${seg.index + 1} of ${cp.segments.length}: ` : '';
    // A render whose progress hasn't moved for a while is usually slow at the provider, not failed: say so.
    const now = Date.now();
    const moved = status.progress !== seg.progress || !seg.progressAt;
    if (moved) seg.progressAt = now;
    const stalled = status.state === 'running' && now - seg.progressAt! > STALL_HINT_MS;
    const note = stalled ? `${provider.displayName} is taking longer than usual to finish this clip — still waiting, no extra charge` : status.note;
    const phase = note ? `${clipLabel}${note}` : undefined;
    if (moved) {
      const reported = status.progress !== undefined;
      if (reported) seg.progress = status.progress;
      await save(ctx, job.id, { checkpoint: cp, ...(reported ? { progress: progressOf(cp.segments), progressSource: 'provider' as const } : {}), ...(phase ? { phase } : {}) });
    } else if (phase && phase !== job.phase) {
      await save(ctx, job.id, { phase });
    }
    return { rescheduleMs: ctx.env.PROVIDER_POLL_INTERVAL_MS + Math.floor(Math.random() * 1500) };
  }

  if (status.state === 'succeeded') {
    const outputs = provider.retrieveOutput(status);
    if (!outputs.length) throw new JobFailure({ code: 'bad_output', message: 'The provider returned no video', retryable: false, providerRefunds: false });
    await save(ctx, job.id, { status: 'processing', phase: 'Validating and storing the result' });
    const file = await fetchProviderOutput(ctx, outputs[0]!);
    try {
      const p = await probe(file).catch(() => undefined);
      if (!p?.hasVideo || p.durationSec < 0.5) throw new JobFailure({ code: 'bad_output', message: 'The provider returned an invalid video file', retryable: false, providerRefunds: false });
      const asset = await storeAsset(ctx, {
        userId: job.userId,
        projectId: job.projectId,
        kind: 'generated',
        mediaType: 'video',
        filePath: file,
        mimeType: 'video/mp4',
        isFixture: job.isFixture,
        source: { jobId: job.id, provider: provider.key, model: model.key, segment: seg.index, fixture: job.isFixture, aiGenerated: !job.isFixture },
        makeThumbnail: false,
      });
      seg.outputAssetId = asset.id;
      const estimated = job.isFixture ? 0 : (await ctx.db.select({ e: providerJobs.estimatedCostUsd }).from(providerJobs).where(eq(providerJobs.id, seg.providerJobId!)))[0]?.e ?? 0;
      seg.costUsd = status.costUsd ?? estimated;
      seg.costReported = status.costUsd !== undefined;
      await ctx.db
        .update(providerJobs)
        .set({ status: 'succeeded', costUsd: seg.costUsd, costSource: seg.costReported ? 'provider_reported' : 'price_table', completedAt: new Date(), outputAssetId: asset.id })
        .where(eq(providerJobs.id, seg.providerJobId!));
      if (!job.isFixture) await recordProviderSpend(ctx.db, provider.key, seg.costUsd);
      // Continuity: hand the last frame to the next segment.
      if (seg.index < cp.segments.length - 1) {
        const frame = tmpFile('.jpg');
        try {
          await extractLastFrame(file, frame);
          const f = await storeAsset(ctx, { userId: job.userId, projectId: job.projectId, kind: 'frame', mediaType: 'image', filePath: frame, mimeType: 'image/jpeg', isFixture: job.isFixture, makeThumbnail: false });
          seg.lastFrameAssetId = f.id;
        } finally {
          await fsp.rm(frame, { force: true });
        }
      }
      seg.status = 'succeeded';
      seg.progress = 1;
      await save(ctx, job.id, { checkpoint: cp, progress: progressOf(cp.segments) });
    } finally {
      await fsp.rm(file, { force: true });
      if (outputs[0]?.localPath) await fsp.rm(outputs[0].localPath, { force: true }).catch(() => undefined);
    }
    return { rescheduleMs: 0 };
  }

  // failed / cancelled at the provider
  const error = status.error ?? { code: 'unknown', message: 'Generation failed', retryable: false, providerRefunds: true };
  if (seg.providerJobId) {
    await ctx.db.update(providerJobs).set({ status: status.state === 'cancelled' ? 'cancelled' : 'failed', error, costUsd: status.costUsd, completedAt: new Date() }).where(eq(providerJobs.id, seg.providerJobId));
  }
  invalidateRegistryCache();
  const attempt = seg.attempt ?? 1;
  const maxRetries = (await getConfig(ctx.db, 'spending')).maxProviderRetries;
  if (status.state === 'failed' && error.retryable && attempt <= maxRetries) {
    seg.status = 'pending';
    seg.attempt = attempt + 1;
    seg.externalId = undefined;
    seg.progress = 0;
    await save(ctx, job.id, { checkpoint: cp, attempts: job.attempts + 1, phase: 'Retrying after a provider error' });
    return { rescheduleMs: 10_000 };
  }
  throw new JobFailure(status.state === 'cancelled' ? { ...error, code: 'cancelled', message: 'The provider cancelled this generation' } : error);
}

async function finalize(ctx: AppContext, job: Job, spec: VideoSpec, routing: Routing, model: CatalogVideoModel, cp: Checkpoint) {
  await save(ctx, job.id, { status: 'processing', phase: cp.segments.length > 1 ? 'Stitching clips' : 'Finishing video' });
  const segAssets = await Promise.all(cp.segments.map((s) => getOwnedAsset(ctx, job.userId, s.outputAssetId!)));
  const target = spec.aspectRatio;
  const res = RESOLUTION_RANK[routing.chosen.resolution] >= RESOLUTION_RANK['1080p'] ? '1080p' : routing.chosen.resolution === '480p' ? '480p' : '720p';
  const dims = ASPECT_DIMENSIONS[target][res];
  const single = segAssets.length === 1 ? segAssets[0]! : undefined;
  const singleOk = single && !routing.chosen.cropToTarget && Math.abs((single.durationMs ?? 0) / 1000 - spec.durationSec) < 0.6;

  let output: Asset;
  if (singleOk) {
    // Keep the provider's original encode — no generational quality loss. The segment part
    // becomes the final output, so drop its segment marker (segment parts are hidden in the library).
    const { segment: _segment, ...source } = single.source as Record<string, unknown>;
    const [updated] = await ctx.db.update(assets).set({ source: { ...source, final: true } }).where(eq(assets.id, single.id)).returning();
    output = updated!;
  } else {
    const local: string[] = [];
    const conformed: string[] = [];
    try {
      for (let i = 0; i < segAssets.length; i++) {
        const src = await downloadAssetToTemp(ctx, segAssets[i]!);
        local.push(src);
        const out = tmpFile('.mp4');
        await conformOutput(src, out, { width: dims.width, height: dims.height, durationSec: cp.segments[i]!.durationSec, fill: true });
        conformed.push(out);
      }
      const final = tmpFile('.mp4');
      if (conformed.length === 1) await fsp.copyFile(conformed[0]!, final);
      else await joinClips(conformed, conformed.slice(1).map(() => undefined), final);
      conformed.push(final);
      output = await storeAsset(ctx, {
        userId: job.userId,
        projectId: job.projectId,
        kind: 'generated',
        mediaType: 'video',
        filePath: final,
        mimeType: 'video/mp4',
        isFixture: job.isFixture,
        source: { jobId: job.id, provider: model.provider, model: model.key, segments: cp.segments.length, fixture: job.isFixture, aiGenerated: !job.isFixture },
      });
    } finally {
      await Promise.all([...local, ...conformed].map((f) => fsp.rm(f, { force: true })));
    }
  }
  if (!output.thumbnailAssetId) output = await ensureThumbnail(ctx, output);

  // Settle credits against the real provider cost when every segment reported it.
  let charged = 0;
  const actualCost = cp.segments.reduce((s, x) => s + (x.costUsd ?? 0), 0);
  if (job.reservationId && !job.isFixture) {
    const allReported = cp.segments.every((s) => s.costReported);
    const rules = await getConfig(ctx.db, 'pricing');
    const r = reconcileCredits(job.estimatedCredits, allReported ? actualCost : null, spec.durationSec, rules);
    const settled = await settleReservation(ctx.db, { reservationId: job.reservationId, chargeAmount: r.charge, description: `Video generated with ${model.displayName}`, metadata: { jobId: job.id, actualCostUsd: actualCost } });
    charged = settled.alreadySettled ? (job.chargedCredits ?? r.charge) : settled.charged;
    if (r.overrunUsd > 0) await audit(ctx.db, { action: 'billing.cost_overrun', targetType: 'generation_job', targetId: job.id, metadata: { overrunUsd: r.overrunUsd } });
  }

  await save(ctx, job.id, {
    status: 'completed',
    phase: job.isFixture ? 'Completed (development fixture — not AI generated)' : 'Completed',
    progress: 1,
    outputAssetId: output.id,
    chargedCredits: charged,
    actualCostUsd: job.isFixture ? 0 : actualCost,
    completedAt: new Date(),
  });
  if (job.shotId) await ctx.db.update(shots).set({ currentAssetId: output.id, status: 'ready', lastJobId: job.id, updatedAt: new Date() }).where(eq(shots.id, job.shotId));
  if (!job.parentJobId) await notify(ctx.db, { userId: job.userId, type: 'generation.completed', title: job.isFixture ? 'Fixture video ready (not AI generated)' : 'Your video is ready', link: `/app/history?job=${job.id}` });
  if (job.parentJobId) await enqueue(ctx.db, 'movie.check', { movieJobId: job.parentJobId }, { queue: 'generation', dedupeKey: `movie-check:${job.parentJobId}:${job.id}` });
}

/** Mark a job failed and settle credits per the refund policy (docs/BILLING.md). */
export async function failGeneration(ctx: AppContext, job: Job, error: NormalizedError) {
  const [fresh] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, job.id));
  if (!fresh || ['completed', 'failed', 'cancelled'].includes(fresh.status)) return;
  let charge = 0;
  if (fresh.reservationId) {
    // Content-policy rejections the provider does not refund are charged at cost (no markup) to deter abuse.
    if (error.code === 'content_policy' && !error.providerRefunds) {
      const rules = await getConfig(ctx.db, 'pricing');
      charge = Math.min(fresh.estimatedCredits, Math.ceil(fresh.estimatedCostUsd / rules.creditValueUsd));
    }
    const s = await settleReservation(ctx.db, { reservationId: fresh.reservationId, chargeAmount: charge, description: charge ? 'Content policy rejection (provider cost)' : 'Generation failed — credits returned' });
    charge = s.charged;
  }
  await ctx.db
    .update(generationJobs)
    .set({ status: 'failed', phase: 'Failed', error: { code: error.code, message: error.message, retryable: error.retryable }, chargedCredits: charge, completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(generationJobs.id, job.id)));
  if (fresh.shotId) await ctx.db.update(shots).set({ status: 'failed', updatedAt: new Date() }).where(eq(shots.id, fresh.shotId));
  if (!fresh.parentJobId) await notify(ctx.db, { userId: fresh.userId, type: 'generation.failed', title: 'Generation failed', body: charge ? error.message : `${error.message} Your credits were returned.`, link: `/app/history?job=${job.id}` });
  if (fresh.parentJobId) await enqueue(ctx.db, 'movie.check', { movieJobId: fresh.parentJobId }, { queue: 'generation', dedupeKey: `movie-check:${fresh.parentJobId}:${job.id}` });
}

async function handleCancel(ctx: AppContext, job: Job): Promise<JobResult> {
  const cp = job.checkpoint as Checkpoint;
  const model = VIDEO_MODELS.find((m) => m.key === job.modelKey);
  const inflight = cp.segments?.find((s) => s.status === 'submitted');
  if (inflight?.externalId && model && !job.isFixture) {
    const provider = ctx.video[model.provider] as VideoProvider | undefined;
    await provider?.cancelGeneration?.(inflight.externalId, model).catch(() => false);
  }
  let charge = 0;
  if (job.reservationId) {
    // Charge provider cost (no markup) only for segments that already finished at the provider.
    const rules = await getConfig(ctx.db, 'pricing');
    const doneCost = (cp.segments ?? []).filter((s) => s.status === 'succeeded').reduce((s, x) => s + (x.costUsd ?? 0), 0);
    charge = Math.min(job.estimatedCredits, Math.ceil(doneCost / rules.creditValueUsd));
    charge = (await settleReservation(ctx.db, { reservationId: job.reservationId, chargeAmount: charge, description: 'Generation cancelled' })).charged;
  }
  await save(ctx, job.id, { status: 'cancelled', phase: 'Cancelled', chargedCredits: charge, completedAt: new Date() });
  if (job.shotId) await ctx.db.update(shots).set({ status: 'failed', updatedAt: new Date() }).where(eq(shots.id, job.shotId));
  if (job.parentJobId) await enqueue(ctx.db, 'movie.check', { movieJobId: job.parentJobId }, { queue: 'generation', dedupeKey: `movie-check:${job.parentJobId}:${job.id}` });
}
