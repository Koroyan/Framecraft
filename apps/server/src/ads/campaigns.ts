import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AD_STYLES, adBriefSchema, adConceptSchema, adPlanSchema, adStyle, clipStartTimes, reviewPlanDiversity, timelineSchema, type AdBrief, type AdConcept, type AdPlan } from '@framecraft/shared';
import type { AppContext } from '../context';
import { adCampaigns, assets, brandKits, brandProducts, footageSegments, generationJobs, shots } from '../db/schema';
import { enqueue, type JobResult, type QueueJob } from '../queue/queue';
import type { SessionLike } from '../generation/service';
import { assetUrl, getOwnedAsset, prepOf } from '../services/assets';
import { getConfig } from '../services/admin-config';
import { quoteCredits } from '../pricing/pricing';
import { createAudioJob, estimateAudio } from '../audio/audio';
import { createRenderJob, getTimeline, saveTimeline } from '../editor/editor';
import { createAiEdit } from '../editing/ai-edit';
import { ALEPH } from '../providers/video/aleph';
import { badRequest, conflict, notFound, paymentRequired } from '../lib/errors';
import { analyzeCampaign, sceneCuts } from './analyze';
import { generateConcepts, planAd, type BrandContext } from './plan';
import { assembleAd } from './assemble';
import { ffmpeg as _ff, probe } from '../media/ffmpeg';
import { downloadAssetToTemp, type Asset } from '../services/assets';
import fsp from 'node:fs/promises';

void _ff;

/* Ad campaigns from real footage: analyse → plan → (edit) → assemble → voice/music → render → variants. */

export const brandKitInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  logoAssetId: z.string().uuid().nullable().optional(),
  colors: z.object({ primary: z.string().regex(/^#[0-9a-fA-F]{6}$/), secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/), text: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).optional(),
  fonts: z.object({ heading: z.string().max(20), body: z.string().max(20) }).optional(),
  voice: z.string().max(600).default(''),
  products: z.string().max(1500).default(''),
  ctas: z.array(z.string().max(120)).max(10).default([]),
  slogans: z.array(z.string().max(160)).max(10).default([]),
  handles: z.record(z.string().max(30), z.string().max(120)).default({}),
  website: z.string().max(300).nullable().optional(),
  musicStyle: z.string().max(200).default(''),
  offers: z.string().max(600).default(''),
  description: z.string().max(2000).default(''),
  industry: z.string().max(120).default(''),
  audience: z.string().max(600).default(''),
  markets: z.array(z.string().max(60)).max(20).default([]),
  languages: z.array(z.string().max(10)).max(10).default([]),
  contact: z.object({ email: z.string().max(200).optional(), phone: z.string().max(60).optional(), address: z.string().max(300).optional() }).default({}),
  restrictions: z.string().max(1500).default(''),
  vocabulary: z.array(z.string().max(60)).max(40).default([]),
  knowledge: z
    .object({
      facts: z.array(z.object({ id: z.string().max(40), text: z.string().min(1).max(500), kind: z.enum(['about', 'product', 'claim', 'audience', 'contact', 'price', 'other']), sourceUrl: z.string().max(500).nullable(), confidence: z.number().min(0).max(1), status: z.enum(['approved', 'pending', 'rejected']) })).max(200),
      sources: z.array(z.object({ url: z.string().max(500), kind: z.enum(['website', 'social', 'manual']), fetchedAt: z.string().max(40), status: z.enum(['read', 'blocked', 'manual']), note: z.string().max(500).optional() })).max(60),
    })
    .optional(),
});

export async function listBrandKits(ctx: AppContext, user: SessionLike) {
  const rows = await ctx.db.select().from(brandKits).where(eq(brandKits.userId, user.id)).orderBy(desc(brandKits.updatedAt));
  return Promise.all(rows.map(async (b) => ({ ...b, logoUrl: b.logoAssetId ? await assetUrl(ctx, await getOwnedAsset(ctx, user.id, b.logoAssetId)).catch(() => null) : null })));
}

export async function saveBrandKit(ctx: AppContext, user: SessionLike, raw: z.input<typeof brandKitInputSchema>, id?: string) {
  const input = brandKitInputSchema.parse(raw);
  if (input.logoAssetId) await getOwnedAsset(ctx, user.id, input.logoAssetId);
  if (id) {
    const [b] = await ctx.db.select().from(brandKits).where(and(eq(brandKits.id, id), eq(brandKits.userId, user.id)));
    if (!b) throw notFound('Brand kit');
    const [u] = await ctx.db.update(brandKits).set({ ...input, website: input.website ?? null, updatedAt: new Date() }).where(eq(brandKits.id, id)).returning();
    return u!;
  }
  const [b] = await ctx.db.insert(brandKits).values({ userId: user.id, ...input, website: input.website ?? null }).returning();
  return b!;
}

async function ownedCampaign(ctx: AppContext, user: SessionLike, id: string) {
  const [c] = await ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, id));
  if (!c || (c.userId !== user.id && user.role !== 'admin')) throw notFound('Campaign');
  return c;
}

