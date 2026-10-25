import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  RESOLUTION_RANK,
  videoSpecSchema,
  type GenerationEstimate,
  type PublicJob,
  type Resolution,
  type VideoSpec,
  type VideoSpecInput,
} from '@framecraft/shared';
import type { AppContext } from '../context';
import { liveProviders } from '../context';
import type { Db } from '../db/client';
import { assets, characterReferences, characters, generationJobs, locationReferences, locations, projects, providerJobs, shots } from '../db/schema';
import { estimateImage } from '../images/images';
import { analyzePrompt } from '../routing/analyze';
import { inferMode, routeVideo, type RoutingDecision } from '../routing/router';
import { loadRoutableModels } from '../services/registry';
import { getConfig } from '../services/admin-config';
import { activeJobCount, audit, committedProviderSpendToday, creditsSpentToday, getUserPlan } from '../services/common';
import { reserveCredits, settleReservation } from '../billing/wallet';
import { enqueue, wakeJob } from '../queue/queue';
import { AppError, badRequest, configurationRequired, notFound } from '../lib/errors';
import { assetUrl, getOwnedAsset } from '../services/assets';
import { estimateEta } from './eta';

export type Job = typeof generationJobs.$inferSelect;
export type SessionLike = { id: string; role: 'user' | 'admin' };

export const VIDEO_JOB_HANDLER = 'video.run';
export const jobDedupeKey = (jobId: string) => `video:${jobId}`;

/** Character facts appended to prompts and their reference images (for reference-capable models). */
async function loadCharacters(db: Db, userId: string, ids: string[]) {
  if (!ids.length) return { descriptions: [] as string[], referenceAssetIds: [] as string[] };
  const rows = await db.select().from(characters).where(and(eq(characters.userId, userId), inArray(characters.id, ids)));
  if (rows.length !== ids.length) throw notFound('Character');
  const refs = await db.select().from(characterReferences).where(inArray(characterReferences.characterId, ids));
  const descriptions = rows.map((c) => {
    const a = c.appearance;
    const look = [a.age, a.gender, a.hair && `${a.hair} hair`, a.eyes && `${a.eyes} eyes`, a.build, a.distinguishing].filter(Boolean).join(', ');
    return `${c.name}${look ? ` (${look})` : ''}${c.clothing ? `, wearing ${c.clothing}` : ''}`;
  });
  return { descriptions, referenceAssetIds: refs.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)).map((r) => r.assetId) };
}

export type PreparedSpec = {
  spec: VideoSpec;
  decision: RoutingDecision;
  estimate: GenerationEstimate;
  characterDescriptions: string[];
  settingDescriptions: string[];
  referenceAssetIds: string[];
  /** Photos the first frame is drawn from (empty = no keyframe step). */
  keyframeRefs: string[];
};

async function loadLocations(db: Db, userId: string, ids: string[]) {
  if (!ids.length) return { descriptions: [] as string[], referenceAssetIds: [] as string[] };
  const rows = await db.select().from(locations).where(and(eq(locations.userId, userId), inArray(locations.id, ids)));
  if (rows.length !== ids.length) throw notFound('Location');
  const refs = await db.select().from(locationReferences).where(inArray(locationReferences.locationId, ids));
  return { descriptions: rows.map((l) => `${l.name}${l.description ? ` — ${l.description}` : ''}`), referenceAssetIds: refs.map((r) => r.assetId) };
}

/**
 * Validate inputs, apply plan limits and route. No side effects.
 * `assumeFirstFrame`: estimate as image-to-video for a shot whose keyframe will be drawn first.
 */
