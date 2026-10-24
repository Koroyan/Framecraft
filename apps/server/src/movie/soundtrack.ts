import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { MovieBrief } from '@framecraft/shared';
import type { AppContext } from '../context';
import type { Db } from '../db/client';
import { assets, generationJobs, locations, projects, scenes, shots } from '../db/schema';
import { createAudioJob, estimateAudio } from '../audio/audio';
import type { SessionLike } from '../generation/service';
import { dubsDialogue } from './dub';

/**
 * Film soundtrack (ElevenLabs): one instrumental score for the whole film, plus an ambient sound
 * bed for each scene whose clips came back silent (shots without native audio). Voices are dubbed
 * separately (dub.ts). Everything is mixed under the picture in the auto-assembled timeline.
 */
const MAX_AMBIENCE_SEC = 30; // sound-generation limit per clip
const MAX_SCORE_SEC = 300;

type ScenePlan = { sceneId: string; prompt: string; durationSec: number };

async function filmShape(db: Db, projectId: string) {
  const rows = await db
    .select({ shot: shots, scene: scenes, location: locations })
    .from(shots)
    .innerJoin(scenes, eq(scenes.id, shots.sceneId))
    .leftJoin(locations, eq(locations.id, scenes.locationId))
    .where(eq(shots.projectId, projectId))
    .orderBy(asc(scenes.index), asc(shots.index));
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  return { rows, project: project! };
}

function scorePrompt(project: typeof projects.$inferSelect, brief: Pick<MovieBrief, 'genre' | 'style'>) {
  const plan = (project.plan ?? {}) as { music?: { mood?: string; prompt?: string }; genre?: string };
  const base = plan.music?.prompt || `${plan.music?.mood ?? 'emotional, cinematic'} score for a ${plan.genre ?? brief.genre ?? 'short'} film`;
  return `${base}. Instrumental film score, no vocals, no lyrics; clear build and a gentle ending, mixed to sit under dialogue.`.slice(0, 1500);
}

/**
 * What the film needs. `silentOnly`: at run time only scenes with a silent clip get ambience; for
 * estimates (no clips yet) scenes where some shot is planned without native audio.
 */
async function plan(ctx: AppContext, projectId: string, brief: Pick<MovieBrief, 'withMusic' | 'withDialogue' | 'genre' | 'style' | 'language'>, mode: 'estimate' | 'run') {
  // Dubbed shots are muted under their voices, so their scene needs an ambience bed too.
  const dubbed = dubsDialogue(brief);
  const { rows, project } = await filmShape(ctx.db, projectId);
  const total = rows.reduce((s, r) => s + r.shot.durationSec, 0);
  const clipIds = rows.map((r) => r.shot.currentAssetId).filter(Boolean) as string[];
  const clips = clipIds.length ? await ctx.db.select({ id: assets.id, hasAudio: assets.hasAudio }).from(assets).where(inArray(assets.id, clipIds)) : [];
  const audible = new Map(clips.map((c) => [c.id, c.hasAudio === true]));
  const byScene = new Map<string, typeof rows>();
  for (const r of rows) byScene.set(r.scene.id, [...(byScene.get(r.scene.id) ?? []), r]);
  const ambience: ScenePlan[] = [];
  for (const [sceneId, list] of byScene) {
    const voiced = (r: (typeof list)[number]) => dubbed && r.shot.dialogue.some((d) => d.line.trim());
    const silent = list.some((r) => voiced(r) || (mode === 'run' ? r.shot.currentAssetId && !audible.get(r.shot.currentAssetId) : !(brief.withDialogue && r.shot.dialogue.length)));
    if (!silent) continue;
    const sc = list[0]!.scene;
    const cues = [...new Set(list.map((r) => r.shot.sfx?.trim()).filter(Boolean))].join(', ');
    const where = [list[0]!.location?.name, list[0]!.location?.description, sc.synopsis].filter(Boolean).join('. ');
    ambience.push({
      sceneId,
      durationSec: Math.min(MAX_AMBIENCE_SEC, Math.max(3, list.reduce((s, r) => s + r.shot.durationSec, 0))),
      prompt: `Realistic ambient room tone and background sound for this film scene: ${where}${cues ? `. Sounds: ${cues}` : ''}. No music, no speech, no voices.`.slice(0, 450),
    });
  }
  return { project, total, score: brief.withMusic && total > 0 ? { prompt: scorePrompt(project, brief), durationSec: Math.min(MAX_SCORE_SEC, Math.max(10, total)) } : null, ambience };
}