const set = (ctx: AppContext, id: string, patch: Partial<typeof adCampaigns.$inferInsert>) => ctx.db.update(adCampaigns).set({ ...patch, updatedAt: new Date() }).where(eq(adCampaigns.id, id));

export async function createCampaign(ctx: AppContext, user: SessionLike, input: z.input<typeof adBriefSchema> & { title?: string }) {
  const brief = adBriefSchema.parse(input);
  let product: typeof brandProducts.$inferSelect | undefined;
  if (brief.productId) {
    [product] = await ctx.db.select().from(brandProducts).where(and(eq(brandProducts.id, brief.productId), eq(brandProducts.userId, user.id)));
    if (!product) throw notFound('Product');
    brief.brandKitId ??= product.brandKitId;
    // Nothing picked: use this product's own media (never another product's).
    if (!brief.footageAssetIds.length && !brief.imageAssetIds.length && product.mediaAssetIds.length) {
      const media = await ctx.db.select({ id: assets.id, mediaType: assets.mediaType }).from(assets).where(and(inArray(assets.id, product.mediaAssetIds), eq(assets.userId, user.id)));
      brief.footageAssetIds = media.filter((m) => m.mediaType === 'video').map((m) => m.id).slice(0, 20);
      brief.imageAssetIds = media.filter((m) => m.mediaType === 'image').map((m) => m.id).slice(0, 20);
    }
    if (!brief.productRefAssetIds.length) brief.productRefAssetIds = product.references.map((r) => r.assetId).slice(0, 8);
  }
  if (!brief.footageAssetIds.length && !brief.imageAssetIds.length) throw badRequest('Upload at least one video or photo of your product');
  for (const id of [...brief.footageAssetIds, ...brief.imageAssetIds, ...brief.productRefAssetIds, ...(brief.referenceAdAssetId ? [brief.referenceAdAssetId] : []), ...(brief.musicAssetId ? [brief.musicAssetId] : [])]) await getOwnedAsset(ctx, user.id, id);
  if (brief.brandKitId) {
    const [b] = await ctx.db.select().from(brandKits).where(and(eq(brandKits.id, brief.brandKitId), eq(brandKits.userId, user.id)));
    if (!b) throw notFound('Brand kit');
  }
  const [c] = await ctx.db.insert(adCampaigns).values({ userId: user.id, brandKitId: brief.brandKitId ?? null, productId: product?.id ?? null, title: (input.title || brief.request).slice(0, 80), brief, status: 'analyzing', phase: 'Waiting to analyse your footage', progress: 0 }).returning();
  await enqueue(ctx.db, 'ad.analyze', { campaignId: c!.id }, { queue: 'media', dedupeKey: `ad-analyze:${c!.id}`, maxAttempts: 2 });
  return c!;
}

export async function getCampaign(ctx: AppContext, user: SessionLike, id: string) {
  const c = await ownedCampaign(ctx, user, id);
  const segs = await ctx.db.select().from(footageSegments).where(eq(footageSegments.campaignId, id)).orderBy(asc(footageSegments.index));
  const ids = [...new Set([...segs.flatMap((s) => [s.assetId, s.frameAssetId ?? '']).filter(Boolean)])];
  const rows = ids.length ? await ctx.db.select().from(assets).where(inArray(assets.id, ids)) : [];
  const urls = Object.fromEntries(await Promise.all(rows.map(async (a) => [a.id, await assetUrl(ctx, a)] as const)));
  return { campaign: c, segments: segs.map((s) => ({ ...s, frameUrl: s.frameAssetId ? (urls[s.frameAssetId] ?? null) : null, sourceUrl: urls[s.assetId] ?? null, sourceName: rows.find((r) => r.id === s.assetId)?.originalName ?? null })) };
}

export async function listCampaigns(ctx: AppContext, user: SessionLike) {
  return ctx.db.select({ id: adCampaigns.id, title: adCampaigns.title, status: adCampaigns.status, projectId: adCampaigns.projectId, updatedAt: adCampaigns.updatedAt }).from(adCampaigns).where(eq(adCampaigns.userId, user.id)).orderBy(desc(adCampaigns.updatedAt)).limit(50);
}

// ---------------------------------------------------------------- cost