export async function prepareEstimate(ctx: AppContext, user: SessionLike, input: VideoSpecInput, opts: { assumeFirstFrame?: boolean; assumeSpeech?: boolean } = {}): Promise<PreparedSpec> {
  const spec = videoSpecSchema.parse(input);
  const plan = await getUserPlan(ctx.db, user.id);
  const warnings: string[] = [];
  const blockers: string[] = [];

  if (spec.durationSec > plan.limits.maxClipSeconds) blockers.push(`Your ${plan.name} plan allows clips up to ${plan.limits.maxClipSeconds}s.`);
  if (!plan.limits.qualityModes.includes(spec.quality)) blockers.push(`${spec.quality} quality is not included in the ${plan.name} plan.`);
  if (spec.resolution && RESOLUTION_RANK[spec.resolution] > RESOLUTION_RANK[plan.limits.maxResolution as Resolution]) blockers.push(`Your plan exports up to ${plan.limits.maxResolution}.`);
  if (spec.modelKey && plan.key === 'free') blockers.push('Manual model selection is available on paid plans.');

  // Ownership checks for every referenced asset.
  for (const id of [spec.imageAssetId, spec.endImageAssetId, ...spec.referenceAssetIds].filter(Boolean) as string[]) {
    const a = await getOwnedAsset(ctx, user.id, id);
    if (a.mediaType !== 'image') throw badRequest('Reference and frame inputs must be images');
  }
  if (spec.speechAudioAssetId) {
    const a = await getOwnedAsset(ctx, user.id, spec.speechAudioAssetId);
    if (a.mediaType !== 'audio') throw badRequest('The lip-sync recording must be an audio file');
    warnings.push('Lip-sync: the character’s mouth follows your recorded line, so it matches the voice-over language.');
  }
  const chars = await loadCharacters(ctx.db, user.id, spec.characterIds);
  const locs = await loadLocations(ctx.db, user.id, spec.locationIds);
  const referenceAssetIds = [...new Set([...spec.referenceAssetIds, ...chars.referenceAssetIds, ...locs.referenceAssetIds])].slice(0, 7);
  // Keyframe: draw the first frame from the cast's/location's photos, then animate it.
  const frame = spec.keyframe && !spec.imageAssetId && !opts.assumeFirstFrame && !spec.modelKey && referenceAssetIds.length ? await estimateImage(ctx, true) : null;
  const keyframe = frame?.available ? frame : null;

  const firstFrame = spec.imageAssetId ?? (opts.assumeFirstFrame || keyframe ? 'keyframe' : undefined);
  const mode = inferMode({ ...spec, imageAssetId: firstFrame, referenceAssetIds: firstFrame ? [] : referenceAssetIds });
  const analysis = analyzePrompt(`${spec.prompt} ${chars.descriptions.join(' ')}`, { characterCount: spec.characterIds.length });
  const [models, routingCfg, rules, spending] = await Promise.all([
    loadRoutableModels(ctx.db, liveProviders(ctx)),
    getConfig(ctx.db, 'routing'),
    getConfig(ctx.db, 'pricing'),
    getConfig(ctx.db, 'spending'),
  ]);
  const decision = routeVideo(
    {
      mode,
      aspectRatio: spec.aspectRatio,
      durationSec: spec.durationSec,
      quality: spec.quality,
      minResolution: spec.resolution,
      nativeAudio: spec.nativeAudio,
      speechAudio: Boolean(spec.speechAudioAssetId || opts.assumeSpeech),
      referenceCount: mode === 'reference-to-video' ? referenceAssetIds.length : 0,
      modelKey: spec.modelKey,
      maxCredits: spec.maxCredits,
      renderPass: spec.renderPass,
      analysis,
    },
    models,
    routingCfg,
    rules,
  );

  const chosen = decision.chosen;
  if (chosen) {
    if (chosen.credits > spending.maxCreditsPerJob) blockers.push(`This exceeds the platform limit of ${spending.maxCreditsPerJob} credits per job.`);
    if (RESOLUTION_RANK[chosen.resolution] > RESOLUTION_RANK[plan.limits.maxResolution as Resolution]) blockers.push(`This needs ${chosen.resolution}, above your plan's ${plan.limits.maxResolution} limit.`);
    if (!chosen.model.capabilities.cameraControl?.length && spec.camera) warnings.push('Camera preset is applied through the prompt (this model has no camera-control parameter).');
  }
  const liveGenerationAvailable = Boolean(chosen && ctx.liveEnabled && chosen.model.configured);
  if (!ctx.liveEnabled) warnings.push('Live AI generation is disabled on this server (LIVE_GENERATION_ENABLED=false).');

  if (keyframe && chosen) warnings.push('The first frame is drawn from your characters’ and locations’ photos, then animated — a consistent look at a lower cost.');
  const estimate: GenerationEstimate = {
    ok: decision.ok && blockers.length === 0,
    credits: (chosen?.credits ?? 0) + (keyframe && chosen ? keyframe.credits : 0),
    providerCostUsd: (chosen?.providerCostUsd ?? 0) + (keyframe && chosen ? keyframe.usd : 0),
    processingCostUsd: 0,
    segments: (chosen?.segments ?? []).map((s) => ({
      modelKey: chosen!.model.key,
      modelName: chosen!.model.displayName,
      durationSec: s.durationSec,
      billedDurationSec: s.billedDurationSec,
      resolution: chosen!.resolution,
      nativeAudio: chosen!.audio,
      providerCostUsd: 0,
    })),
    quality: spec.quality,
    requiredTier: decision.requiredTier,
    explanation: decision.explanation,
    warnings: [...decision.warnings, ...warnings],
    alternatives: decision.alternatives.map((a) => ({
      modelKey: a.model.key,
      modelName: a.model.displayName,
      credits: a.credits,
      qualityTier: a.effectiveTier,
      reason: a.effectiveTier < decision.requiredTier ? 'Lower quality, lower cost' : a.notes[0] ?? 'Also meets the quality target',
    })),
    blockers: [...decision.blockers, ...blockers],
    requiresConfiguration: !liveGenerationAvailable,
    liveGenerationAvailable,
    pricingConfidence: chosen?.pricingConfidence ?? 'unverified',
  };
  return { spec, decision, estimate, characterDescriptions: chars.descriptions, settingDescriptions: locs.descriptions, referenceAssetIds, keyframeRefs: keyframe ? referenceAssetIds : [] };
}

