import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ASPECT_DIMENSIONS, movieBriefSchema, stillLook, type AspectRatio, type MovieBrief, type VideoSpecInput, type TimelineInput } from '@framecraft/shared';
import type { AppContext } from '../context';
import type { Db } from '../db/client';
import fsp from 'node:fs/promises';
import { assets, characterReferences, characters, generationJobs, locationReferences, locations, projects, scenes, shots, storyboards } from '../db/schema';
import { downloadAssetToTemp, getOwnedAsset, storeAsset, tmpFile } from '../services/assets';
import { ffmpeg, generateLogoCard } from '../media/ffmpeg';
import type { LlmImage } from '../director/llm';
import crypto from 'node:crypto';
import { commitGeneration, createGeneration, planGeneration, prepareEstimate, type GenerationPlan, type SessionLike } from '../generation/service';
import { buildDefaultTimeline, createRenderJob, getOwnedProject, keepEditorChanges, saveTimeline } from '../editor/editor';
import { createImageJob, estimateImage } from '../images/images';
import { enqueue, type QueueJob } from '../queue/queue';
import { AppError, badRequest, notFound } from '../lib/errors';
import { committedProviderSpendToday, getUserPlan, notify } from '../services/common';
import { getConfig } from '../services/admin-config';
import type { MoviePlan } from '../director/director';
import { clearVoiceSelection, dubTrack, dubsDialogue, estimateDialogue, filmDialogue, LIP_SYNC_DIRECTION, NO_SPEECH_DIRECTION, selectVoiceTake, shotSpeechTrack, startDubbing } from './dub';
import { VIDEO_MODELS } from '../catalog/video-models';
import { estimateSoundtrack, soundtrackTrack, startSoundtrack } from './soundtrack';

type Shot = typeof shots.$inferSelect;

/** `opts.kind` 'ad' marks an Ad Studio commercial (logo overlay + call to action when assembled). */
export async function createMovie(ctx: AppContext, user: SessionLike, briefInput: unknown, idempotencyKey: string, opts: { kind?: 'movie' | 'ad'; settings?: Record<string, unknown> } = {}) {
  const brief = movieBriefSchema.parse(briefInput);
  const plan = await getUserPlan(ctx.db, user.id);
  if (brief.lengthSec > plan.limits.maxMovieSeconds) throw new AppError('plan_limit', `Your ${plan.name} plan supports films up to ${plan.limits.maxMovieSeconds} seconds.`, 422);
  const [existing] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.userId, user.id), eq(generationJobs.idempotencyKey, idempotencyKey)));
  if (existing) return { projectId: existing.projectId!, planJobId: existing.id };
  // Reference photos must be the user's own images.
  for (const r of brief.references) {
    const a = await getOwnedAsset(ctx, user.id, r.assetId);
    if (a.mediaType !== 'image') throw badRequest(`${r.token} must be an image`);
  }
  return ctx.db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ userId: user.id, kind: opts.kind ?? 'movie', title: brief.idea.slice(0, 80), aspectRatio: brief.aspectRatio, settings: { ...opts.settings, brief } })
      .returning();
    const [job] = await tx
      .insert(generationJobs)
      .values({ userId: user.id, projectId: project!.id, kind: 'plan', status: 'queued', phase: 'Writing the screenplay', request: { brief }, idempotencyKey })
      .returning();
    await enqueue(tx as never, 'movie.plan', { jobId: job!.id }, { queue: 'generation', dedupeKey: `plan:${job!.id}`, maxAttempts: 2 });
    return { projectId: project!.id, planJobId: job!.id };
  });
}

export async function runMoviePlan(ctx: AppContext, qj: QueueJob) {
  const [job] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, String(qj.payload.jobId)));
  if (!job || job.status !== 'queued') return;
  const brief = movieBriefSchema.parse((job.request as { brief: unknown }).brief);
  await ctx.db.update(generationJobs).set({ status: 'preparing', phase: 'AI Director is writing the screenplay', startedAt: new Date() }).where(eq(generationJobs.id, job.id));
  const revision = (job.request as { revision?: string }).revision;
  const replan = Boolean((job.request as { replan?: boolean }).replan);
  try {
    let plan;
    if (revision) {
      // Chat edit ("make her older, add a scene at the market…"): revise the plan as it is now,
      // including the user's manual edits in Director mode.
      await ctx.db.update(generationJobs).set({ phase: 'AI Director is revising the screenplay' }).where(eq(generationJobs.id, job.id));
      plan = await ctx.director.revisePlan(await planFromDb(ctx.db, job.projectId!, brief), revision, brief);
    } else {
      const images = ctx.director.llmAvailable ? await referenceImagesForLlm(ctx, job.userId, brief) : [];
      plan = await ctx.director.screenplay(brief, images);
    }
    const [proj] = await ctx.db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, job.projectId!));
    const castIds = (proj?.settings as { cartoon?: { characterIds?: string[] } } | undefined)?.cartoon?.characterIds ?? [];
    const cast = castIds.length ? await ctx.db.select({ id: characters.id, name: characters.name }).from(characters).where(and(inArray(characters.id, castIds), eq(characters.userId, job.userId))) : [];
    await persistPlan(ctx.db, job.userId, job.projectId!, plan, plan.source, brief, { replace: Boolean(revision) || replan, cast });
    if (replan) await ctx.db.update(projects).set({ settings: sql`${projects.settings} || ${JSON.stringify({ brief })}::jsonb`, aspectRatio: brief.aspectRatio, updatedAt: new Date() }).where(eq(projects.id, job.projectId!));
    await ctx.db
      .update(generationJobs)
      .set({ status: 'completed', phase: plan.source === 'llm' ? 'Screenplay ready' : 'Draft plan ready (offline planner — AI Director not configured)', completedAt: new Date(), progress: 1, actualCostUsd: plan.usage?.costUsd ?? 0, checkpoint: { source: plan.source, notice: plan.notice } })
      .where(eq(generationJobs.id, job.id));
    await notify(ctx.db, { userId: job.userId, type: 'movie.planned', title: 'Your film plan is ready to review', link: `/app/movie/${job.projectId}` });
  } catch (err) {
    await ctx.db.update(generationJobs).set({ status: 'failed', phase: 'Planning failed', error: { code: 'plan_failed', message: (err as Error).message.slice(0, 300), retryable: true }, completedAt: new Date() }).where(eq(generationJobs.id, job.id));
  }
}

/** Downscale the brief's photos (max 1024px JPEG) so the AI Director can see them cheaply. */
async function referenceImagesForLlm(ctx: AppContext, userId: string, brief: MovieBrief): Promise<LlmImage[]> {
  const out: LlmImage[] = [];
  for (const r of brief.references) {
    const a = await getOwnedAsset(ctx, userId, r.assetId);
    const src = await downloadAssetToTemp(ctx, a);
    const small = tmpFile('.jpg');
    try {
      await ffmpeg(['-i', src, '-vf', "scale='min(1024,iw)':-2", '-frames:v', '1', '-q:v', '4', small]);
      out.push({ label: `${r.token}${r.note ? ` (${r.note})` : ''}:`, mediaType: 'image/jpeg', data: (await fsp.readFile(small)).toString('base64') });
    } finally {
      await Promise.all([fsp.rm(src, { force: true }), fsp.rm(small, { force: true })]);
    }
  }
  return out;
}

/**
 * The project's current plan rebuilt from the database (so revisions see Director-mode edits),
 * with reference photos mapped back to their photoN tokens.
 */