export async function estimateCampaign(ctx: AppContext, user: SessionLike, brief: AdBrief, plan: AdPlan) {
  let voice = 0;
  let voiceAvailable = true;
  if (brief.voiceover && plan.voiceover.length) {
    const e = await estimateAudio(ctx, user, { kind: 'tts', text: plan.voiceover.map((v) => v.text).join(' '), language: brief.language, idempotencyKey: 'estimate-only' });
    voice = e.credits;
    voiceAvailable = e.available;
  }
  let music = 0;
  let musicAvailable = true;
  const total = plan.scenes.reduce((s, x) => s + x.durationSec, 0);
  if (brief.music === 'generate') {
    const e = await estimateAudio(ctx, user, { kind: 'music', prompt: plan.musicMood, durationSec: Math.ceil(total + 3), idempotencyKey: 'estimate-only' });
    music = e.credits;
    musicAvailable = e.available;
  }
  const rules = await getConfig(ctx.db, 'pricing');
  const enhancements = brief.mode === 'enhanced' ? plan.scenes.filter((s) => s.enhance).map((s) => ({ sceneId: s.id, credits: quoteCredits(Math.max(ALEPH.minUsd, Math.min(ALEPH.maxInputSec, s.durationSec + 2) * ALEPH.usdPerSecond), s.durationSec, 'verified', rules).credits })) : [];
  const enhance = enhancements.reduce((s, e) => s + e.credits, 0);
  const budget = brief.budgetCredits ?? null;
  return { voice, voiceAvailable, music, musicAvailable, enhance, enhancements, editingAndRender: 0, assembleTotal: voice + music, budget, assembleWithinBudget: budget === null || voice + music <= budget, enhanceWithinBudget: budget === null || voice + music + enhance <= budget, note: 'Cutting, colour, titles, logo and export are local processing and cost no credits. AI enhancements run only when you start them, and each result is reviewed before it is used.' };
}

// ---------------------------------------------------------------- plan editing

export async function updatePlan(ctx: AppContext, user: SessionLike, id: string, input: unknown) {
  const c = await ownedCampaign(ctx, user, id);
  if (['analyzing', 'planning', 'assembling'].includes(c.status)) throw conflict('Wait until the current step finishes');
  const plan = adPlanSchema.parse(input);
  const segIds = new Set((await ctx.db.select({ id: footageSegments.id }).from(footageSegments).where(eq(footageSegments.campaignId, id))).map((s) => s.id));
  if (plan.scenes.some((s) => !segIds.has(s.segmentId))) throw badRequest('A scene uses footage that is not part of this campaign');
  const brief = adBriefSchema.parse(c.brief);
  if (brief.mode === 'original') plan.scenes.forEach((s) => (s.enhance = null));
  const estimate = await estimateCampaign(ctx, user, brief, plan);
  const segments = await ctx.db.select().from(footageSegments).where(eq(footageSegments.campaignId, id));
  const review = reviewPlanDiversity(plan, segments, brief.lengthSec);
  await set(ctx, id, { plan: { ...plan, estimate }, review: { diversity: review }, status: 'planned' });
  return { plan, estimate, review };
}

/** Change this ad's spending cap (null = no cap; every paid step still asks for approval). */
export async function setBudget(ctx: AppContext, user: SessionLike, id: string, budgetCredits: number | null) {
  const c = await ownedCampaign(ctx, user, id);
  const brief = adBriefSchema.parse({ ...c.brief, budgetCredits });
  const estimate = c.plan ? await estimateCampaign(ctx, user, brief, adPlanSchema.parse(c.plan)) : null;
  await set(ctx, id, { brief, ...(estimate ? { plan: { ...c.plan, estimate } } : {}) });
  return { budgetCredits, estimate };
}

/** Re-plan with another concept (no new analysis). */
export async function chooseConcept(ctx: AppContext, user: SessionLike, id: string, key: string) {
  const c = await ownedCampaign(ctx, user, id);
  if (['analyzing', 'planning', 'assembling'].includes(c.status)) throw conflict('Wait until the current step finishes');
  const concepts = (c.concepts ?? []).map((x) => adConceptSchema.parse(x));
  if (!concepts.some((x) => x.key === key)) throw notFound('Concept');
  await set(ctx, id, { brief: { ...c.brief, conceptKey: key }, status: 'planning', phase: 'Storyboarding the chosen concept', progress: 0.2 });
  await enqueue(ctx.db, 'ad.plan', { campaignId: id }, { queue: 'generation', dedupeKey: `ad-plan:${id}:${Date.now()}`, maxAttempts: 1 });
  return { queued: true };
}

