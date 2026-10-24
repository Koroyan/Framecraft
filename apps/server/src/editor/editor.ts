import fsp from 'node:fs/promises';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { timelineSchema, timelineDuration, type Timeline, type TimelineInput } from '@framecraft/shared';
import type { AppContext } from '../context';
import { assets, generationJobs, projects, projectVersions, scenes, shots } from '../db/schema';
import { renderTimeline } from '../media/render';
import { wordsToCues } from '../media/subtitles';
import { downloadAssetToTemp, storeAsset, tmpFile, type Asset } from '../services/assets';
import { enqueue, type QueueJob } from '../queue/queue';
import { badRequest, notFound } from '../lib/errors';
import { notify } from '../services/common';
import type { SessionLike } from '../generation/service';

export const EXPORT_PRESETS = {
  master: {},
  tiktok: { aspectRatio: '9:16', resolution: '1080p' },
  reels: { aspectRatio: '9:16', resolution: '1080p' },
  shorts: { aspectRatio: '9:16', resolution: '1080p' },
  youtube: { aspectRatio: '16:9', resolution: '1080p' },
  feed: { aspectRatio: '4:5', resolution: '1080p' },
} as const;

export async function getOwnedProject(ctx: AppContext, user: SessionLike, projectId: string) {
  const [p] = await ctx.db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, user.id), isNull(projects.deletedAt)));
  if (!p) throw notFound('Project');
  return p;
}