export async function estimateSoundtrack(ctx: AppContext, user: SessionLike, projectId: string, brief: MovieBrief) {
  const p = await plan(ctx, projectId, brief, 'estimate');
  let credits = 0;
  let providerCostUsd = 0;
  if (p.score) {
    const e = await estimateAudio(ctx, user, { kind: 'music', prompt: p.score.prompt, durationSec: p.score.durationSec, idempotencyKey: 'estimate' });
    credits += e.credits;
    providerCostUsd += e.providerCostUsd;
  }
  for (const a of p.ambience) {
    const e = await estimateAudio(ctx, user, { kind: 'sfx', prompt: a.prompt, durationSec: a.durationSec, idempotencyKey: 'estimate' });
    credits += e.credits;
    providerCostUsd += e.providerCostUsd;
  }
  return { music: Boolean(p.score), ambienceScenes: p.ambience.length, credits, providerCostUsd: Math.round(providerCostUsd * 1000) / 1000, available: ctx.liveEnabled && ctx.audio.isConfigured() };
}

/** Queue the score and scene ambience for a film job. Returns how many tracks were queued. */
export async function startSoundtrack(ctx: AppContext, movieJob: typeof generationJobs.$inferSelect, brief: MovieBrief): Promise<number> {
  const projectId = movieJob.projectId!;
  const p = await plan(ctx, projectId, brief, 'run');
  const user = { id: movieJob.userId, role: 'user' as const };
  const link = { parentJobId: movieJob.id };
  let n = 0;
  const attempt = async (fn: () => Promise<unknown>, what: string) => {
    try {
      await fn();
      n++;
    } catch (err) {
      // e.g. not enough credits: the film still renders without this track.
      ctx.log.warn(`${what} not generated`, { error: (err as Error).message });
    }
  };
  if (p.score) await attempt(() => createAudioJob(ctx, user, { kind: 'music', prompt: p.score!.prompt, durationSec: p.score!.durationSec, projectId, idempotencyKey: `score:${movieJob.id}` }, link), 'score');
  for (const a of p.ambience)
    await attempt(() => createAudioJob(ctx, user, { kind: 'sfx', prompt: a.prompt, durationSec: a.durationSec, projectId, idempotencyKey: `amb:${movieJob.id}:${a.sceneId}` }, link), 'ambience');
  return n;
}

export type SoundtrackTrack = { music?: { assetId: string; durationSec: number }; ambience: Map<string, { assetId: string; durationSec: number }> };

/** The newest finished score and per-scene ambience of a film. */
export async function soundtrackTrack(db: Db, projectId: string): Promise<SoundtrackTrack> {
  const jobs = await db
    .select({ key: generationJobs.idempotencyKey, assetId: generationJobs.outputAssetId })
    .from(generationJobs)
    .where(and(eq(generationJobs.projectId, projectId), eq(generationJobs.kind, 'audio'), eq(generationJobs.status, 'completed'), sql`(${generationJobs.idempotencyKey} like 'score:%' or ${generationJobs.idempotencyKey} like 'amb:%')`))
    .orderBy(asc(generationJobs.createdAt));
  const ids = jobs.map((j) => j.assetId).filter(Boolean) as string[];
  const rows = ids.length ? await db.select({ id: assets.id, durationMs: assets.durationMs }).from(assets).where(inArray(assets.id, ids)) : [];
  const dur = new Map(rows.map((r) => [r.id, (r.durationMs ?? 0) / 1000]));
  const out: SoundtrackTrack = { ambience: new Map() };
  for (const j of jobs) {
    const d = j.assetId ? dur.get(j.assetId) : 0;
    if (!j.assetId || !d) continue;
    if (j.key!.startsWith('score:')) out.music = { assetId: j.assetId, durationSec: d };
    else out.ambience.set(j.key!.split(':').pop()!, { assetId: j.assetId, durationSec: d });
  }
  return out;
}