export async function planFromDb(db: Db, projectId: string, brief: MovieBrief): Promise<MoviePlan> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  const chars = await db.select().from(characters).where(eq(characters.projectId, projectId)).orderBy(asc(characters.createdAt));
  const locs = await db.select().from(locations).where(eq(locations.projectId, projectId)).orderBy(asc(locations.createdAt));
  const sceneRows = await db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(asc(scenes.index));
  const shotRows = await db.select().from(shots).where(eq(shots.projectId, projectId)).orderBy(asc(shots.index));
  const charRefs = chars.length ? await db.select().from(characterReferences).where(inArray(characterReferences.characterId, chars.map((c) => c.id))) : [];
  const locRefs = locs.length ? await db.select().from(locationReferences).where(inArray(locationReferences.locationId, locs.map((l) => l.id))) : [];
  const tokenOf = new Map(brief.references.map((r) => [r.assetId, r.token]));
  const tokens = (ids: string[]) => [...new Set(ids.map((id) => tokenOf.get(id)).filter(Boolean) as string[])];
  const cKey = new Map(chars.map((c, i) => [c.id, `c${i + 1}`]));
  const lKey = new Map(locs.map((l, i) => [l.id, `l${i + 1}`]));
  const meta = (project?.plan ?? {}) as { title?: string; logline?: string; genre?: string; music?: { mood: string; prompt: string } };
  // Narrator-style speakers without a character keep their name as the key.
  const speakerKey = (d: { characterId?: string; speaker: string }) => {
    const id = d.characterId ?? chars.find((c) => c.name === d.speaker)?.id;
    return (id && cKey.get(id)) || d.speaker;
  };
  return {
    title: meta.title ?? project?.title ?? 'Untitled',
    logline: meta.logline ?? '',
    genre: meta.genre ?? brief.genre ?? '',
    characters: chars.map((c) => {
      const v = c.voice as { style?: string; gender?: string };
      return { key: cKey.get(c.id)!, name: c.name, description: c.description, appearance: c.appearance?.distinguishing ?? '', clothing: c.clothing, voiceStyle: v.style ?? 'natural', gender: v.gender === 'male' || v.gender === 'female' ? v.gender : 'unknown', referenceTokens: tokens(charRefs.filter((r) => r.characterId === c.id).map((r) => r.assetId)) };
    }),
    locations: locs.map((l) => ({ key: lKey.get(l.id)!, name: l.name, description: l.description, referenceTokens: tokens(locRefs.filter((r) => r.locationId === l.id).map((r) => r.assetId)) })),
    scenes: sceneRows.map((sc) => ({
      title: sc.title,
      synopsis: sc.synopsis,
      locationKey: (sc.locationId && lKey.get(sc.locationId)) || 'l1',
      shots: shotRows
        .filter((s) => s.sceneId === sc.id)
        .map((s) => ({
          description: s.description,
          prompt: s.prompt,
          durationSec: s.durationSec,
          shotType: s.shotType ?? 'medium',
          camera: s.camera ?? 'static',
          characterKeys: s.characterIds.map((id) => cKey.get(id)).filter(Boolean) as string[],
          dialogue: s.dialogue.map((d) => ({ speakerKey: speakerKey(d), line: d.line })),
          sfx: s.sfx ?? '',
          needsNativeAudio: s.dialogue.length > 0,
          referenceTokens: tokens(s.referenceAssetIds),
        })),
    })),
    music: meta.music ?? { mood: 'cinematic', prompt: '' },
  };
}

/** Replace the project's scenes/shots with a plan. `replace` also replaces its characters & locations (re-plans). */
export async function persistPlan(db: Db, userId: string, projectId: string, plan: MoviePlan, source: string, brief?: MovieBrief, opts: { replace?: boolean; cast?: { id: string; name: string }[] } = {}) {
  const tokenAsset = new Map((brief?.references ?? []).map((r) => [r.token, r.assetId]));
  const assetsFor = (tokens: string[] | undefined) => [...new Set((tokens ?? []).map((t) => tokenAsset.get(t)).filter(Boolean) as string[])];
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    if (opts.replace) {
      await t.delete(scenes).where(eq(scenes.projectId, projectId));
      await t.delete(characters).where(eq(characters.projectId, projectId));
      await t.delete(locations).where(eq(locations.projectId, projectId));
    }
    const charIds = new Map<string, string>();
    const same = (a: string, b: string) => {
      const x = a.trim().toLowerCase();
      const y = b.trim().toLowerCase();
      return x === y || x.split(/\s+/).includes(y) || y.split(/\s+/).includes(x);
    };
    for (const c of plan.characters) {
      // A saved character (Character Bible) is cast as itself: its approved look and references carry over.
      const own = opts.cast?.find((x) => same(c.name, x.name));
      if (own) {
        charIds.set(c.key, own.id);
        continue;
      }
      const [row] = await t
        .insert(characters)
        .values({ userId, projectId, name: c.name, description: c.description, appearance: { distinguishing: c.appearance }, clothing: c.clothing, voice: { style: c.voiceStyle, ...(c.gender && c.gender !== 'unknown' ? { gender: c.gender } : {}) } })
        .returning({ id: characters.id });
      charIds.set(c.key, row!.id);
      const refs = assetsFor(c.referenceTokens);
      if (refs.length) await t.insert(characterReferences).values(refs.map((assetId, i) => ({ characterId: row!.id, assetId, isPrimary: i === 0, label: 'User reference photo' }))).onConflictDoNothing();
    }
    const locIds = new Map<string, string>();
    for (const l of plan.locations) {
      const [row] = await t.insert(locations).values({ userId, projectId, name: l.name, description: l.description }).returning({ id: locations.id });
      locIds.set(l.key, row!.id);
      const refs = assetsFor(l.referenceTokens);
      if (refs.length) await t.insert(locationReferences).values(refs.map((assetId) => ({ locationId: row!.id, assetId }))).onConflictDoNothing();
    }
    await t.delete(scenes).where(eq(scenes.projectId, projectId));
    for (const [si, s] of plan.scenes.entries()) {
      const [scene] = await t
        .insert(scenes)
        .values({ projectId, index: si, title: s.title, synopsis: s.synopsis, locationId: locIds.get(s.locationKey), continuity: { locationKey: s.locationKey } })
        .returning({ id: scenes.id });
      for (const [hi, sh] of s.shots.entries()) {
        await t.insert(shots).values({
          projectId,
          sceneId: scene!.id,
          index: hi,
          description: sh.description,
          prompt: sh.prompt,
          durationSec: sh.durationSec,
          shotType: sh.shotType,
          camera: sh.camera,
          characterIds: sh.characterKeys.map((k) => charIds.get(k)).filter(Boolean) as string[],
          dialogue: sh.dialogue.map((d) => ({ characterId: charIds.get(d.speakerKey), speaker: plan.characters.find((c) => c.key === d.speakerKey)?.name ?? d.speakerKey, line: d.line })),
          sfx: sh.sfx || null,
          referenceAssetIds: assetsFor(sh.referenceTokens),
        });
      }
    }
    const [prev] = await t.select({ v: storyboards.version }).from(storyboards).where(eq(storyboards.projectId, projectId)).orderBy(asc(storyboards.version));
    await t.insert(storyboards).values({ projectId, version: (prev?.v ?? 0) + 1, data: plan as unknown as Record<string, unknown>, source });
    await t.update(projects).set({ title: plan.title.slice(0, 120), plan: { title: plan.title, logline: plan.logline, genre: plan.genre, music: plan.music, source }, updatedAt: new Date() }).where(eq(projects.id, projectId));
  });
}

/**
 * Re-plan before any shot is generated: a new brief (`brief`) rewrites the screenplay, or a
 * `revision` (the user's words) edits the current one. Returns the plan job.
 */