export async function estimateGeneration(ctx: AppContext, user: SessionLike, input: VideoSpecInput) {
  return (await prepareEstimate(ctx, user, input)).estimate;
}

export type CreateJobInput = {
  spec: VideoSpecInput;
  projectId?: string;
  shotId?: string;
  templateKey?: string;
  idempotencyKey: string;
  confirmEstimate: boolean;
  parentJobId?: string;
  /** Skip the per-user concurrency limit (movie children are limited by the movie job). */
  skipConcurrency?: boolean;
};

export type GenerationPlan = {
  user: SessionLike;
  input: CreateJobInput;
  spec: VideoSpec;
  estimate: GenerationEstimate;
  live: boolean;
  routing: Record<string, unknown> & { chosen: { modelKey: string; provider: string; segments: { durationSec: number; billedDurationSec: number }[] } };
};

/**
 * Create a video generation job.
 * 1. idempotency check  2. estimate & guards (read-only)  3. in one transaction: job row,
 * credit reservation and queue entry. A failure anywhere leaves nothing behind.
 */
export async function createGeneration(ctx: AppContext, user: SessionLike, input: CreateJobInput): Promise<{ job: Job; estimate: GenerationEstimate; created: boolean }> {
  const existing = await findByIdempotency(ctx.db, user.id, input.idempotencyKey);
  if (existing) return { job: existing, estimate: existing.routing?.estimate as GenerationEstimate, created: false };
  const plan = await planGeneration(ctx, user, input);
  try {
    const job = await commitGeneration(plan, ctx.db);
    return { job, estimate: plan.estimate, created: true };
  } catch (err) {
    // A concurrent request with the same idempotency key won the race.
    const winner = await findByIdempotency(ctx.db, user.id, input.idempotencyKey);
    if (winner) return { job: winner, estimate: winner.routing?.estimate as GenerationEstimate, created: false };
    throw err;
  }
}

async function findByIdempotency(db: Db, userId: string, key: string) {
  const [j] = await db.select().from(generationJobs).where(and(eq(generationJobs.userId, userId), eq(generationJobs.idempotencyKey, key)));
  return j;
}