/** Every asset referenced by the timeline must belong to the user. */
async function assertTimelineAssets(ctx: AppContext, userId: string, t: Timeline) {
  const ids = [...new Set([...t.clips.map((c) => c.assetId), ...t.audio.map((a) => a.assetId), ...(t.logo ? [t.logo.assetId, ...(t.logo.originalAssetId ? [t.logo.originalAssetId] : [])] : [])])];
  if (!ids.length) return;
  const rows = await ctx.db.select({ id: assets.id, mediaType: assets.mediaType }).from(assets).where(and(inArray(assets.id, ids), eq(assets.userId, userId), isNull(assets.deletedAt)));
  if (rows.length !== ids.length) throw notFound('Timeline asset');
  const types = new Map(rows.map((r) => [r.id, r.mediaType]));
  if (t.clips.some((c) => types.get(c.assetId) !== 'video')) throw badRequest('Timeline clips must be videos');
  if (t.audio.some((a) => !['audio', 'video'].includes(types.get(a.assetId)!))) throw badRequest('Audio tracks must be audio files');
  if (t.logo && (types.get(t.logo.assetId) !== 'image' || (t.logo.originalAssetId && types.get(t.logo.originalAssetId) !== 'image'))) throw badRequest('Logo must be an image');
  for (const c of t.clips) if (c.outSec <= c.inSec) throw badRequest('Clip out point must be after its in point');
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Default timeline: the project's shots in order (movies) or its generated clips (social/quick).
 * `dub`: recorded dialogue per shot. A shot's lines play in order from just after it starts and
 * the subtitles follow the voices; the clip's own audio is ducked to ambience, or muted when the
 * video model spoke the lines itself.
 */
export async function buildDefaultTimeline(
  ctx: AppContext,
  projectId: string,
  aspectRatio: string,
  dub?: { voices: Map<string, { assetId: string; durationSec: number; text: string; words: { text: string; start: number; end: number }[] }[]>; spokenInVideo: Set<string> },
  soundtrack?: { music?: { assetId: string; durationSec: number }; ambience: Map<string, { assetId: string; durationSec: number }> },
): Promise<Timeline> {
  const sceneStart = new Map<string, number>();
  const shotRows = await ctx.db
    .select({ shot: shots, sceneIndex: scenes.index })
    .from(shots)
    .innerJoin(scenes, eq(scenes.id, shots.sceneId))
    .where(eq(shots.projectId, projectId))
    .orderBy(asc(scenes.index), asc(shots.index));
  const clips: TimelineInput['clips'] = [];
  const subtitles: TimelineInput['subtitles'] = [];
  const audio: TimelineInput['audio'] = [];
  let t = 0;
  if (shotRows.length) {
    const assetIds = shotRows.map((r) => r.shot.currentAssetId).filter(Boolean) as string[];
    const rows = assetIds.length ? await ctx.db.select().from(assets).where(inArray(assets.id, assetIds)) : [];
    const byId = new Map(rows.map((a) => [a.id, a]));
    shotRows.forEach((r, i) => {
      const a = r.shot.currentAssetId ? byId.get(r.shot.currentAssetId) : undefined;
      if (!a) return;
      const dur = Math.min(r.shot.durationSec, (a.durationMs ?? r.shot.durationSec * 1000) / 1000);
      const next = shotRows[i + 1];
      const sceneChange = next && next.sceneIndex !== r.sceneIndex;
      if (!sceneStart.has(r.shot.sceneId)) sceneStart.set(r.shot.sceneId, t);
      const voices = dub?.voices.get(r.shot.id) ?? [];
      // A dubbed shot plays only its current take: the clip's own audio is muted (video models
      // sometimes speak despite being told not to); the scene's ambience bed replaces its room tone.
      const volume = voices.length ? 0 : 1;
      clips.push({ id: `clip-${r.shot.id.slice(0, 8)}`, assetId: a.id, inSec: 0, outSec: dur, volume, shotId: r.shot.id, label: r.shot.description.slice(0, 60), transition: sceneChange ? { type: 'fade', durationSec: 0.5 } : undefined });
      if (voices.length) {
        let at = t + 0.3;
        for (const v of voices) {
          audio.push({ id: `voice-${audio.length}`, assetId: v.assetId, kind: 'voice', startSec: at, inSec: 0, outSec: v.durationSec, volume: 1 });
          // Word timings → short cues that appear exactly when they are spoken; otherwise the whole line.
          const cues = v.words.length ? wordsToCues(v.words, { maxChars: 38, maxDuration: 3.5 }) : [{ startSec: 0, endSec: v.durationSec, text: v.text }];
          for (const c of cues) subtitles.push({ id: `sub-${subtitles.length}`, startSec: round2(at + c.startSec), endSec: round2(at + Math.max(c.endSec, c.startSec + 0.6)), text: c.text });
          at += v.durationSec + 0.25;
        }
      } else {
        for (const d of r.shot.dialogue) {
          const len = Math.min(dur, Math.max(1.2, d.line.split(/\s+/).length / 2.5));
          subtitles.push({ id: `sub-${subtitles.length}`, startSec: t + 0.2, endSec: t + 0.2 + len, text: d.line });
        }
      }
      t += dur - (sceneChange ? 0.5 : 0);
    });
  } else {
    const vids = await ctx.db
      .select()
      .from(assets)
      .where(and(eq(assets.projectId, projectId), eq(assets.kind, 'generated'), eq(assets.mediaType, 'video'), isNull(assets.deletedAt)))
      .orderBy(asc(assets.createdAt));
    // Only final outputs (segment parts carry a `segment` marker in their source).
    for (const a of vids.filter((v) => (v.source as { segment?: number }).segment === undefined)) {
      clips.push({ id: `clip-${a.id.slice(0, 8)}`, assetId: a.id, inSec: 0, outSec: (a.durationMs ?? 5000) / 1000 });
    }
  }
  // Soundtrack: scene ambience under silent clips, and the score across the film — quieter when
  // there is dialogue so the voices stay clear.
  for (const [sceneId, amb] of soundtrack?.ambience ?? []) {
    const at = sceneStart.get(sceneId);
    if (at === undefined || at >= t) continue;
    const len = Math.min(amb.durationSec, t - at);
    audio.push({ id: `auto-amb-${sceneId.slice(0, 8)}`, assetId: amb.assetId, kind: 'sfx', startSec: round2(at), inSec: 0, outSec: round2(len), volume: 0.45, fadeInSec: 0.5, fadeOutSec: Math.min(1, len / 4) });
  }
  if (soundtrack?.music && t > 0) {
    const len = Math.min(soundtrack.music.durationSec, t);
    const hasVoices = audio.some((a) => a.kind === 'voice');
    audio.push({ id: 'auto-music', assetId: soundtrack.music.assetId, kind: 'music', startSec: 0, inSec: 0, outSec: round2(len), volume: hasVoices ? 0.18 : 0.42, fadeInSec: 1.5, fadeOutSec: Math.min(3, len / 4) });
  }

  // Ads: the brand logo in the corner throughout and the call to action over the last seconds.
  const texts: TimelineInput['texts'] = [];
  let logo: TimelineInput['logo'];
  const [project] = await ctx.db.select({ kind: projects.kind, settings: projects.settings }).from(projects).where(eq(projects.id, projectId));
  const ad = project?.kind === 'ad' ? (project.settings as { ad?: { cta?: string; logoAssetId?: string | null } }).ad : undefined;
  if (ad && t > 0) {
    if (ad.logoAssetId) logo = { assetId: ad.logoAssetId, position: 'top-right', scale: 0.14, opacity: 0.95 };
    if (ad.cta?.trim()) texts.push({ id: 'auto-cta', text: ad.cta.trim().slice(0, 120), startSec: round2(Math.max(0, t - 3)), endSec: round2(t), position: 'center', fontSize: 64, color: '#FFFFFF', background: true });
  }

  // Never show two cues at once: each ends just before the next begins.
  subtitles.sort((a, b) => a.startSec - b.startSec);
  for (let i = 0; i < subtitles.length - 1; i++) subtitles[i]!.endSec = Math.max(subtitles[i]!.startSec + 0.3, Math.min(subtitles[i]!.endSec, round2(subtitles[i + 1]!.startSec - 0.02)));
  return timelineSchema.parse({ aspectRatio, clips, subtitles, texts, logo, audio: audio.slice(0, 50) });
}

/**
 * Re-assembling a film rebuilds its shots, voices and subtitles; what the user added in the
 * editor (logo, text, music and sound effects, output settings) carries over.
 */
export async function keepEditorChanges(ctx: AppContext, projectId: string, next: Timeline): Promise<Timeline> {
  const [latest] = await ctx.db.select().from(projectVersions).where(eq(projectVersions.projectId, projectId)).orderBy(desc(projectVersions.version)).limit(1);
  const prev = latest ? timelineSchema.safeParse(latest.timeline) : undefined;
  if (!prev?.success) return next;
  const p = prev.data;
  // Auto-generated tracks (voices, score, ambience) come from `next`; the user's own tracks are kept.
  const own = p.audio.filter((a) => a.kind !== 'voice' && !a.id.startsWith('auto-'));
  return timelineSchema.parse({ ...next, resolution: p.resolution, fps: p.fps, burnSubtitles: p.burnSubtitles, logo: p.logo ?? next.logo, texts: p.texts.length ? p.texts : next.texts, audio: [...next.audio, ...own].slice(0, 50) });
}

export async function getTimeline(ctx: AppContext, user: SessionLike, projectId: string) {
  const project = await getOwnedProject(ctx, user, projectId);
  const [latest] = await ctx.db.select().from(projectVersions).where(eq(projectVersions.projectId, projectId)).orderBy(desc(projectVersions.version)).limit(1);
  const timeline = latest ? timelineSchema.parse(latest.timeline) : await buildDefaultTimeline(ctx, projectId, project.aspectRatio);
  return { project, timeline, version: latest?.version ?? 0, label: latest?.label ?? null, durationSec: timelineDuration(timeline) };
}

/** Save a timeline version. Autosaves replace the previous autosave instead of piling up. */
export async function saveTimeline(ctx: AppContext, user: SessionLike, projectId: string, input: TimelineInput, opts: { label?: string; autosave?: boolean } = {}) {
  await getOwnedProject(ctx, user, projectId);
  const timeline = timelineSchema.parse(input);
  await assertTimelineAssets(ctx, user.id, timeline);
  return ctx.db.transaction(async (tx) => {
    const [latest] = await tx.select().from(projectVersions).where(eq(projectVersions.projectId, projectId)).orderBy(desc(projectVersions.version)).limit(1).for('update');
    if (opts.autosave && latest?.label === 'autosave') {
      await tx.update(projectVersions).set({ timeline, createdAt: new Date() }).where(eq(projectVersions.id, latest.id));
      return { version: latest.version };
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(projectVersions).values({ projectId, version, timeline, label: opts.autosave ? 'autosave' : (opts.label ?? null), createdBy: user.id });
    await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
    return { version };
  });
}

export async function listVersions(ctx: AppContext, user: SessionLike, projectId: string) {
  await getOwnedProject(ctx, user, projectId);
  return ctx.db
    .select({ version: projectVersions.version, label: projectVersions.label, createdAt: projectVersions.createdAt })
    .from(projectVersions)
    .where(eq(projectVersions.projectId, projectId))
    .orderBy(desc(projectVersions.version))
    .limit(50);
}

export async function restoreVersion(ctx: AppContext, user: SessionLike, projectId: string, version: number) {
  await getOwnedProject(ctx, user, projectId);
  const [v] = await ctx.db.select().from(projectVersions).where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.version, version)));
  if (!v) throw notFound('Version');
  return saveTimeline(ctx, user, projectId, v.timeline as TimelineInput, { label: `Restored v${version}` });
}