export async function replanMovie(ctx: AppContext, user: SessionLike, projectId: string, p: { brief?: unknown; revision?: string; idempotencyKey: string }) {
  const [existing] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.userId, user.id), eq(generationJobs.idempotencyKey, p.idempotencyKey)));
  if (existing) return existing;
  const project = await getOwnedProject(ctx, user, projectId);
  const generated = await ctx.db.select({ id: shots.id }).from(shots).where(and(eq(shots.projectId, projectId), sql`${shots.currentAssetId} is not null`)).limit(1);
  if (generated.length) throw new AppError('conflict', 'Shots are already generated — edit individual shots instead of rewriting the screenplay.', 409);
  const busy = await ctx.db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(and(eq(generationJobs.projectId, projectId), inArray(generationJobs.kind, ['plan', 'movie']), inArray(generationJobs.status, ['queued', 'preparing', 'generating', 'rendering'])));
  if (busy.length) throw new AppError('conflict', 'The screenplay is still being written — try again in a moment.', 409);
  const current = movieBriefSchema.parse((project.settings as { brief: unknown }).brief);
  const brief = p.brief ? movieBriefSchema.parse({ ...current, ...(p.brief as object) }) : current;
  const [job] = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .insert(generationJobs)
      .values({ userId: user.id, projectId, kind: 'plan', status: 'queued', phase: p.revision ? 'Revising the screenplay' : 'Writing the screenplay', request: { brief, revision: p.revision, replan: !p.revision }, idempotencyKey: p.idempotencyKey })
      .returning();
    await enqueue(tx as never, 'movie.plan', { jobId: rows[0]!.id }, { queue: 'generation', dedupeKey: `plan:${rows[0]!.id}`, maxAttempts: 2 });
    return rows;
  });
  return job!;
}

export async function getMovie(ctx: AppContext, user: SessionLike, projectId: string) {
  const project = await getOwnedProject(ctx, user, projectId);
  const sceneRows = await ctx.db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(asc(scenes.index));
  const shotRows = await ctx.db.select().from(shots).where(eq(shots.projectId, projectId)).orderBy(asc(shots.index));
  const chars = await ctx.db.select().from(characters).where(and(eq(characters.projectId, projectId), eq(characters.userId, user.id)));
  const locs = await ctx.db.select().from(locations).where(and(eq(locations.projectId, projectId), eq(locations.userId, user.id)));
  const jobs = await ctx.db.select().from(generationJobs).where(eq(generationJobs.projectId, projectId)).orderBy(asc(generationJobs.createdAt));
  const charRefs = chars.length ? await ctx.db.select().from(characterReferences).where(inArray(characterReferences.characterId, chars.map((c) => c.id))) : [];
  const locRefs = locs.length ? await ctx.db.select().from(locationReferences).where(inArray(locationReferences.locationId, locs.map((l) => l.id))) : [];
  const assetIds = [
    ...shotRows.flatMap((s) => [s.currentAssetId, s.storyboardAssetId, ...s.referenceAssetIds]),
    ...charRefs.map((r) => r.assetId),
    ...locRefs.map((r) => r.assetId),
  ].filter(Boolean) as string[];
  const assetRows = assetIds.length ? await ctx.db.select().from(assets).where(inArray(assets.id, [...new Set(assetIds)])) : [];
  return {
    project,
    scenes: sceneRows.map((sc) => ({ ...sc, shots: shotRows.filter((s) => s.sceneId === sc.id) })),
    characters: chars.map((c) => ({ ...c, referenceAssetIds: charRefs.filter((r) => r.characterId === c.id).map((r) => r.assetId) })),
    locations: locs.map((l) => ({ ...l, referenceAssetIds: locRefs.filter((r) => r.locationId === l.id).map((r) => r.assetId) })),
    planJob: jobs.filter((j) => j.kind === 'plan').at(-1) ?? null,
    movieJob: jobs.filter((j) => j.kind === 'movie').at(-1) ?? null,
    renderJob: jobs.filter((j) => j.kind === 'render').at(-1) ?? null,
    shotJobs: jobs.filter((j) => j.kind === 'video'),
    assets: assetRows,
  };
}

// ----------------------------------------------------------------- Director Mode editing

async function ownedShot(ctx: AppContext, user: SessionLike, shotId: string): Promise<Shot> {
  const [row] = await ctx.db.select({ shot: shots }).from(shots).innerJoin(projects, eq(projects.id, shots.projectId)).where(and(eq(shots.id, shotId), eq(projects.userId, user.id), isNull(projects.deletedAt)));
  if (!row) throw notFound('Shot');
  return row.shot;
}

export async function updateShot(ctx: AppContext, user: SessionLike, shotId: string, patch: Partial<Pick<Shot, 'description' | 'prompt' | 'durationSec' | 'shotType' | 'camera' | 'characterIds' | 'dialogue' | 'sfx' | 'modelOverride' | 'quality' | 'approved'>>) {
  await ownedShot(ctx, user, shotId);
  if (patch.durationSec !== undefined && (patch.durationSec < 2 || patch.durationSec > 30)) throw badRequest('Shot duration must be 2–30 seconds');
  if (patch.characterIds?.length) {
    const owned = await ctx.db.select({ id: characters.id }).from(characters).where(and(inArray(characters.id, patch.characterIds), eq(characters.userId, user.id)));
    if (owned.length !== patch.characterIds.length) throw notFound('Character');
  }
  const [s] = await ctx.db.update(shots).set({ ...patch, updatedAt: new Date() }).where(eq(shots.id, shotId)).returning();
  return s!;
}

export async function addShot(ctx: AppContext, user: SessionLike, sceneId: string, data: { description: string; prompt: string; durationSec?: number; afterIndex?: number }) {
  const [sc] = await ctx.db.select({ scene: scenes }).from(scenes).innerJoin(projects, eq(projects.id, scenes.projectId)).where(and(eq(scenes.id, sceneId), eq(projects.userId, user.id)));
  if (!sc) throw notFound('Scene');
  const existing = await ctx.db.select().from(shots).where(eq(shots.sceneId, sceneId)).orderBy(asc(shots.index));
  const at = Math.min(existing.length, (data.afterIndex ?? existing.length - 1) + 1);
  return ctx.db.transaction(async (tx) => {
    for (const s of existing.filter((x) => x.index >= at)) await tx.update(shots).set({ index: s.index + 1 }).where(eq(shots.id, s.id));
    const [row] = await tx.insert(shots).values({ projectId: sc.scene.projectId, sceneId, index: at, description: data.description, prompt: data.prompt, durationSec: data.durationSec ?? 5 }).returning();
    return row!;
  });
}

export async function deleteShot(ctx: AppContext, user: SessionLike, shotId: string) {
  const s = await ownedShot(ctx, user, shotId);
  await ctx.db.delete(shots).where(eq(shots.id, shotId));
  const rest = await ctx.db.select().from(shots).where(eq(shots.sceneId, s.sceneId)).orderBy(asc(shots.index));
  for (const [i, r] of rest.entries()) if (r.index !== i) await ctx.db.update(shots).set({ index: i }).where(eq(shots.id, r.id));
}

export async function reorderShots(ctx: AppContext, user: SessionLike, sceneId: string, orderedIds: string[]) {
  const rows = await ctx.db.select({ shot: shots }).from(shots).innerJoin(projects, eq(projects.id, shots.projectId)).where(and(eq(shots.sceneId, sceneId), eq(projects.userId, user.id)));
  if (rows.length !== orderedIds.length || !rows.every((r) => orderedIds.includes(r.shot.id))) throw badRequest('Order must list every shot in the scene exactly once');
  await ctx.db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) await tx.update(shots).set({ index: i, updatedAt: new Date() }).where(eq(shots.id, id));
  });
}

export async function reorderScenes(ctx: AppContext, user: SessionLike, projectId: string, orderedIds: string[]) {
  await getOwnedProject(ctx, user, projectId);
  const rows = await ctx.db.select().from(scenes).where(eq(scenes.projectId, projectId));
  if (rows.length !== orderedIds.length || !rows.every((r) => orderedIds.includes(r.id))) throw badRequest('Order must list every scene exactly once');
  await ctx.db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) await tx.update(scenes).set({ index: i, updatedAt: new Date() }).where(eq(scenes.id, id));
  });
}

// ----------------------------------------------------------------- estimate & generate

/** Reference photos of each scene's location, keyed by scene id. */
async function sceneLocationRefs(db: Db, projectId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ sceneId: scenes.id, assetId: locationReferences.assetId })
    .from(scenes)
    .innerJoin(locationReferences, eq(locationReferences.locationId, scenes.locationId))
    .where(eq(scenes.projectId, projectId));
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.sceneId, [...(m.get(r.sceneId) ?? []), r.assetId]);
  return m;
}