/** Act on a diversity-review option (e.g. make the polished shorter ad the footage supports). */
export async function applyReviewOption(ctx: AppContext, user: SessionLike, id: string, key: 'shorter' | 'crops') {
  const c = await ownedCampaign(ctx, user, id);
  if (['analyzing', 'planning', 'assembling'].includes(c.status)) throw conflict('Wait until the current step finishes');
  const review = (c.review as { diversity?: ReturnType<typeof reviewPlanDiversity> } | null)?.diversity;
  const option = review?.options.find((o) => o.key === key);
  if (!option) throw badRequest('This option is not available for the current plan');
  if (key === 'shorter') {
    await set(ctx, id, { brief: { ...c.brief, lengthSec: option.lengthSec }, status: 'planning', phase: `Re-cutting as a ${option.lengthSec} s ad`, progress: 0.2 });
    await enqueue(ctx.db, 'ad.plan', { campaignId: id }, { queue: 'generation', dedupeKey: `ad-plan:${id}:${Date.now()}`, maxAttempts: 1 });
  }
  // 'crops': repeats are already separated into detail crops by the planner; accepting keeps the length.
  return { ok: true };
}

/** Re-plan everything, or swap one scene for the best unused segment (no AI call). */
export async function replan(ctx: AppContext, user: SessionLike, id: string, what: { scope: 'all' } | { scope: 'scene'; sceneIndex: number }) {
  const c = await ownedCampaign(ctx, user, id);
  if (what.scope === 'all') {
    await set(ctx, id, { status: 'planning', phase: 'Writing the creative plan', progress: 0.1 });
    await enqueue(ctx.db, 'ad.plan', { campaignId: id }, { queue: 'generation', dedupeKey: `ad-plan:${id}:${Date.now()}`, maxAttempts: 1 });
    return { queued: true };
  }
  const plan = adPlanSchema.parse(c.plan);
  const sc = plan.scenes[what.sceneIndex];
  if (!sc) throw notFound('Scene');
  const segs = await ctx.db.select().from(footageSegments).where(eq(footageSegments.campaignId, id));
  const used = new Set(plan.scenes.map((s) => s.segmentId));
  const alt = segs.filter((s) => s.role === 'footage' && !used.has(s.id) && !s.duplicateOf && s.endSec - s.startSec >= Math.min(sc.durationSec, 1)).sort((a, b) => ((b.scores as Record<string, number>).overall ?? 0) - ((a.scores as Record<string, number>).overall ?? 0))[0];
  if (!alt) throw badRequest('No other footage is available for this scene');
  plan.scenes[what.sceneIndex] = { ...sc, segmentId: alt.id, inSec: 0, crop: null, durationSec: Math.min(sc.durationSec, alt.endSec - alt.startSec) };
  return updatePlan(ctx, user, id, plan);
}

// ---------------------------------------------------------------- assemble

export async function startAssembly(ctx: AppContext, user: SessionLike, id: string, approvedCredits: number) {
  const c = await ownedCampaign(ctx, user, id);
  if (!c.plan) throw badRequest('Plan the ad first');
  if (['assembling', 'analyzing', 'planning'].includes(c.status)) throw conflict('This ad is already being prepared');
  const brief = adBriefSchema.parse(c.brief);
  const plan = adPlanSchema.parse(c.plan);
  const est = await estimateCampaign(ctx, user, brief, plan);
  if (est.assembleTotal > approvedCredits) throw paymentRequired(`Voice-over and music need ${est.assembleTotal} credits — approve that amount to continue.`, { required: est.assembleTotal });
  if (brief.budgetCredits !== null && est.assembleTotal > brief.budgetCredits) throw paymentRequired(`This step needs ${est.assembleTotal} credits, above your ${brief.budgetCredits}-credit budget for this ad. Raise the budget or turn off voice-over/music.`, { required: est.assembleTotal, budget: brief.budgetCredits });
  await set(ctx, id, { status: 'assembling', phase: 'Building the timeline', progress: 0.05, error: null });
  await enqueue(ctx.db, 'ad.assemble', { campaignId: id, userId: user.id, role: user.role }, { queue: 'generation', dedupeKey: `ad-assemble:${id}:${Date.now()}`, maxAttempts: 1 });
  return { queued: true, estimate: est };
}

async function narrator(ctx: AppContext, language: string, gender: AdBrief['voiceGender'] = 'auto') {
  const voices = await getConfig(ctx.db, 'voices');
  const pool = voices[language] ?? voices.default!;
  if (gender === 'female') return pool.female[0] ?? pool.narrator;
  if (gender === 'male') return pool.male[0] ?? pool.narrator;
  return pool.narrator ?? pool.male[0];
}

type Pending = { projectId: string; vo: { jobId: string; sceneIndex: number }[]; musicJobId: string | null; musicAssetId: string | null; label: string; variant: boolean; language?: string };