/** Queue an FFmpeg export. Rendering uses local compute only, so it costs no credits. */
export async function createRenderJob(ctx: AppContext, user: SessionLike, projectId: string, p: { timeline: TimelineInput; preset: keyof typeof EXPORT_PRESETS; idempotencyKey: string; parentJobId?: string }) {
  await getOwnedProject(ctx, user, projectId);
  const timeline = timelineSchema.parse({ ...p.timeline, ...EXPORT_PRESETS[p.preset] });
  await assertTimelineAssets(ctx, user.id, timeline);
  if (!timeline.clips.length) throw badRequest('Add at least one clip before exporting');
  const [existing] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.userId, user.id), eq(generationJobs.idempotencyKey, p.idempotencyKey)));
  if (existing) return existing;
  return ctx.db.transaction(async (tx) => {
    const [job] = await tx
      .insert(generationJobs)
      .values({
        userId: user.id,
        projectId,
        parentJobId: p.parentJobId,
        kind: 'render',
        status: 'queued',
        phase: 'Waiting to render',
        request: { timeline, preset: p.preset },
        idempotencyKey: p.idempotencyKey,
        isFixture: false,
      })
      .returning();
    await enqueue(tx as never, 'render.timeline', { jobId: job!.id }, { queue: 'media', dedupeKey: `render:${job!.id}`, maxAttempts: 2 });
    return job!;
  });
}