/** Read-only phase: validation, routing, plan limits and spending guards. */
export async function planGeneration(ctx: AppContext, user: SessionLike, input: CreateJobInput): Promise<GenerationPlan> {
  const db = ctx.db;
  if (input.projectId) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.userId, user.id), isNull(projects.deletedAt)));
    if (!p) throw notFound('Project');
  }

  const prepared = await prepareEstimate(ctx, user, input.spec);
  const { estimate, decision, spec } = prepared;
  if (!estimate.ok || !decision.chosen) throw new AppError('generation_blocked', estimate.blockers?.[0] ?? 'This request cannot be generated', 422, { estimate });

  const live = estimate.liveGenerationAvailable;
  const fixture = !live;
  if (fixture && !ctx.env.devFixturesEnabled) {
    throw configurationRequired(
      ctx.liveEnabled
        ? `${decision.chosen.model.displayName} needs ${decision.chosen.model.provider} API credentials, which are not configured yet.`
        : 'Live AI generation is not enabled on this server yet.',
      { estimate },
    );
  }
  if (live && !input.confirmEstimate) throw new AppError('confirmation_required', `Please confirm the estimate of ${estimate.credits} credits.`, 409, { estimate });

  if (!input.skipConcurrency) {
    const plan = await getUserPlan(db, user.id);
    if ((await activeJobCount(db, user.id)) >= plan.limits.maxConcurrentJobs)
      throw new AppError('too_many_jobs', `Your plan runs up to ${plan.limits.maxConcurrentJobs} generations at once. Please wait for one to finish.`, 429);
  }

  if (live) {
    const spending = await getConfig(db, 'spending');
    const spentUsd = await committedProviderSpendToday(db);
    if (spentUsd + estimate.providerCostUsd > Math.min(spending.globalDailyProviderBudgetUsd, ctx.env.GLOBAL_DAILY_PROVIDER_BUDGET_USD)) {
      await audit(db, { action: 'spend.global_cap_hit', metadata: { spentUsd, estimate: estimate.providerCostUsd } });
      throw new AppError('capacity_paused', 'Generation capacity is temporarily paused. Please try again later.', 503);
    }
    const settings = await db.query.userSettings.findFirst({ where: (s, { eq: e }) => e(s.userId, user.id) });
    if (settings?.perJobSpendLimit && estimate.credits > settings.perJobSpendLimit)
      throw new AppError('spend_limit', `This costs ${estimate.credits} credits, above your per-video limit of ${settings.perJobSpendLimit}.`, 422);
    if (settings?.dailySpendLimit) {
      const spent = await creditsSpentToday(db, user.id);
      if (spent + estimate.credits > settings.dailySpendLimit)
        throw new AppError('spend_limit', `This needs ${estimate.credits} credits, but your daily limit is ${settings.dailySpendLimit} (${spent} spent today). Raise it in Settings → Spending limits.`, 422, { limit: settings.dailySpendLimit, spentToday: spent, required: estimate.credits });
    }
  }

  const chosen = decision.chosen;
  const routing = {
    estimate,
    chosen: {
      modelKey: chosen.model.key,
      provider: chosen.model.provider,
      resolution: chosen.resolution,
      generationAspect: chosen.generationAspect,
      cropToTarget: chosen.cropToTarget,
      audio: chosen.audio,
      segments: chosen.segments,
      providerCostUsd: chosen.providerCostUsd,
      supportsImageInput: chosen.model.capabilities.modes.includes('image-to-video'),
    },
    characterDescriptions: prepared.characterDescriptions,
    settingDescriptions: prepared.settingDescriptions,
    referenceAssetIds: prepared.referenceAssetIds,
    keyframeRefs: prepared.keyframeRefs,
  };
  return { user, input, spec, estimate, live, routing };
}

/**
 * Write phase: job row, credit reservation and queue entry in one transaction.
 * Pass an outer transaction to commit several plans atomically (movies).
 */
export async function commitGeneration(plan: GenerationPlan, db: Db): Promise<Job> {
  const { user, input, spec, estimate, live, routing } = plan;
  const chosen = routing.chosen;
  const fixture = !live;
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [j] = await t
      .insert(generationJobs)
      .values({
        userId: user.id,
        projectId: input.projectId,
        shotId: input.shotId,
        parentJobId: input.parentJobId,
        kind: 'video',
        status: 'queued',
        phase: 'Waiting in queue',
        request: { ...spec, templateKey: input.templateKey },
        routing,
        modelKey: chosen.modelKey,
        providerKey: fixture ? 'fixture' : chosen.provider,
        estimatedCostUsd: fixture ? 0 : estimate.providerCostUsd,
        estimatedCredits: fixture ? 0 : estimate.credits,
        idempotencyKey: input.idempotencyKey,
        isFixture: fixture,
        checkpoint: { segments: chosen.segments.map((s, i) => ({ index: i, ...s, status: 'pending' })) },
      })
      .returning();
    if (live) {
      const r = await reserveCredits(t, { userId: user.id, amount: estimate.credits, jobId: j!.id, description: `Video: ${spec.prompt.slice(0, 60)}`, idempotencyKey: `reserve:${j!.id}` });
      await t.update(generationJobs).set({ reservationId: r.reservationId }).where(eq(generationJobs.id, j!.id));
      j!.reservationId = r.reservationId;
    }
    await enqueue(t, VIDEO_JOB_HANDLER, { jobId: j!.id }, { queue: 'generation', dedupeKey: jobDedupeKey(j!.id), maxAttempts: 8 });
    return j!;
  });
}