/** Assemble one project (main ad or a variant) and queue its voice-over and music. */
async function assembleOne(ctx: AppContext, user: SessionLike, campaignId: string, brief: AdBrief, plan: AdPlan, o: { label: string; variant: boolean; aspectRatio?: AdBrief['aspectRatio']; lengthScale?: number }): Promise<Pending> {
  const { projectId, durationSec } = await assembleAd(ctx, user, { campaignId, brief, plan, title: `${plan.title || 'Ad'}${o.variant ? ` · ${o.label}` : ''}`, aspectRatio: o.aspectRatio, lengthScale: o.lengthScale });
  const vo: Pending['vo'] = [];
  if (brief.voiceover && plan.voiceover.length && ctx.liveEnabled) {
    const voiceId = await narrator(ctx, brief.language, brief.voiceGender);
    for (const [i, line] of plan.voiceover.entries()) {
      try {
        const job = await createAudioJob(ctx, user, { kind: 'tts', text: line.text, language: brief.language, voiceId, projectId, idempotencyKey: `ad-vo:${projectId}:${i}` });
        vo.push({ jobId: job.job.id, sceneIndex: line.sceneIndex });
      } catch (err) {
        ctx.log.warn('ad voice-over not created', { message: (err as Error).message });
      }
    }
  }
  let musicJobId: string | null = null;
  if (brief.music === 'generate' && ctx.liveEnabled) {
    try {
      musicJobId = (await createAudioJob(ctx, user, { kind: 'music', prompt: `${plan.musicMood}. Instrumental, no vocals, commercial background score.`, durationSec: Math.ceil(durationSec + 2), projectId, idempotencyKey: `ad-music:${projectId}` })).job.id;
    } catch (err) {
      ctx.log.warn('ad music not created', { message: (err as Error).message });
    }
  }
  return { projectId, vo, musicJobId, musicAssetId: brief.music === 'upload' ? (brief.musicAssetId ?? null) : null, label: o.label, variant: o.variant, language: brief.language };
}

export async function runAssembleJob(ctx: AppContext, qj: QueueJob): Promise<JobResult> {
  const { campaignId, userId, role } = qj.payload as { campaignId: string; userId: string; role: 'user' | 'admin'; variant?: { label: string; aspectRatio?: AdBrief['aspectRatio']; lengthSec?: number; language?: AdBrief['language'] } };
  const variant = (qj.payload as { variant?: { label: string; aspectRatio?: AdBrief['aspectRatio']; lengthSec?: number; language?: AdBrief['language'] } }).variant;
  const user = { id: userId, role };
  const [c] = await ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, campaignId));
  if (!c) return;
  try {
    let brief = adBriefSchema.parse(c.brief);
    let plan = adPlanSchema.parse(c.plan);
    const total = plan.scenes.reduce((s, x) => s + x.durationSec, 0);
    let lengthScale = 1;
    if (variant) {
      if (variant.language && variant.language !== brief.language) {
        plan = await translatePlan(ctx, plan, variant.language);
        brief = { ...brief, language: variant.language };
      }
      if (variant.lengthSec) lengthScale = variant.lengthSec / Math.max(1, total);
      if (variant.aspectRatio) brief = { ...brief, aspectRatio: variant.aspectRatio };
    }
    const pending = await assembleOne(ctx, user, campaignId, brief, plan, { label: variant?.label ?? 'Main', variant: Boolean(variant), aspectRatio: brief.aspectRatio, lengthScale });
    if (!variant) await set(ctx, campaignId, { projectId: pending.projectId, phase: 'Recording voice-over and music', progress: 0.5 });
    await enqueue(ctx.db, 'ad.finish', { campaignId, userId, role, pending }, { queue: 'generation', dedupeKey: `ad-finish:${pending.projectId}`, delayMs: 2000, maxAttempts: 3 });
  } catch (err) {
    await set(ctx, campaignId, { status: 'failed', error: (err as Error).message.slice(0, 300), phase: 'Assembly failed' });
  }
}