/**
 * `keyframeId`: the shot's keyframe (drawn with the characters' and location's photos). The video
 * then starts from that exact frame (image-to-video), so identity comes from the frame and the
 * cheapest image-to-video models can be used.
 */
function shotSpec(project: typeof projects.$inferSelect, shot: Shot, brief: MovieBrief, locationRefs: string[] = [], keyframeId?: string, speechAssetId?: string): VideoSpecInput {
  // English lines are spoken by the video model; other languages are dubbed (see dub.ts). With a
  // recording (lip-sync) the model moves the mouth to those words; otherwise it only shows who talks.
  const speakers = `${[...new Set(shot.dialogue.map((d) => d.speaker))].join(' and ')} ${shot.dialogue.length > 1 ? 'talk' : 'speaks'} on camera.`;
  const dialogueText = !shot.dialogue.length
    ? ''
    : dubsDialogue(brief)
      ? speechAssetId
        ? `${speakers} ${LIP_SYNC_DIRECTION}`
        : `${speakers} ${NO_SPEECH_DIRECTION}`
      : shot.dialogue.map((d) => `${d.speaker} says: "${d.line}"`).join(' ');
  return {
    prompt: [shot.prompt, dialogueText].filter(Boolean).join(' ').slice(0, 3900),
    aspectRatio: project.aspectRatio as VideoSpecInput['aspectRatio'],
    durationSec: shot.durationSec,
    quality: (shot.quality as VideoSpecInput['quality']) ?? brief.quality,
    style: brief.style,
    camera: shot.camera ?? undefined,
    shotType: shot.shotType ?? undefined,
    // Native audio only where lines are spoken, so voices are not paid for twice.
    nativeAudio: !speechAssetId && brief.withDialogue && shot.dialogue.length > 0,
    speechAudioAssetId: speechAssetId,
    characterIds: shot.characterIds,
    // Objects/products and the location photo; character photos are added from the character library.
    referenceAssetIds: keyframeId ? [] : [...new Set([...shot.referenceAssetIds, ...locationRefs])].slice(0, 7),
    imageAssetId: keyframeId,
    modelKey: shot.modelOverride ?? undefined,
    enhancePrompt: false,
    // Films draw their keyframes in a first phase (startKeyframes); the shot itself only redraws one
    // when that frame is missing and the brief allows keyframes.
    keyframe: brief.keyframes,
  };
}

// ----------------------------------------------------------------- keyframes

/** Lip-sync: non-English dialogue, a live provider with a reference-audio video model, and the brief allows it. */
const lipSyncOn = (ctx: AppContext, brief: MovieBrief) => dubsDialogue(brief) && brief.lipSync && ctx.liveEnabled && VIDEO_MODELS.some((m) => m.capabilities.referenceAudio && m.status === 'active' && ctx.configured.has(m.provider));
const LIP_SYNC_MAX_SEC = 15;

/** Keyframes are drawn first when live image generation is available (and the brief allows it). */
const keyframesOn = (ctx: AppContext, brief: MovieBrief) => brief.keyframes && ctx.liveEnabled && ctx.images.available();
const lipSyncFramesOn = (ctx: AppContext) => ctx.liveEnabled && ctx.images.available();

/** Shots whose storyboard frame is a real AI keyframe (not a labelled placeholder). */
async function usableKeyframes(db: Db, list: Shot[]): Promise<Map<string, string>> {
  const ids = list.map((s) => s.storyboardAssetId).filter(Boolean) as string[];
  const rows = ids.length ? await db.select({ id: assets.id, isFixture: assets.isFixture }).from(assets).where(inArray(assets.id, ids)) : [];
  const ok = new Set(rows.filter((r) => !r.isFixture).map((r) => r.id));
  return new Map(list.filter((s) => s.storyboardAssetId && ok.has(s.storyboardAssetId)).map((s) => [s.id, s.storyboardAssetId!]));
}

/** Character photos (primary first), then the scene's location and the shot's own object photos — at most 10. */
async function keyframeRefs(db: Db, shot: Shot, locationRefs: string[] = []): Promise<string[]> {
  const refs = shot.characterIds.length
    ? await db.select({ characterId: characterReferences.characterId, assetId: characterReferences.assetId, isPrimary: characterReferences.isPrimary }).from(characterReferences).where(inArray(characterReferences.characterId, shot.characterIds))
    : [];
  const byChar = shot.characterIds.flatMap((id) => refs.filter((r) => r.characterId === id).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)).slice(0, 2).map((r) => r.assetId));
  return [...new Set([...byChar, ...locationRefs.slice(0, 2), ...shot.referenceAssetIds])].slice(0, 10);
}

function keyframePrompt(shot: Shot, aspect: string, style?: string) {
  return `${shot.prompt}\n\nOne ${stillLook(style)} still: the first frame of this ${aspect} shot. Keep every person, place and object exactly consistent with the reference images. No text, captions or logos.`.slice(0, 1000);
}

async function startKeyframes(ctx: AppContext, user: SessionLike, project: typeof projects.$inferSelect, list: Shot[], key: string, parentJobId?: string) {
  const locRefs = await sceneLocationRefs(ctx.db, project.id);
  const jobs = [];
  for (const sh of list) {
    const referenceAssetIds = await keyframeRefs(ctx.db, sh, locRefs.get(sh.sceneId));
    jobs.push(await createImageJob(ctx, user, { prompt: keyframePrompt(sh, project.aspectRatio, (project.settings as { brief?: { style?: string } }).brief?.style), aspectRatio: project.aspectRatio as AspectRatio, purpose: 'storyboard', projectId: project.id, shotId: sh.id, referenceAssetIds, idempotencyKey: `${key}:${sh.id}` }, { parentJobId }));
  }
  return jobs;
}

/**
 * Native audio is preferred for dialogue shots, not mandatory: if no model within the plan
 * offers it together with the shot's reference photos, keep the references (consistency) and
 * flag that the line needs a voice-over or subtitles instead.
 */
async function bestShotSpec(ctx: AppContext, user: SessionLike, spec: VideoSpecInput, opts: { assumeFirstFrame?: boolean; assumeSpeech?: boolean; lipSyncFrame?: boolean } = {}): Promise<{ spec: VideoSpecInput; estimate: Awaited<ReturnType<typeof prepareEstimate>>['estimate']; audioDropped: boolean; lipSync?: boolean }> {
  // Lip-sync first; if no model in reach can follow a recording, generate without it (voice-over only).
  // `lipSyncFrame`: a keyframe will be drawn for this shot if (and only if) it is lip-synced.
  if (opts.assumeSpeech || spec.speechAudioAssetId) {
    const ls = await prepareEstimate(ctx, user, { ...spec, nativeAudio: false }, { assumeSpeech: opts.assumeSpeech, assumeFirstFrame: opts.assumeFirstFrame || opts.lipSyncFrame });
    if (ls.estimate.ok) return { spec: { ...spec, nativeAudio: false }, estimate: ls.estimate, audioDropped: false, lipSync: true };
    const { speechAudioAssetId: _s, ...rest } = spec;
    void _s;
    return { ...(await bestShotSpec(ctx, user, rest, { assumeFirstFrame: opts.assumeFirstFrame })), lipSync: false };
  }
  const first = await prepareEstimate(ctx, user, spec, opts);
  if (first.estimate.ok || !spec.nativeAudio) return { spec, estimate: first.estimate, audioDropped: false };
  const alt = { ...spec, nativeAudio: false };
  const second = await prepareEstimate(ctx, user, alt, opts);
  return second.estimate.ok ? { spec: alt, estimate: second.estimate, audioDropped: true } : { spec, estimate: first.estimate, audioDropped: false };
}

