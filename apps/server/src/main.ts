import { loadEnv } from './config/env';
import { createContext } from './context';
import { buildApp } from './http/app';
import { reclaimStale, Worker } from './queue/queue';
import { createHandlers, recoverOrphanedJobs, scheduleMaintenance } from './worker/handlers';

/** API server. With the embedded PGlite database the worker runs in-process (single connection). */
async function main() {
  const env = loadEnv();
  const ctx = await createContext(env);
  const app = await buildApp(ctx);
  let worker: Worker | undefined;
  if (env.embeddedWorker) {
    worker = new Worker(ctx.db, createHandlers(ctx), { queues: ['generation', 'media', 'maintenance'], concurrency: env.WORKER_CONCURRENCY, log: ctx.log.warn });
    await scheduleMaintenance(ctx);
    // The embedded worker is the only worker, so anything still marked "running" was interrupted
    // by a restart: resume it now instead of waiting for the 10-minute stale-lock timeout.
    // (Safe: submitted provider tasks are resumed by id, never resubmitted.)
    const resumed = await reclaimStale(ctx.db, 0);
    if (resumed) ctx.log.info(`resumed ${resumed} interrupted job(s)`);
    await recoverOrphanedJobs(ctx);
    worker.start();
    ctx.log.info('embedded worker started');
  }
  await app.listen({ port: env.PORT, host: env.HOST });
  ctx.log.info(
    `Framecraft API on :${env.PORT} — ${env.isProduction ? 'production' : 'development'} mode, live generation ${ctx.liveEnabled ? 'ENABLED' : 'disabled'}, providers: ${[...ctx.configured].join(', ') || 'none configured'}`,
  );
  const shutdown = async () => {
    await app.close();
    await worker?.stop();
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
