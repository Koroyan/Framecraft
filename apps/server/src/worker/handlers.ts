import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { generationJobs, queueJobs } from '../db/schema';
import { enqueue, reclaimStale, type JobHandler } from '../queue/queue';
import { runVideoJob } from '../generation/pipeline';
import { releaseExpiredReservations } from '../billing/wallet';
import { runMovieCheck, runMoviePlan } from '../movie/movie';
import { runRenderJob } from '../editor/editor';
import { runAudioJob } from '../audio/audio';
import { runImageJob } from '../images/images';
import { runChatTurn } from '../chat/chat';
import { runEditJob } from '../editing/ai-edit';
import { runAnalyzeJob, runAssembleJob, runFinishJob, runPlanJob } from '../ads/campaigns';

export function createHandlers(ctx: AppContext): Record<string, JobHandler> {
  return {
    'video.run': (job) => runVideoJob(ctx, job),
    'movie.plan': (job) => runMoviePlan(ctx, job),
    'movie.check': (job) => runMovieCheck(ctx, job),
    'render.timeline': (job) => runRenderJob(ctx, job),
    'audio.run': (job) => runAudioJob(ctx, job),
    'image.run': (job) => runImageJob(ctx, job),
    'chat.turn': (job) => runChatTurn(ctx, job),
    'edit.run': (job) => runEditJob(ctx, job),
    'ad.analyze': (job) => runAnalyzeJob(ctx, job),
    'ad.plan': (job) => runPlanJob(ctx, job),
    'ad.assemble': (job) => runAssembleJob(ctx, job),
    'ad.finish': (job) => runFinishJob(ctx, job),
    'maintenance.sweep': async () => {
      const released = await releaseExpiredReservations(ctx.db);
      const reclaimed = await reclaimStale(ctx.db);
      await recoverOrphanedJobs(ctx);
      if (released || reclaimed) ctx.log.info('maintenance', { released, reclaimed });
      return { rescheduleMs: 2 * 60_000 };
    },
  };
}

const RESUME: Record<string, { name: string; dedupe: (id: string) => string; resetTo?: 'queued' }> = {
  video: { name: 'video.run', dedupe: (id) => `video:${id}` },
  image: { name: 'image.run', dedupe: (id) => `image:${id}` },
  render: { name: 'render.timeline', dedupe: (id) => `render:${id}` },
  // Resumes its saved Runway task — never submitted twice.
  edit: { name: 'edit.run', dedupe: (id) => `edit:${id}` },
  // These handlers only start from "queued"; their provider call is a single short request.
  audio: { name: 'audio.run', dedupe: (id) => `audio:${id}`, resetTo: 'queued' },
  plan: { name: 'movie.plan', dedupe: (id) => `plan:${id}`, resetTo: 'queued' },
};

/**
 * Put back in the queue any active job that has no pending/running queue entry (e.g. its worker
 * was restarted mid-run). Video/image jobs resume their saved provider task — never paid twice.
 */
export async function recoverOrphanedJobs(ctx: AppContext): Promise<number> {
  const active = await ctx.db
    .select({ id: generationJobs.id, kind: generationJobs.kind, status: generationJobs.status, updatedAt: generationJobs.updatedAt })
    .from(generationJobs)
    .where(and(inArray(generationJobs.status, ['queued', 'preparing', 'generating', 'processing', 'rendering']), inArray(generationJobs.kind, Object.keys(RESUME) as never[])));
  if (!active.length) return 0;
  const live = await ctx.db
    .select({ key: queueJobs.dedupeKey })
    .from(queueJobs)
    .where(and(inArray(queueJobs.status, ['pending', 'running']), isNotNull(queueJobs.dedupeKey)));
  const liveKeys = new Set(live.map((l) => l.key));
  let n = 0;
  for (const j of active) {
    const r = RESUME[j.kind]!;
    if (liveKeys.has(r.dedupe(j.id))) continue;
    if (Date.now() - j.updatedAt.getTime() < 60_000) continue; // just created / just updated: give it a moment
    if (r.resetTo && j.status !== 'queued') await ctx.db.update(generationJobs).set({ status: r.resetTo, updatedAt: new Date() }).where(eq(generationJobs.id, j.id));
    if (await enqueue(ctx.db, r.name, { jobId: j.id }, { queue: j.kind === 'render' ? 'media' : 'generation', dedupeKey: r.dedupe(j.id), maxAttempts: 5 })) n++;
  }
  if (n) ctx.log.info(`recovered ${n} orphaned job(s)`);
  return n;
}

/** Ensure the recurring maintenance job exists (idempotent). */
export async function scheduleMaintenance(ctx: AppContext) {
  await enqueue(ctx.db, 'maintenance.sweep', {}, { queue: 'maintenance', dedupeKey: 'maintenance.sweep' });
}