export async function getOwnedJob(ctx: AppContext, user: SessionLike, jobId: string): Promise<Job> {
  const [j] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.id, jobId), user.role === 'admin' ? sql`true` : eq(generationJobs.userId, user.id)));
  if (!j) throw notFound('Generation');
  return j;
}

export async function cancelGeneration(ctx: AppContext, user: SessionLike, jobId: string): Promise<Job> {
  const job = await getOwnedJob(ctx, user, jobId);
  if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
  if (job.kind === 'movie') {
    // A film has no worker of its own: cancel its unfinished parts, then close it with what they charged.
    const children = await ctx.db.select().from(generationJobs).where(eq(generationJobs.parentJobId, jobId));
    for (const c of children.filter((c) => !['completed', 'failed', 'cancelled'].includes(c.status))) await cancelGeneration(ctx, user, c.id);
    const charged = (await ctx.db.select({ c: generationJobs.chargedCredits }).from(generationJobs).where(eq(generationJobs.parentJobId, jobId))).reduce((s, r) => s + (r.c ?? 0), 0);
    const [closed] = await ctx.db
      .update(generationJobs)
      .set({ status: 'cancelled', phase: 'Cancelled', cancelRequestedAt: new Date(), completedAt: new Date(), updatedAt: new Date(), chargedCredits: charged })
      .where(and(eq(generationJobs.id, jobId), inArray(generationJobs.status, ['queued', 'preparing', 'generating', 'processing', 'rendering'])))
      .returning();
    return closed ?? job;
  }
  if (job.status === 'queued' && !(job.checkpoint as { segments?: { externalId?: string }[] }).segments?.some((s) => s.externalId)) {
    // Nothing submitted to a provider yet: cancel immediately and release everything.
    const [updated] = await ctx.db
      .update(generationJobs)
      .set({ status: 'cancelled', phase: 'Cancelled', cancelRequestedAt: new Date(), completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, 'queued')))
      .returning();
    if (updated) {
      if (updated.reservationId) await settleReservation(ctx.db, { reservationId: updated.reservationId, chargeAmount: 0, description: 'Cancelled before generation started' });
      return updated;
    }
  }
  const [flagged] = await ctx.db.update(generationJobs).set({ cancelRequestedAt: new Date(), updatedAt: new Date() }).where(eq(generationJobs.id, jobId)).returning();
  await wakeJob(ctx.db, jobDedupeKey(jobId));
  return flagged!;
}

/** Retry a failed job as a new job (new idempotency key, fresh estimate and reservation). */
export async function retryGeneration(ctx: AppContext, user: SessionLike, jobId: string, idempotencyKey: string) {
  const job = await getOwnedJob(ctx, user, jobId);
  if (job.status !== 'failed' && job.status !== 'cancelled') throw badRequest('Only failed or cancelled generations can be retried');
  const { templateKey, ...spec } = job.request as VideoSpec & { templateKey?: string };
  return createGeneration(ctx, user, { spec, projectId: job.projectId ?? undefined, shotId: job.shotId ?? undefined, templateKey, idempotencyKey, confirmEstimate: true });
}