export async function estimateMovie(ctx: AppContext, user: SessionLike, projectId: string, opts: { onlyMissing?: boolean } = {}) {
  const movie = await getMovie(ctx, user, projectId);
  const brief = movieBriefSchema.parse((movie.project.settings as { brief: unknown }).brief);
  const locRefs = await sceneLocationRefs(ctx.db, projectId);
  const allShots = movie.scenes.flatMap((sc) => sc.shots);
  const keyframes = await usableKeyframes(ctx.db, allShots);
  const drawFrames = keyframesOn(ctx, brief);
  const speaking = lipSyncOn(ctx, brief) ? new Set((await filmDialogue(ctx.db, projectId)).map((l) => l.shotId)) : new Set<string>();
  const frame = drawFrames || (speaking.size && lipSyncFramesOn(ctx)) ? await estimateImage(ctx, true) : null;
  const items: { shotId: string; sceneTitle: string; description: string; credits: number; providerCostUsd: number; modelName: string | null; ok: boolean; blockers: string[]; status: string; liveAvailable: boolean; audioDropped: boolean; keyframe: 'ready' | 'drawn first' | null; lipSync: boolean }[] = [];
  for (const sc of movie.scenes) {
    for (const sh of sc.shots) {
      // Skip shots that are finished or already being generated (never charge twice).
      if (opts.onlyMissing && ((sh.currentAssetId && sh.status === 'ready') || sh.status === 'queued')) continue;
      if (isLogoShot(sh)) {
        items.push({ shotId: sh.id, sceneTitle: sc.title, description: sh.description, credits: 0, providerCostUsd: 0, modelName: LOGO_CARD_MODEL, ok: true, blockers: [], status: sh.status, liveAvailable: true, audioDropped: false, keyframe: null, lipSync: false });
        continue;
      }
      const kf = keyframes.get(sh.id);
      const canDraw = !kf && Boolean(frame?.available);
      const { estimate, audioDropped, lipSync } = await bestShotSpec(ctx, user, shotSpec(movie.project, sh, brief, locRefs.get(sh.sceneId), kf), { assumeFirstFrame: canDraw && drawFrames, assumeSpeech: speaking.has(sh.id), lipSyncFrame: canDraw });
      // A lip-synced shot always starts from a keyframe (the face the recording animates).
      const needsFrame = canDraw && (drawFrames || Boolean(lipSync));
      items.push({
        shotId: sh.id,
        sceneTitle: sc.title,
        description: sh.description,
        // A keyframe still to draw is part of the shot's cost.
        credits: estimate.credits + (needsFrame ? frame!.credits : 0),
        providerCostUsd: estimate.providerCostUsd + (needsFrame && frame?.available ? frame.usd : 0),
        modelName: estimate.segments[0]?.modelName ?? null,
        ok: estimate.ok,
        blockers: estimate.blockers ?? [],
        status: sh.status,
        liveAvailable: estimate.liveGenerationAvailable,
        audioDropped,
        keyframe: kf ? 'ready' : needsFrame ? 'drawn first' : null,
        lipSync: Boolean(lipSync),
      });
    }
  }
  // Dubbed dialogue (ElevenLabs) runs after the shots; it is part of the approved budget.
  const dialogue = dubsDialogue(brief) && items.length ? await estimateDialogue(ctx, user, projectId, brief.language) : null;
  const dialogueCredits = dialogue?.available ? dialogue.credits : 0;
  // Score and scene ambience (ElevenLabs), generated after the shots.
  const soundtrack = items.length ? await estimateSoundtrack(ctx, user, projectId, brief) : null;
  const soundtrackCredits = soundtrack?.available ? soundtrack.credits : 0;
  const total = items.reduce((s, i) => s + i.credits, 0) + dialogueCredits + soundtrackCredits;
  const modelMix = Object.entries(items.reduce<Record<string, number>>((m, i) => ((m[i.modelName ?? 'n/a'] = (m[i.modelName ?? 'n/a'] ?? 0) + 1), m), {})).map(([model, shots]) => ({ model, shots }));
  return {
    shots: items,
    dialogue: dialogue && dialogue.lines ? { ...dialogue, language: brief.language } : null,
    soundtrack: soundtrack && (soundtrack.music || soundtrack.ambienceScenes) ? soundtrack : null,
    totalCredits: total,
    providerCostUsd: Math.round((items.reduce((s, i) => s + i.providerCostUsd, 0) + (dialogue?.available ? dialogue.providerCostUsd : 0) + (soundtrack?.available ? soundtrack.providerCostUsd : 0)) * 100) / 100,
    durationSec: movie.scenes.reduce((s, sc) => s + sc.shots.reduce((a, x) => a + x.durationSec, 0), 0),
    modelMix,
    ok: items.length > 0 && items.every((i) => i.ok),
    liveAvailable: items.length > 0 && items.every((i) => i.liveAvailable),
  };
}

/**
 * Start (or resume) film generation. Requires the user to approve a credit amount at least
 * equal to the current estimate. Only shots without a finished clip are generated, so a
 * failed or interrupted film resumes without repeating completed paid work.
 */
export async function generateMovie(ctx: AppContext, user: SessionLike, projectId: string, p: { approvedCredits: number; idempotencyKey: string }) {
  const [existing] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.userId, user.id), eq(generationJobs.idempotencyKey, p.idempotencyKey)));
  if (existing) return existing;
  // A second click while the film is generating must not start (and charge) the same shots again.
  const [running] = await ctx.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.projectId, projectId), eq(generationJobs.userId, user.id), eq(generationJobs.kind, 'movie'), inArray(generationJobs.status, ['queued', 'generating', 'rendering'])));
  if (running) return running;
  const est = await estimateMovie(ctx, user, projectId, { onlyMissing: true });
  if (!est.shots.length) throw badRequest('Every shot already has a finished clip — open the editor to assemble or regenerate individual shots.');
  if (!est.ok) throw new AppError('generation_blocked', est.shots.find((s) => !s.ok)?.blockers[0] ?? 'Some shots cannot be generated', 422, { estimate: est });
  if (p.approvedCredits < est.totalCredits) throw new AppError('approval_required', `Generating this film needs ${est.totalCredits} credits. Please approve that amount to start.`, 409, { estimate: est });
  if (est.liveAvailable) {
    // Each shot passes the daily kill-switch on its own; the film as a whole must pass it too.
    const spending = await getConfig(ctx.db, 'spending');
    const cap = Math.min(spending.globalDailyProviderBudgetUsd, ctx.env.GLOBAL_DAILY_PROVIDER_BUDGET_USD);
    if ((await committedProviderSpendToday(ctx.db)) + est.providerCostUsd > cap)
      throw new AppError('capacity_paused', 'This film would exceed the daily generation budget. Please try again tomorrow or ask an administrator to raise the limit.', 503);
  }

  const movie = await getMovie(ctx, user, projectId);
  const brief = movieBriefSchema.parse((movie.project.settings as { brief: unknown }).brief);
  const missing = movie.scenes.flatMap((sc) => sc.shots).filter((s) => est.shots.some((e) => e.shotId === s.id));
  // Logo shots are made right away from the user's own logo file (no AI model, no charge).
  for (const sh of missing.filter(isLogoShot)) await makeLogoCard(ctx, user, movie.project, sh);
  const todo = missing.filter((s) => !isLogoShot(s));

  const movieJobId = crypto.randomUUID();
  const kf = await usableKeyframes(ctx.db, todo);
  // Lip-sync: the speaking shots' lines are recorded first, then each shot is generated from its recording
  // and its keyframe (drawn even when the film's keyframes are off — the provider needs a face to animate).
  const lipShots = est.shots.filter((s) => s.lipSync).map((s) => s.shotId).filter((id) => todo.some((t) => t.id === id));
  const needFrames = todo.filter((s) => !kf.has(s.id) && (keyframesOn(ctx, brief) || (lipShots.includes(s.id) && lipSyncFramesOn(ctx))));
  const request = { approvedCredits: p.approvedCredits, shotIds: todo.map((s) => s.id), keyframeShotIds: needFrames.map((s) => s.id), voiceShotIds: lipShots };
  const insertMovieJob = (t: Db, phase: string) =>
    t
      .insert(generationJobs)
      .values({ id: movieJobId, userId: user.id, projectId, kind: 'movie', status: 'generating', phase, request, estimatedCredits: est.totalCredits, estimatedCostUsd: est.providerCostUsd, idempotencyKey: p.idempotencyKey, startedAt: new Date() })
      .returning();

  if (needFrames.length || lipShots.length) {
    // Phase 1: draw the missing keyframes with the characters' photos and record the lip-synced
    // lines. The shots are committed (within the approved budget) when both are ready — see runMovieCheck.
    const phase = [needFrames.length && `Drawing ${needFrames.length} keyframes with your characters`, lipShots.length && `recording the voices first so the lips match`].filter(Boolean).join(' and ');
    const [mj] = await ctx.db.transaction(async (tx) => {
      const rows = await insertMovieJob(tx as unknown as Db, phase.charAt(0).toUpperCase() + phase.slice(1));
      await (tx as unknown as Db).update(projects).set({ approvedBudgetCredits: p.approvedCredits, updatedAt: new Date() }).where(eq(projects.id, projectId));
      return rows;
    });
    let started = 0;
    if (needFrames.length) {
      try {
        started += (await startKeyframes(ctx, user, movie.project, needFrames, `kf:${movieJobId}`, movieJobId)).length;
      } catch (err) {
        // e.g. not enough credits for the frames: continue without them (references / text-to-video).
        ctx.log.warn('keyframes not started', { error: (err as Error).message });
      }
    }
    if (lipShots.length) {
      try {
        started += await startDubbing(ctx, mj!, brief.language, { shotIds: lipShots });
      } catch (err) {
        ctx.log.warn('lip-sync voices not started', { error: (err as Error).message });
      }
    }
    if (!started) await enqueue(ctx.db, 'movie.check', { movieJobId }, { queue: 'generation', dedupeKey: `movie-check:${movieJobId}:kf-skip` });
    return mj!;
  }
  // Plan every shot first (read-only), then commit the movie job and every shot job with its
  // reservation in one transaction — all or nothing.
  const plans = await planShots(ctx, user, movie.project, brief, todo, kf, movieJobId, p.idempotencyKey);
  return ctx.db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [mj] = await insertMovieJob(t, `Generating ${todo.length} shots`);
    await commitShots(t, plans);
    await t.update(projects).set({ approvedBudgetCredits: p.approvedCredits, updatedAt: new Date() }).where(eq(projects.id, projectId));
    // Nothing for an AI model to render (only logo cards were missing): assemble straight away.
    if (!plans.length) await enqueue(t, 'movie.check', { movieJobId }, { queue: 'generation', dedupeKey: `movie-check:${movieJobId}:start` });
    return mj!;
  });
}