/** When voice and music are ready, lay them on the timeline (music ducks under the voice) and render. */
export async function runFinishJob(ctx: AppContext, qj: QueueJob): Promise<JobResult> {
  const { campaignId, userId, role, pending } = qj.payload as { campaignId: string; userId: string; role: 'user' | 'admin'; pending: Pending };
  const user = { id: userId, role };
  const ids = [...pending.vo.map((v) => v.jobId), ...(pending.musicJobId ? [pending.musicJobId] : [])];
  const jobs = ids.length ? await ctx.db.select().from(generationJobs).where(inArray(generationJobs.id, ids)) : [];
  if (jobs.some((j) => !['completed', 'failed', 'cancelled'].includes(j.status))) return { rescheduleMs: 4000 };
  try {
    const { timeline: raw } = await getTimeline(ctx, user, pending.projectId);
    const tl = timelineSchema.parse(raw);
    const starts = clipStartTimes(tl);
    let cursor = 0;
    const missing: string[] = [];
    for (const v of pending.vo) {
      const j = jobs.find((x) => x.id === v.jobId);
      if (j?.status !== 'completed' || !j.outputAssetId) {
        missing.push('a voice-over line');
        continue;
      }
      const [a] = await ctx.db.select().from(assets).where(eq(assets.id, j.outputAssetId));
      const len = (a?.durationMs ?? 2000) / 1000;
      const start = Math.max(cursor, (starts[v.sceneIndex] ?? 0) + 0.25);
      tl.audio.push({ id: `auto-vo-${v.sceneIndex}`, assetId: j.outputAssetId, kind: 'voice', startSec: Math.round(start * 100) / 100, inSec: 0, outSec: len, volume: 1, fadeInSec: 0, fadeOutSec: 0, muted: false, duck: false, denoise: false });
      cursor = start + len + 0.2;
    }
    const total = starts.length ? (starts.at(-1) ?? 0) + (tl.clips.at(-1)!.outSec - tl.clips.at(-1)!.inSec) : 0;
    const musicAsset = pending.musicAssetId ?? jobs.find((x) => x.id === pending.musicJobId && x.status === 'completed')?.outputAssetId ?? null;
    if (pending.musicJobId && !musicAsset) missing.push('the music');
    if (musicAsset) {
      const [m] = await ctx.db.select().from(assets).where(eq(assets.id, musicAsset));
      tl.audio.push({ id: 'auto-music', assetId: musicAsset, kind: 'music', startSec: 0, inSec: 0, outSec: Math.min((m?.durationMs ?? total * 1000) / 1000, total + 1), volume: 0.55, fadeInSec: 0.5, fadeOutSec: 1.5, muted: false, duck: true, denoise: false });
    }
    await saveTimeline(ctx, user, pending.projectId, tl, { label: 'Voice-over and music' });
    const render = await createRenderJob(ctx, user, pending.projectId, { timeline: tl, preset: 'master', idempotencyKey: `ad-render:${pending.projectId}` });
    const [c] = await ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, campaignId));
    if (pending.variant) {
      // Atomic append: variants can finish at the same time.
      const entry = { projectId: pending.projectId, label: pending.label, aspectRatio: tl.aspectRatio, lengthSec: Math.round(total), language: pending.language ?? (c?.brief as AdBrief).language, renderJobId: render.id };
      await ctx.db.update(adCampaigns).set({ variants: sql`${adCampaigns.variants} || ${JSON.stringify([entry])}::jsonb`, updatedAt: new Date() }).where(eq(adCampaigns.id, campaignId));
    } else {
      await set(ctx, campaignId, { status: 'ready', phase: missing.length ? `Ready — without ${missing.join(' and ')} (the provider was unavailable)` : 'Ready — rendering the video', progress: 1, plan: { ...(c?.plan ?? {}), renderJobId: render.id } });
    }
  } catch (err) {
    await set(ctx, campaignId, { status: 'failed', error: (err as Error).message.slice(0, 300), phase: 'Finishing failed' });
  }
}

/** Translate on-screen texts, CTA and voice-over (fast tier); scenes and cuts stay the same. */
async function translatePlan(ctx: AppContext, plan: AdPlan, language: AdBrief['language']): Promise<AdPlan> {
  const schema = z.object({ overlays: z.array(z.string()), voiceover: z.array(z.string()), cta: z.string() });
  const res = await ctx.director.converse(
    { system: 'Translate advertising copy faithfully and naturally. Keep it short, keep brand names unchanged, add nothing.', prompt: `Target language: ${{ ka: 'Georgian', en: 'English', ru: 'Russian' }[language]}\n${JSON.stringify({ overlays: plan.scenes.map((s) => s.overlay?.text ?? ''), voiceover: plan.voiceover.map((v) => v.text), cta: plan.cta })}`, schema, tier: 'fast', maxTokens: 2000 },
    () => ({ overlays: plan.scenes.map((s) => s.overlay?.text ?? ''), voiceover: plan.voiceover.map((v) => v.text), cta: plan.cta }),
  );
  return {
    ...plan,
    cta: res.cta || plan.cta,
    scenes: plan.scenes.map((s, i) => (s.overlay && res.overlays[i] ? { ...s, overlay: { ...s.overlay, text: res.overlays[i]!.slice(0, 120) } } : s)),
    voiceover: plan.voiceover.map((v, i) => ({ ...v, text: (res.voiceover[i] || v.text).slice(0, 400) })),
  };
}