export async function toPublicJob(ctx: AppContext, job: Job): Promise<PublicJob> {
  let outputUrl: string | null = null;
  let thumbnailUrl: string | null = null;
  if (job.outputAssetId) {
    const [a] = await ctx.db.select().from(assets).where(eq(assets.id, job.outputAssetId));
    if (a) {
      outputUrl = await assetUrl(ctx, a);
      if (a.thumbnailAssetId) {
        const [t] = await ctx.db.select().from(assets).where(eq(assets.id, a.thumbnailAssetId));
        if (t) thumbnailUrl = await assetUrl(ctx, t);
      }
    }
  }
  const req = job.request as { prompt?: string };
  const eta = await estimateEta(ctx.db, job);
  const elapsedSec = eta.elapsedSec;
  let etaSec = eta.etaSec;
  let progress = job.progressSource === 'provider' ? job.progress : null;
  let phase = job.phase;
  if (job.kind === 'movie' && !['completed', 'failed', 'cancelled'].includes(job.status)) {
    // A film's progress is the average of its shots (plus its final render); ETA is the slowest one.
    const children = await ctx.db.select().from(generationJobs).where(eq(generationJobs.parentJobId, job.id));
    const shotsDone = children.filter((c) => c.kind === 'video').map((c) => (c.status === 'completed' ? 1 : c.progressSource === 'provider' ? (c.progress ?? 0) : 0));
    const render = children.find((c) => c.kind === 'render');
    const shotPart = shotsDone.length ? shotsDone.reduce((a, b) => a + b, 0) / shotsDone.length : 0;
    // Dubbed dialogue lines (recorded after the shots).
    const voices = children.filter((c) => c.kind === 'audio');
    const voicePart = voices.length ? voices.filter((c) => ['completed', 'failed', 'cancelled'].includes(c.status)).length / voices.length : 0;
    progress = render ? 0.85 + 0.15 * (render.status === 'completed' ? 1 : (render.progress ?? 0)) : shotsDone.length ? (voices.length ? 0.8 * shotPart + 0.05 * voicePart : 0.85 * shotPart) : 0.85 * voicePart;
    const active = children.filter((c) => !['completed', 'failed', 'cancelled'].includes(c.status));
    // Shots the provider hasn't started yet (no progress reported) wait for a free slot. Runway renders
    // one clip per model at a time on most accounts, so those queue up one after another.
    const waiting = active.filter((c) => c.kind === 'video' && c.progressSource !== 'provider');
    const rendering = active.filter((c) => !waiting.includes(c) && c.kind === 'video');
    const otherActive = active.filter((c) => c.kind !== 'video');
    const etaOf = async (c: Job) => (await estimateEta(ctx.db, c)).etaSec ?? 0;
    const renderingEta = Math.max(0, ...(await Promise.all([...rendering, ...otherActive].map(etaOf))));
    const waitingEtas = await Promise.all(waiting.map(async (c) => (await estimateEta(ctx.db, c, { notStarted: true })).etaSec ?? 0));
    const serial = waiting.filter((c) => c.providerKey === 'runway').length;
    const waitingEta = serial ? waitingEtas.reduce((a, b) => a + b, 0) : Math.max(0, ...waitingEtas);
    etaSec = active.length ? renderingEta + waitingEta + (render ? 0 : 30) : null;
    if (!render && rendering.length + waiting.length) {
      // Count the film's shots (as the shot list does), including logo cards made without a video job.
      const filmShots = job.projectId ? await ctx.db.select({ ready: shots.currentAssetId }).from(shots).where(eq(shots.projectId, job.projectId)) : [];
      const doneCount = filmShots.length ? filmShots.filter((x) => x.ready).length : children.filter((c) => c.kind === 'video' && c.status === 'completed').length;
      const parts = [rendering.length && `${rendering.length} rendering`, waiting.length && `${waiting.length} waiting for a free slot at the provider (started automatically, no extra charge)`].filter(Boolean);
      phase = `Generated ${doneCount} of ${filmShots.length || shotsDone.length} shots — ${parts.join(', ')}`;
    }
  }
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    phase,
    progress,
    progressSource: progress !== null ? 'provider' : 'phase',
    etaSec,
    elapsedSec,
    projectId: job.projectId,
    shotId: job.shotId,
    modelKey: job.modelKey,
    estimatedCredits: job.estimatedCredits,
    chargedCredits: job.chargedCredits,
    error: job.error,
    outputAssetId: job.outputAssetId,
    outputUrl,
    thumbnailUrl,
    isFixture: job.isFixture,
    prompt: req.prompt ?? null,
    enhancedPrompt: job.enhancedPrompt,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

export async function listJobs(ctx: AppContext, userId: string, opts: { projectId?: string; limit?: number; before?: Date; status?: string } = {}) {
  const conds = [eq(generationJobs.userId, userId)];
  if (opts.projectId) conds.push(eq(generationJobs.projectId, opts.projectId));
  if (opts.before) conds.push(lt(generationJobs.createdAt, opts.before));
  if (opts.status) conds.push(eq(generationJobs.status, opts.status as Job['status']));
  return ctx.db.select().from(generationJobs).where(and(...conds)).orderBy(desc(generationJobs.createdAt)).limit(Math.min(100, opts.limit ?? 30));
}

export async function providerJobsFor(ctx: AppContext, jobId: string) {
  return ctx.db.select().from(providerJobs).where(eq(providerJobs.generationJobId, jobId)).orderBy(providerJobs.segmentIndex, providerJobs.attempt);
}