async function planShots(ctx: AppContext, user: SessionLike, project: typeof projects.$inferSelect, brief: MovieBrief, list: Shot[], keyframes: Map<string, string>, movieJobId: string, key: string, speech: Map<string, string> = new Map()) {
  const locRefs = await sceneLocationRefs(ctx.db, project.id);
  const plans: GenerationPlan[] = [];
  for (const sh of list) {
    const { spec } = await bestShotSpec(ctx, user, shotSpec(project, sh, brief, locRefs.get(sh.sceneId), keyframes.get(sh.id), speech.get(sh.id)));
    plans.push(await planGeneration(ctx, user, { spec, projectId: project.id, shotId: sh.id, idempotencyKey: `${key}:${sh.id}`, confirmEstimate: true, parentJobId: movieJobId, skipConcurrency: true }));
  }
  return plans;
}

async function commitShots(t: Db, plans: GenerationPlan[]) {
  for (const plan of plans) {
    await commitGeneration(plan, t);
    await t.update(shots).set({ status: 'queued', updatedAt: new Date() }).where(eq(shots.id, plan.input.shotId!));
  }
}

/**
 * Phase 2 of a keyframed film: once every keyframe job has finished, commit the shot jobs (each
 * starting from its keyframe). Returns false while frames are still being drawn.
 */
async function continueAfterKeyframes(ctx: AppContext, mj: typeof generationJobs.$inferSelect, children: (typeof generationJobs.$inferSelect)[]): Promise<'waiting' | 'started' | 'failed'> {
  const frames = children.filter((c) => c.kind === 'image');
  // Phase-1 voices (lip-sync): every audio child that exists before the shots start.
  const voices = children.filter((c) => c.kind === 'audio');
  const firstPhase = [...frames, ...voices];
  const pending = firstPhase.filter((c) => !['completed', 'failed', 'cancelled'].includes(c.status));
  if (pending.length) {
    const fr = frames.filter((c) => !pending.includes(c)).length;
    const vo = voices.filter((c) => !pending.includes(c)).length;
    const parts = [frames.length && `keyframes ${fr}/${frames.length}`, voices.length && `voices for lip-sync ${vo}/${voices.length}`].filter(Boolean).join(' · ');
    await ctx.db.update(generationJobs).set({ phase: `Preparing — ${parts}`, progress: 0.1 * ((firstPhase.length - pending.length) / Math.max(1, firstPhase.length)), progressSource: 'provider', updatedAt: new Date() }).where(eq(generationJobs.id, mj.id));
    return 'waiting';
  }
  // Only one concurrent check commits the shots.
  const claimed = await ctx.db
    .update(generationJobs)
    .set({ checkpoint: sql`coalesce(${generationJobs.checkpoint}, '{}'::jsonb) || '{"shotsStarted": true}'::jsonb`, updatedAt: new Date() })
    .where(and(eq(generationJobs.id, mj.id), eq(generationJobs.status, 'generating'), sql`coalesce(${generationJobs.checkpoint}->>'shotsStarted', '') = ''`))
    .returning({ id: generationJobs.id });
  if (!claimed.length) return 'waiting';
  const req = mj.request as { approvedCredits: number; shotIds: string[]; voiceShotIds?: string[] };
  const user = { id: mj.userId, role: 'user' as const };
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, mj.projectId!));
  const brief = movieBriefSchema.parse((project!.settings as { brief: unknown }).brief);
  const list = (await ctx.db.select().from(shots).where(inArray(shots.id, req.shotIds))).sort((a, b) => req.shotIds.indexOf(a.id) - req.shotIds.indexOf(b.id));
  try {
    // One recording per lip-synced shot, laid out exactly like the voices on the timeline.
    const speech = new Map<string, string>();
    for (const sh of list.filter((s) => req.voiceShotIds?.includes(s.id))) {
      const id = await shotSpeechTrack(ctx, mj.userId, project!.id, sh, LIP_SYNC_MAX_SEC).catch((err) => {
        ctx.log.warn('lip-sync recording not built', { shotId: sh.id, error: (err as Error).message });
        return null;
      });
      if (id) speech.set(sh.id, id);
    }
    const plans = await planShots(ctx, user, project!, brief, list, await usableKeyframes(ctx.db, list), mj.id, mj.idempotencyKey ?? mj.id, speech);
    // Never exceed what the user approved (keyframes and voices already spent part of it).
    const spent = firstPhase.reduce((s, f) => s + (f.chargedCredits ?? 0), 0);
    const needed = plans.reduce((s, pl) => s + pl.estimate.credits, 0);
    if (spent + needed > req.approvedCredits) throw new AppError('approval_required', `The shots now cost ${needed} credits — more than the approved budget allows. Please approve the new budget.`, 409);
    await ctx.db.transaction(async (tx) => commitShots(tx as unknown as Db, plans));
    await ctx.db.update(generationJobs).set({ phase: `Generating ${plans.length} shots from their keyframes`, updatedAt: new Date() }).where(eq(generationJobs.id, mj.id));
    if (!plans.length) await enqueue(ctx.db, 'movie.check', { movieJobId: mj.id }, { queue: 'generation', dedupeKey: `movie-check:${mj.id}:start` });
    return 'started';
  } catch (err) {
    await ctx.db
      .update(generationJobs)
      .set({ status: 'failed', phase: 'Could not start the shots', error: { code: (err as AppError).code ?? 'start_failed', message: (err as Error).message.slice(0, 300), retryable: true }, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(generationJobs.id, mj.id));
    return 'failed';
  }
}