export async function createVariant(ctx: AppContext, user: SessionLike, id: string, v: { aspectRatio?: AdBrief['aspectRatio']; lengthSec?: number; language?: AdBrief['language'] }) {
  const c = await ownedCampaign(ctx, user, id);
  if (!c.plan || !c.projectId) throw badRequest('Make the main ad first');
  const label = [v.aspectRatio, v.lengthSec ? `${v.lengthSec}s` : '', v.language?.toUpperCase()].filter(Boolean).join(' · ') || 'Variant';
  await enqueue(ctx.db, 'ad.assemble', { campaignId: id, userId: user.id, role: user.role, variant: { label, ...v } }, { queue: 'generation', dedupeKey: `ad-variant:${id}:${label}:${Date.now()}`, maxAttempts: 1 });
  return { queued: true, label };
}

// ---------------------------------------------------------------- AI-enhanced mode

const LOCK = {
  strict: 'The product must stay exactly as in the input video — same shape, proportions, colours, materials, surface details, markings and branding. Do not alter the product in any way.',
  guided: 'Keep the product’s shape, proportions, colours and markings identical to the input video.',
  creative: 'Keep the product recognisable.',
} as const;

/** Start the plan's reviewable AI enhancements (each becomes a new version, never auto-used). */
export async function runEnhancements(ctx: AppContext, user: SessionLike, id: string, approvedCredits: number, sceneIds?: string[]) {
  const c = await ownedCampaign(ctx, user, id);
  const brief = adBriefSchema.parse(c.brief);
  if (brief.mode !== 'enhanced') throw badRequest('This ad uses original footage only');
  if (!c.projectId || !c.plan) throw badRequest('Assemble the ad first');
  const plan = adPlanSchema.parse(c.plan);
  const est = await estimateCampaign(ctx, user, brief, plan);
  // A subset (e.g. one shot as a preview) costs only its own shots.
  const chosen = sceneIds?.length ? est.enhancements.filter((e) => sceneIds.includes(e.sceneId)) : est.enhancements;
  if (sceneIds?.length && !chosen.length) throw badRequest('None of these shots has an AI enhancement planned');
  const cost = chosen.reduce((t, e) => t + e.credits, 0);
  if (cost > approvedCredits) throw paymentRequired(`The selected enhancements need ${cost} credits — approve that amount to start them.`, { required: cost });
  if (brief.budgetCredits !== null && cost + est.assembleTotal > brief.budgetCredits) throw paymentRequired(`The enhancements would take this ad to ${cost + est.assembleTotal} credits, above your ${brief.budgetCredits}-credit budget.`, { required: cost, budget: brief.budgetCredits });
  const { timeline } = await getTimeline(ctx, user, c.projectId);
  const projShots = await ctx.db.select().from(shots).where(eq(shots.projectId, c.projectId));
  const started: string[] = [];
  for (const [i, sc] of plan.scenes.entries()) {
    if (!sc.enhance || !chosen.some((e) => e.sceneId === sc.id)) continue;
    const shot = projShots.find((s) => s.index === i);
    const clip = shot && timeline.clips.find((x) => x.shotId === shot.id);
    if (!shot || !clip || clip.freezeSec) continue;
    const r = await createAiEdit(ctx, user, { shotId: shot.id, versionId: clip.versionId, mode: sc.enhance.mode, instruction: `${sc.enhance.instruction}. ${LOCK[brief.preservation]}`, startSec: clip.inSec, endSec: clip.outSec, referenceAssetIds: [], idempotencyKey: `ad-enhance:${c.projectId}:${sc.id}` });
    started.push(r.operation.id);
  }
  return { started };
}

// ---------------------------------------------------------------- queue handlers

export async function runAnalyzeJob(ctx: AppContext, qj: QueueJob): Promise<JobResult> {
  const { campaignId } = qj.payload as { campaignId: string };
  const [c] = await ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, campaignId));
  if (!c) return;
  try {
    // Wait for MOV/HEVC/4K uploads to get their editing proxy (analysis reads the proxy).
    const ids = (c.brief as AdBrief).footageAssetIds ?? [];
    const files = ids.length ? await ctx.db.select().from(assets).where(inArray(assets.id, ids)) : [];
    const preparing = files.filter((a) => prepOf(a)?.status === 'processing');
    if (preparing.length && Date.now() - c.createdAt.getTime() < 60 * 60_000) {
      await set(ctx, campaignId, { phase: `Optimizing ${preparing.length} video${preparing.length > 1 ? 's' : ''} for AI (converting and compressing)`, progress: 0.02 });
      return { rescheduleMs: 3000 };
    }
    const result = await analyzeCampaign(ctx, campaignId, async (phase, progress) => {
      await set(ctx, campaignId, { phase, progress });
    });
    const brief = c.brief as AdBrief;
    let reference = null;
    if (brief.referenceAdAssetId) {
      const ref = await getOwnedAsset(ctx, c.userId, brief.referenceAdAssetId);
      const file = await downloadAssetToTemp(ctx, ref as Asset);
      try {
        const dur = (await probe(file)).durationSec;
        const cuts = await sceneCuts(file, 0.3);
        const bounds = [0, ...cuts, dur];
        const lens = bounds.slice(1).map((b, i) => b - bounds[i]!).filter((l) => l > 0.2);
        reference = { shots: lens.length, avgShotSec: lens.reduce((s, l) => s + l, 0) / Math.max(1, lens.length), hookSec: lens[0] ?? 0, totalSec: dur };
      } finally {
        await fsp.rm(file, { force: true });
      }
    }
    await set(ctx, campaignId, { analysis: { ...result, reference }, status: 'planning', phase: 'Writing the creative plan', progress: 0.85 });
    await enqueue(ctx.db, 'ad.plan', { campaignId }, { queue: 'generation', dedupeKey: `ad-plan:${campaignId}:first`, maxAttempts: 1 });
  } catch (err) {
    await set(ctx, campaignId, { status: 'failed', error: (err as Error).message.slice(0, 300), phase: 'Analysis failed' });
  }
}

