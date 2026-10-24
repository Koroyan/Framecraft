import { and, eq, gte, sql } from 'drizzle-orm';
import { TERMINAL_JOB_STATUSES, timelineDuration, type JobStatus, type Timeline } from '@framecraft/shared';
import type { Db } from '../db/client';
import { providerJobs } from '../db/schema';
import type { Job } from './service';

/** Typical seconds per clip by provider, used until real history exists for a model. */
const DEFAULT_CLIP_SEC: Record<string, number> = { runway: 150, ltx: 70, fal: 150, google: 120, replicate: 150, fixture: 6 };
const POST_PROCESS_SEC = 15;

let cache: { at: number; byModel: Map<string, number> } | undefined;

/** Median-ish real duration (submit → done) per model over the last 30 days. */
async function modelDurations(db: Db): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.byModel;
  const rows = await db
    .select({
      modelKey: providerJobs.modelKey,
      sec: sql<number>`percentile_cont(0.5) within group (order by extract(epoch from (${providerJobs.completedAt} - ${providerJobs.submittedAt})))::float`,
    })
    .from(providerJobs)
    .where(and(eq(providerJobs.status, 'succeeded'), gte(providerJobs.createdAt, new Date(Date.now() - 30 * 86400_000)), sql`${providerJobs.providerKey} <> 'fixture'`, sql`${providerJobs.submittedAt} is not null`))
    .groupBy(providerJobs.modelKey);
  cache = { at: Date.now(), byModel: new Map(rows.filter((r) => r.sec > 0).map((r) => [r.modelKey, r.sec])) };
  return cache.byModel;
}

const secondsSince = (d: Date | null | undefined) => (d ? Math.max(0, (Date.now() - d.getTime()) / 1000) : 0);

/**
 * Estimate time to completion. Prefers real provider progress (extrapolated from elapsed
 * time); otherwise uses the model's historical duration. Never claims precision it lacks:
 * the UI shows it as "about N min".
 */
export async function estimateEta(db: Db, job: Job, opts: { notStarted?: boolean } = {}): Promise<{ etaSec: number | null; elapsedSec: number | null }> {
  if (TERMINAL_JOB_STATUSES.includes(job.status as JobStatus)) return { etaSec: null, elapsedSec: job.startedAt && job.completedAt ? (job.completedAt.getTime() - job.startedAt.getTime()) / 1000 : null };
  const elapsed = secondsSince(job.startedAt);
  const p = job.progressSource === 'provider' ? (job.progress ?? 0) : 0;
  let expectedTotal: number;

  if (job.kind === 'video') {
    const segments = ((job.checkpoint as { segments?: unknown[] }).segments ?? []).length || 1;
    const perClip = job.isFixture ? DEFAULT_CLIP_SEC.fixture! : ((await modelDurations(db)).get(job.modelKey ?? '') ?? DEFAULT_CLIP_SEC[job.providerKey ?? ''] ?? 150);
    expectedTotal = perClip * segments + POST_PROCESS_SEC;
  } else if (job.kind === 'render') {
    const t = (job.request as { timeline?: Timeline }).timeline;
    expectedTotal = (t ? timelineDuration(t) : 30) * 1.5 + 10; // local FFmpeg, roughly 1.5× real time
  } else if (job.kind === 'plan') {
    expectedTotal = 60;
  } else {
    expectedTotal = 25; // audio / image
  }

  let eta: number;
  if (p >= 0.05 && elapsed > 3) eta = (elapsed * (1 - p)) / p; // extrapolate real progress
  // Still waiting for a free provider slot: the whole render is ahead of it, however long it has waited.
  else eta = opts.notStarted ? expectedTotal : expectedTotal - elapsed;
  // Never show 0 while still working; if we are past the estimate, say "a little longer".
  return { etaSec: Math.round(Math.max(eta, 8)), elapsedSec: Math.round(elapsed) };
}
