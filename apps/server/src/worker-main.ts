import { loadEnv } from './config/env';
import { createContext } from './context';
import { Worker, type QueueName } from './queue/queue';
import { createHandlers, scheduleMaintenance } from './worker/handlers';

/**
 * Dedicated background worker (production). Run several replicas; jobs are claimed with
 * FOR UPDATE SKIP LOCKED so each job runs exactly once at a time.
 * WORKER_QUEUES=generation,media lets you split AI polling from FFmpeg rendering.
 */
async function main() {
  const env = loadEnv();
  if (env.DATABASE_URL.startsWith('pglite:')) throw new Error('A separate worker needs PostgreSQL. With the embedded dev database the API runs the worker in-process.');
  const ctx = await createContext(env);
  const queues = (process.env.WORKER_QUEUES ?? 'generation,media,maintenance').split(',').map((q) => q.trim()) as QueueName[];
  const worker = new Worker(ctx.db, createHandlers(ctx), { queues, concurrency: env.WORKER_CONCURRENCY, log: ctx.log.warn });
  await scheduleMaintenance(ctx);
  worker.start();
  ctx.log.info(`worker ${worker.id} processing ${queues.join(', ')} (concurrency ${env.WORKER_CONCURRENCY})`);
  const shutdown = async () => {
    await worker.stop();
    await ctx.dbHandle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