/** Brand facts the planner may use: approved knowledge only, and the selected product. */
export async function brandContext(ctx: AppContext, brief: AdBrief, productId?: string | null): Promise<BrandContext> {
  const brand = brief.brandKitId ? (await ctx.db.select().from(brandKits).where(eq(brandKits.id, brief.brandKitId)))[0] : undefined;
  if (!brand) return null;
  const [product] = productId ? await ctx.db.select().from(brandProducts).where(eq(brandProducts.id, productId)) : [];
  const facts = (brand.knowledge?.facts ?? []).filter((f) => f.status === 'approved').map((f) => f.text).slice(0, 40);
  return {
    name: brand.name,
    voice: brand.voice,
    products: brand.products,
    ctas: brand.ctas,
    slogans: brand.slogans,
    offers: brand.offers,
    website: brand.website,
    description: brand.description,
    audience: brand.audience,
    restrictions: brand.restrictions,
    vocabulary: brand.vocabulary,
    facts,
    product: product ? { name: product.name, description: product.description, claims: product.claims, price: product.price } : null,
  };
}

export async function runPlanJob(ctx: AppContext, qj: QueueJob): Promise<JobResult> {
  const { campaignId } = qj.payload as { campaignId: string };
  const [c] = await ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, campaignId));
  if (!c) return;
  try {
    const brief = adBriefSchema.parse(c.brief);
    const segments = await ctx.db.select().from(footageSegments).where(eq(footageSegments.campaignId, campaignId)).orderBy(asc(footageSegments.index));
    const brand = await brandContext(ctx, brief, c.productId);
    const reference = (c.analysis as { reference?: { shots: number; avgShotSec: number; hookSec: number } | null } | null)?.reference ?? null;
    // Concepts once per campaign (re-planning with another concept reuses them).
    let concepts: AdConcept[] = (c.concepts ?? []).map((x) => adConceptSchema.parse(x));
    if (!concepts.length) {
      await set(ctx, campaignId, { phase: 'Developing three creative concepts', progress: 0.88 });
      concepts = (await generateConcepts(ctx, { brief, segments, brand, styleKeys: AD_STYLES.map((s) => s.key) })).concepts;
    }
    const concept = concepts.find((x) => x.key === brief.conceptKey) ?? concepts.find((x) => x.recommended) ?? concepts[0] ?? null;
    await set(ctx, campaignId, { concepts, phase: `Storyboarding "${concept?.name ?? 'the ad'}"`, progress: 0.92 });
    // The concept sets the style, unless the user picked a style and has not chosen another concept.
    const explicitStyle = !brief.conceptKey && AD_STYLES.some((s) => s.key === brief.style) && brief.style !== concept?.style && !concepts.some((x) => x.style === brief.style) ? brief.style : null;
    const styled = { ...brief, style: explicitStyle ?? concept?.style ?? (AD_STYLES.some((s) => s.key === brief.style) ? brief.style : AD_STYLES[0]!.key) };
    const plan = await planAd(ctx, { brief: styled, segments, brand, concept: explicitStyle ? null : concept, reference });
    const user = { id: c.userId, role: 'user' as const };
    const estimate = await estimateCampaign(ctx, user, brief, plan);
    const review = reviewPlanDiversity(plan, segments, brief.lengthSec);
    await set(ctx, campaignId, { plan: { ...plan, estimate }, review: { diversity: review }, title: plan.title || c.title, status: 'planned', phase: plan.source === 'offline' ? 'Plan ready (without the AI Director — review it)' : 'Plan ready — review the storyboard', progress: 1 });
  } catch (err) {
    await set(ctx, campaignId, { status: 'failed', error: (err as Error).message.slice(0, 300), phase: 'Planning failed' });
  }
}

export { adStyle };