const LOGO_CARD_MODEL = 'Logo end card — your logo file (free)';

/**
 * A shot that shows the brand logo (and has the logo photo attached) is not sent to a video
 * model: models redraw logos inaccurately and their moderation may reject brand marks. It is
 * built from the exact logo file instead (generateLogoCard).
 */
export function isLogoShot(shot: Pick<Shot, 'description' | 'prompt' | 'referenceAssetIds'>) {
  return shot.referenceAssetIds.length > 0 && /\blogo\b|ლოგო|логотип/i.test(`${shot.description} ${shot.prompt}`);
}

async function makeLogoCard(ctx: AppContext, user: SessionLike, project: typeof projects.$inferSelect, shot: Shot) {
  const logo = await getOwnedAsset(ctx, user.id, shot.referenceAssetIds[0]!);
  const src = await downloadAssetToTemp(ctx, logo);
  const out = tmpFile('.mp4');
  try {
    const dims = ASPECT_DIMENSIONS[project.aspectRatio as AspectRatio]['1080p'];
    await generateLogoCard(src, out, { width: dims.width, height: dims.height, durationSec: Math.max(2, shot.durationSec) });
    const asset = await storeAsset(ctx, { userId: user.id, projectId: project.id, kind: 'generated', mediaType: 'video', filePath: out, mimeType: 'video/mp4', source: { shotId: shot.id, logoCard: true, aiGenerated: false, fromAssetId: logo.id } });
    await ctx.db.update(shots).set({ currentAssetId: asset.id, status: 'ready', updatedAt: new Date() }).where(eq(shots.id, shot.id));
    return asset;
  } finally {
    await Promise.all([fsp.rm(src, { force: true }), fsp.rm(out, { force: true })]);
  }
}

/**
 * Re-voice a finished film: record every line with ElevenLabs voices and re-render, without
 * regenerating any video. Shots whose video spoke the lines are muted under the new voices.
 */
export async function redubMovie(ctx: AppContext, user: SessionLike, projectId: string, p: { approvedCredits: number; idempotencyKey: string; shotIds?: string[] }) {
  const [existing] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.userId, user.id), eq(generationJobs.idempotencyKey, p.idempotencyKey)));
  if (existing) return existing;
  const movie = await getMovie(ctx, user, projectId);
  const [running] = await ctx.db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(and(eq(generationJobs.projectId, projectId), eq(generationJobs.kind, 'movie'), inArray(generationJobs.status, ['queued', 'generating', 'rendering'])));
  if (running) throw new AppError('conflict', 'The film is still being generated — re-voice it when it is finished.', 409);
  const allShots = movie.scenes.flatMap((sc) => sc.shots);
  // Per-shot re-voice (a new take of just those lines) or the whole film.
  const shotIds = p.shotIds?.length ? p.shotIds : undefined;
  if (shotIds?.some((id) => !allShots.some((s) => s.id === id))) throw notFound('Shot not found');
  // A shot's take only needs that shot's clip; the whole film needs every clip.
  const needed = shotIds ? allShots.filter((s) => shotIds.includes(s.id)) : allShots;
  if (!needed.length || needed.some((s) => !s.currentAssetId)) throw badRequest(shotIds ? 'Generate this shot first, then re-voice it.' : 'Generate every shot first, then re-voice the dialogue.');
  const brief = movieBriefSchema.parse((movie.project.settings as { brief: unknown }).brief);
  const est = await estimateDialogue(ctx, user, projectId, brief.language, shotIds);
  if (!est.lines) throw badRequest('This film has no dialogue to voice.');
  if (!est.available) throw new AppError('configuration_required', 'Dialogue voices need ELEVENLABS_API_KEY and LIVE_GENERATION_ENABLED=true.', 503);
  if (p.approvedCredits < est.credits) throw new AppError('approval_required', `Re-voicing needs ${est.credits} credits. Please approve that amount to start.`, 409, { estimate: est });
  // The new take becomes current for these shots (earlier takes stay available to switch back).
  if (shotIds) await clearVoiceSelection(ctx.db, projectId, shotIds);
  return ctx.db.transaction(async (tx) => {
    const [mj] = await tx
      .insert(generationJobs)
      .values({ userId: user.id, projectId, kind: 'movie', status: 'generating', phase: 'Recording the dialogue with native-language voices (ElevenLabs)', request: { redub: true, approvedCredits: p.approvedCredits, dubShotIds: shotIds }, estimatedCredits: est.credits, estimatedCostUsd: est.providerCostUsd, idempotencyKey: p.idempotencyKey, startedAt: new Date() })
      .returning();
    await enqueue(tx as never, 'movie.check', { movieJobId: mj!.id }, { queue: 'generation', dedupeKey: `movie-check:${mj!.id}:redub` });
    return mj!;
  });
}

/**
 * Switch a line to one of its recorded takes (`assetId` null = newest). The editor timeline is
 * rebuilt with it; the rendered film updates on the next export.
 */
export async function chooseVoiceTake(ctx: AppContext, user: SessionLike, projectId: string, p: { shotId: string; index: number; assetId: string | null }) {
  await getOwnedProject(ctx, user, projectId);
  const line = `${p.shotId}:${p.index}`;
  const track = await dubTrack(ctx.db, projectId);
  if (p.assetId && !track.takes.get(line)?.some((t) => t.assetId === p.assetId)) throw notFound('Take not found');
  await selectVoiceTake(ctx.db, projectId, line, p.assetId);
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  const timeline = await keepEditorChanges(ctx, projectId, await buildDefaultTimeline(ctx, projectId, project!.aspectRatio, await dubTrack(ctx.db, projectId), await soundtrackTrack(ctx.db, projectId)));
  await saveTimeline(ctx, user, projectId, timeline as TimelineInput, { label: 'Voice take changed' });
  return { ok: true };
}

export async function regenerateShot(ctx: AppContext, user: SessionLike, shotId: string, idempotencyKey: string) {
  const shot = await ownedShot(ctx, user, shotId);
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, shot.projectId));
  if (isLogoShot(shot)) {
    await makeLogoCard(ctx, user, project!, shot);
    return { job: null, estimate: null };
  }
  const brief = movieBriefSchema.parse((project!.settings as { brief: unknown }).brief);
  const { spec } = await bestShotSpec(ctx, user, shotSpec(project!, shot, brief, (await sceneLocationRefs(ctx.db, project!.id)).get(shot.sceneId)));
  const res = await createGeneration(ctx, user, { spec, projectId: project!.id, shotId, idempotencyKey, confirmEstimate: true });
  await ctx.db.update(shots).set({ status: 'queued', updatedAt: new Date() }).where(eq(shots.id, shotId));
  return res;
}

/** Price of regenerating one shot as it is now (logo cards are free: built from the logo file). */
export async function estimateShotRegeneration(ctx: AppContext, user: SessionLike, shotId: string): Promise<number> {
  const shot = await ownedShot(ctx, user, shotId);
  if (isLogoShot(shot)) return 0;
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, shot.projectId));
  const brief = movieBriefSchema.parse((project!.settings as { brief: unknown }).brief);
  const { estimate } = await bestShotSpec(ctx, user, shotSpec(project!, shot, brief, (await sceneLocationRefs(ctx.db, project!.id)).get(shot.sceneId)));
  return estimate.credits;
}

export async function storyboardMovie(ctx: AppContext, user: SessionLike, projectId: string, idempotencyKey: string) {
  // The same keyframes the film uses: drawn with the characters', location's and objects' photos.
  const movie = await getMovie(ctx, user, projectId);
  const list = movie.scenes.flatMap((sc) => sc.shots).filter((sh) => !sh.storyboardAssetId && !isLogoShot(sh));
  return startKeyframes(ctx, user, movie.project, list, idempotencyKey);
}