export async function runRenderJob(ctx: AppContext, qj: QueueJob) {
  const jobId = String(qj.payload.jobId);
  const [job] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return;
  const set = (patch: Partial<typeof generationJobs.$inferInsert>) => ctx.db.update(generationJobs).set({ ...patch, updatedAt: new Date() }).where(eq(generationJobs.id, jobId));
  const timeline = timelineSchema.parse((job.request as { timeline: unknown }).timeline);
  const temps: string[] = [];
  const cache = new Map<string, string>();
  let anyFixture = false;
  try {
    await set({ status: 'rendering', phase: 'Preparing clips', startedAt: new Date() });
    const out = tmpFile('.mp4');
    temps.push(out);
    await renderTimeline({
      timeline,
      output: out,
      resolve: async (assetId) => {
        if (cache.has(assetId)) return cache.get(assetId)!;
        const [a] = await ctx.db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.userId, job.userId)));
        if (!a) throw new Error('Asset missing');
        anyFixture ||= a.isFixture;
        const f = await downloadAssetToTemp(ctx, a as Asset);
        temps.push(f);
        cache.set(assetId, f);
        return f;
      },
      onProgress: async (phase, fraction) => {
        await set({ phase, progress: fraction, progressSource: 'provider' });
      },
    });
    const asset = await storeAsset(ctx, { userId: job.userId, projectId: job.projectId, kind: 'render', mediaType: 'video', filePath: out, mimeType: 'video/mp4', isFixture: anyFixture, source: { jobId, preset: (job.request as { preset: string }).preset, containsFixtures: anyFixture } });
    await set({ status: 'completed', phase: 'Export ready', progress: 1, outputAssetId: asset.id, completedAt: new Date(), chargedCredits: 0, isFixture: anyFixture });
    if (job.projectId) await ctx.db.update(projects).set({ thumbnailAssetId: asset.thumbnailAssetId, updatedAt: new Date() }).where(eq(projects.id, job.projectId));
    if (!job.parentJobId) await notify(ctx.db, { userId: job.userId, type: 'render.completed', title: 'Your export is ready', link: `/app/editor/${job.projectId}` });
    else await enqueue(ctx.db, 'movie.check', { movieJobId: job.parentJobId }, { queue: 'generation', dedupeKey: `movie-check:${job.parentJobId}:${job.id}` });
  } catch (err) {
    await set({ status: 'failed', phase: 'Render failed', error: { code: 'render_failed', message: (err as Error).message.split('\n')[0]!.slice(0, 300), retryable: true }, completedAt: new Date() });
    if (job.parentJobId) await enqueue(ctx.db, 'movie.check', { movieJobId: job.parentJobId }, { queue: 'generation', dedupeKey: `movie-check:${job.parentJobId}:${job.id}` });
  } finally {
    await Promise.all(temps.map((f) => fsp.rm(f, { force: true })));
  }
}
