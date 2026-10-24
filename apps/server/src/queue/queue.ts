import os from 'node:os';
import crypto from 'node:crypto';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { queueJobs } from '../db/schema';

export type QueueName = 'generation' | 'media' | 'maintenance';

export type EnqueueOptions = {
  queue?: QueueName;
  runAt?: Date;
  delayMs?: number;
  maxAttempts?: number;
  /** At most one pending/running job with this key exists at a time. */
  dedupeKey?: string;
};

export type QueueJob = typeof queueJobs.$inferSelect;
/** Return `{ rescheduleMs }` to run the same job again later (polling) without consuming an attempt. */
export type JobResult = void | { rescheduleMs: number };
export type JobHandler = (job: QueueJob, helpers: { heartbeat: () => Promise<void> }) => Promise<JobResult>;

export async function rescheduleJob(db: Db, id: string, delayMs: number) {
  await db
    .update(queueJobs)
    .set({ status: 'pending', runAt: new Date(Date.now() + delayMs), lockedAt: null, lockedBy: null, attempts: sql`GREATEST(0, ${queueJobs.attempts} - 1)` })
    .where(eq(queueJobs.id, id));
}

/** Run a pending job (by dedupe key) immediately, e.g. when a provider webhook arrives. */
export async function wakeJob(db: Db, dedupeKey: string) {
  await db.update(queueJobs).set({ runAt: new Date() }).where(and(eq(queueJobs.dedupeKey, dedupeKey), eq(queueJobs.status, 'pending')));
}

/**
 * Durable work queue on PostgreSQL (`FOR UPDATE SKIP LOCKED`).
 *
 * Jobs are inserted in the same transaction as the domain records they act on,
 * so a generation is never "created but not queued" (transactional outbox).
 */
export async function enqueue(db: Db, name: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<string | null> {
  const runAt = opts.runAt ?? new Date(Date.now() + (opts.delayMs ?? 0));
  const rows = await db
    .insert(queueJobs)
    .values({ queue: opts.queue ?? 'generation', name, payload, runAt, maxAttempts: opts.maxAttempts ?? 5, dedupeKey: opts.dedupeKey })
    .onConflictDoNothing()
    .returning({ id: queueJobs.id });
  return rows[0]?.id ?? null;
}

/** Atomically claim up to `limit` due jobs. */
export async function claimJobs(db: Db, queue: QueueName, workerId: string, limit: number): Promise<QueueJob[]> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const due = await t
      .select({ id: queueJobs.id })
      .from(queueJobs)
      .where(and(eq(queueJobs.queue, queue), eq(queueJobs.status, 'pending'), lte(queueJobs.runAt, new Date())))
      .orderBy(asc(queueJobs.runAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (!due.length) return [];
    return t
      .update(queueJobs)
      .set({ status: 'running', lockedAt: new Date(), lockedBy: workerId, attempts: sql`${queueJobs.attempts} + 1` })
      .where(inArray(queueJobs.id, due.map((d) => d.id)))
      .returning();
  });
}

export async function completeJob(db: Db, id: string) {
  // Free the dedupe key so follow-up jobs (e.g. the next poll) can be enqueued.
  await db.update(queueJobs).set({ status: 'completed', completedAt: new Date(), lockedAt: null, dedupeKey: null }).where(eq(queueJobs.id, id));
}

export async function failJob(db: Db, job: QueueJob, error: string, opts: { retryable: boolean }) {
  const dead = !opts.retryable || job.attempts >= job.maxAttempts;
  const backoffMs = Math.min(10 * 60_000, 2 ** job.attempts * 5_000) + Math.floor(Math.random() * 2000);
  await db
    .update(queueJobs)
    .set({
      status: dead ? 'dead' : 'pending',
      lastError: error.slice(0, 4000),
      runAt: dead ? job.runAt : new Date(Date.now() + backoffMs),
      lockedAt: null,
      lockedBy: null,
      dedupeKey: dead ? null : job.dedupeKey,
      completedAt: dead ? new Date() : null,
    })
    .where(eq(queueJobs.id, job.id));
  return { dead };
}

/** Return jobs locked by crashed workers to the queue. */
export async function reclaimStale(db: Db, staleMs = 10 * 60_000): Promise<number> {
  const rows = await db
    .update(queueJobs)
    .set({ status: 'pending', lockedAt: null, lockedBy: null })
    .where(and(eq(queueJobs.status, 'running'), lte(queueJobs.lockedAt, new Date(Date.now() - staleMs))))
    .returning({ id: queueJobs.id });
  return rows.length;
}

export async function queueHealth(db: Db) {
  const rows = await db
    .select({ queue: queueJobs.queue, status: queueJobs.status, count: sql<number>`count(*)::int` })
    .from(queueJobs)
    .groupBy(queueJobs.queue, queueJobs.status);
  return rows;
}

export class Worker {
  private running = false;
  private active = 0;
  private timer?: NodeJS.Timeout;
  readonly id = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

  constructor(
    private readonly db: Db,
    private readonly handlers: Record<string, JobHandler>,
    private readonly opts: { queues: QueueName[]; concurrency: number; pollMs?: number; log?: (msg: string, extra?: unknown) => void } = { queues: ['generation', 'media', 'maintenance'], concurrency: 4 },
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    void reclaimStale(this.db).catch(() => undefined);
    this.loop();
  }

  async stop(timeoutMs = 30_000) {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    const until = Date.now() + timeoutMs;
    while (this.active > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }

  /** Process everything currently due (used by tests and CLI tools). */
  async drain(maxRounds = 100): Promise<number> {
    let processed = 0;
    for (let i = 0; i < maxRounds; i++) {
      let got = 0;
      for (const q of this.opts.queues) {
        const jobs = await claimJobs(this.db, q, this.id, this.opts.concurrency);
        got += jobs.length;
        await Promise.all(jobs.map((j) => this.execute(j)));
      }
      processed += got;
      if (!got) break;
    }
    return processed;
  }

  private loop() {
    if (!this.running) return;
    const tick = async () => {
      try {
        const free = this.opts.concurrency - this.active;
        if (free > 0) {
          for (const q of this.opts.queues) {
            const jobs = await claimJobs(this.db, q, this.id, free);
            for (const j of jobs) void this.execute(j);
          }
        }
      } catch (err) {
        this.opts.log?.('queue poll failed', err);
      } finally {
        if (this.running) this.timer = setTimeout(tick, this.opts.pollMs ?? 1000);
      }
    };
    void tick();
  }

  private async execute(job: QueueJob) {
    this.active++;
    const handler = this.handlers[job.name];
    try {
      if (!handler) throw new NonRetryableError(`No handler for ${job.name}`);
      const result = await handler(job, {
        heartbeat: async () => {
          await this.db.update(queueJobs).set({ lockedAt: new Date() }).where(eq(queueJobs.id, job.id));
        },
      });
      if (result && 'rescheduleMs' in result) await rescheduleJob(this.db, job.id, result.rescheduleMs);
      else await completeJob(this.db, job.id);
    } catch (err) {
      const retryable = !(err instanceof NonRetryableError);
      this.opts.log?.(`job ${job.name} failed`, { id: job.id, error: (err as Error).message });
      await failJob(this.db, job, (err as Error).stack ?? String(err), { retryable }).catch(() => undefined);
    } finally {
      this.active--;
    }
  }
}

export class NonRetryableError extends Error {}