/** Storyboard frames for chosen shots only (the AI Director's "draw this shot"). */
export async function storyboardShots(ctx: AppContext, user: SessionLike, projectId: string, shotIds: string[], idempotencyKey: string) {
  const movie = await getMovie(ctx, user, projectId);
  const list = movie.scenes.flatMap((sc) => sc.shots).filter((sh) => shotIds.includes(sh.id) && !isLogoShot(sh));
  return startKeyframes(ctx, user, movie.project, list, idempotencyKey);
}

/** Called when a child job finishes: assemble once every shot is ready, then mark the film done after rendering. */
export async function runMovieCheck(ctx: AppContext, qj: QueueJob) {
  const [mj] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, String(qj.payload.movieJobId)));
  if (!mj || ['completed', 'failed', 'cancelled'].includes(mj.status)) return;
  const children = await ctx.db.select().from(generationJobs).where(eq(generationJobs.parentJobId, mj.id));
  // Keyframed film, phase 1 → 2: draw the frames, then start the shots from them.
  const firstPhase = mj.request as { keyframeShotIds?: string[]; voiceShotIds?: string[] };
  const keyframed = (firstPhase.keyframeShotIds ?? []).length > 0 || (firstPhase.voiceShotIds ?? []).length > 0;
  if (keyframed && !(mj.checkpoint as { shotsStarted?: boolean } | null)?.shotsStarted) {
    if ((await continueAfterKeyframes(ctx, mj, children)) !== 'started') return;
    return; // the shot jobs report back to this check as they finish
  }
  const videos = children.filter((c) => c.kind === 'video');
  const render = children.find((c) => c.kind === 'render');
  const set = (patch: Partial<typeof generationJobs.$inferInsert>) => ctx.db.update(generationJobs).set({ ...patch, updatedAt: new Date() }).where(eq(generationJobs.id, mj.id));
  const charged = children.filter((c) => c.kind !== 'render').reduce((s, v) => s + (v.chargedCredits ?? 0), 0);

  /** Terminal transition that only one concurrent check can win. */
  const finish = async (from: 'generating' | 'rendering', patch: Partial<typeof generationJobs.$inferInsert>) =>
    (
      await ctx.db
        .update(generationJobs)
        .set({ ...patch, updatedAt: new Date(), completedAt: new Date() })
        .where(and(eq(generationJobs.id, mj.id), eq(generationJobs.status, from)))
        .returning({ id: generationJobs.id })
    ).length > 0;

  if (render) {
    if (render.status === 'completed') {
      if (await finish('rendering', { status: 'completed', phase: 'Film ready', outputAssetId: render.outputAssetId, chargedCredits: charged, progress: 1, isFixture: render.isFixture }))
        await notify(ctx.db, { userId: mj.userId, type: 'movie.completed', title: 'Your film is ready', link: `/app/movie/${mj.projectId}` });
    } else if (render.status === 'failed') {
      await finish('rendering', { status: 'failed', phase: 'Final render failed — open the editor to export again', error: render.error, chargedCredits: charged });
    }
    return;
  }
  const done = videos.filter((v) => ['completed', 'failed', 'cancelled'].includes(v.status));
  if (videos.length) await set({ progress: done.length / videos.length, progressSource: 'provider', phase: `Generated ${videos.filter((v) => v.status === 'completed').length} of ${videos.length} shots` });
  if (done.length < videos.length) return;

  const failed = videos.filter((v) => v.status !== 'completed');
  if (failed.length) {
    if (await finish('generating', { status: 'failed', phase: `${failed.length} shot(s) failed — regenerate them to finish the film`, error: { code: 'shots_failed', message: `${failed.length} shot(s) failed. Completed shots are kept and will not be charged again.`, retryable: true }, chargedCredits: charged }))
      await notify(ctx.db, { userId: mj.userId, type: 'movie.partial', title: 'Some shots need attention', link: `/app/movie/${mj.projectId}` });
    return;
  }

  // All shots ready → post-production audio: dubbed dialogue (languages the video model can't
  // speak well), the score and scene ambience. A re-voice only records voices.
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, mj.projectId!));
  const brief = movieBriefSchema.parse((project!.settings as { brief: unknown }).brief);
  const req = mj.request as { redub?: boolean; dubShotIds?: string[] };
  const redub = Boolean(req.redub);
  const audioLive = ctx.liveEnabled && ctx.audio.isConfigured();
  const dubbing = (redub || dubsDialogue(brief)) && audioLive;
  const scoring = !redub && audioLive;
  if (dubbing || scoring) {
    const tracks = children.filter((c) => c.kind === 'audio');
    if (!tracks.length) {
      // Only one concurrent check starts the recording.
      const started = await ctx.db
        .update(generationJobs)
        .set({ checkpoint: sql`coalesce(${generationJobs.checkpoint}, '{}'::jsonb) || '{"dubStarted": true}'::jsonb`, phase: dubbing ? 'Recording voices, music and sound (ElevenLabs)' : 'Composing music and sound (ElevenLabs)', updatedAt: new Date() })
        .where(and(eq(generationJobs.id, mj.id), eq(generationJobs.status, 'generating'), sql`coalesce(${generationJobs.checkpoint}->>'dubStarted', '') = ''`))
        .returning({ id: generationJobs.id });
      if (!started.length) return;
      let queued = dubbing ? await startDubbing(ctx, mj, brief.language, { shotIds: req.dubShotIds, fresh: Boolean(req.dubShotIds) }) : 0;
      if (scoring) queued += await startSoundtrack(ctx, mj, brief);
      if (queued > 0) {
        await enqueue(ctx.db, 'movie.check', { movieJobId: mj.id }, { queue: 'generation', dedupeKey: `movie-check:${mj.id}:dub-start` });
        return;
      }
    } else {
      const pending = tracks.filter((c) => !['completed', 'failed', 'cancelled'].includes(c.status));
      if (pending.length) {
        await set({ phase: `${dubbing ? 'Recording voices, music and sound' : 'Composing music and sound'} — ${tracks.length - pending.length} of ${tracks.length} ready` });
        return;
      }
    }
  }

  // A per-shot take on an unfinished film: update the editor timeline now; the film itself is
  // assembled once every shot has a clip (the newest take is used then).
  if (redub) {
    const missing = await ctx.db.select({ id: shots.id }).from(shots).where(and(eq(shots.projectId, project!.id), isNull(shots.currentAssetId)));
    if (missing.length) {
      const user = { id: mj.userId, role: 'user' as const };
      const timeline = await keepEditorChanges(ctx, project!.id, await buildDefaultTimeline(ctx, project!.id, project!.aspectRatio, await dubTrack(ctx.db, project!.id), await soundtrackTrack(ctx.db, project!.id)));
      await saveTimeline(ctx, user, project!.id, timeline as TimelineInput, { label: 'New dialogue take' });
      await finish('generating', { status: 'completed', phase: 'New take recorded — the film is assembled once every shot is generated', chargedCredits: charged, progress: 1 });
      return;
    }
  }

  // Several checks can arrive at once; only the one that claims the generating → rendering
  // transition assembles the film.
  const claimed = await ctx.db
    .update(generationJobs)
    .set({ status: 'rendering', phase: 'Assembling and rendering the film', updatedAt: new Date() })
    .where(and(eq(generationJobs.id, mj.id), eq(generationJobs.status, 'generating')))
    .returning({ id: generationJobs.id });
  if (!claimed.length) return;
  const user = { id: mj.userId, role: 'user' as const };
  const fresh = await buildDefaultTimeline(ctx, project!.id, project!.aspectRatio, dubbing ? await dubTrack(ctx.db, project!.id) : undefined, await soundtrackTrack(ctx.db, project!.id));
  const timeline = await keepEditorChanges(ctx, project!.id, fresh);
  await saveTimeline(ctx, user, project!.id, timeline as TimelineInput, { label: 'Auto-assembled film' });
  await createRenderJob(ctx, user, project!.id, { timeline, preset: 'master', idempotencyKey: `movie-render:${mj.id}`, parentJobId: mj.id });
}
