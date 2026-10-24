import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { loadEnv } from '../../src/config/env';
import { createContext, type AppContext } from '../../src/context';
import { createHandlers } from '../../src/worker/handlers';
import { Worker } from '../../src/queue/queue';
import { queueJobs, users } from '../../src/db/schema';
import { registerUser } from '../../src/auth/auth';
import { clearConfigCache } from '../../src/services/admin-config';
import { invalidateRegistryCache } from '../../src/services/registry';
import type { HttpFetch } from '../../src/providers/video/types';
import type { LlmClient } from '../../src/director/llm';

export async function createTestContext(opts: { env?: Record<string, string>; fetch?: HttpFetch; llm?: LlmClient } = {}) {
  clearConfigCache();
  invalidateRegistryCache();
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-storage-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    STORAGE_LOCAL_DIR: storageDir,
    PROVIDER_POLL_INTERVAL_MS: '1000',
    SIGNUP_BONUS_CREDITS: '300',
    ...opts.env,
  });
  const quiet = { info: () => undefined, warn: () => undefined, error: (m: string, e?: unknown) => console.error(m, e) };
  const ctx = await createContext(env, { fetch: opts.fetch, llm: opts.llm, log: quiet });
  const worker = new Worker(ctx.db, createHandlers(ctx), { queues: ['generation', 'media', 'maintenance'], concurrency: 4 });

  /** Run queued work to completion, fast-forwarding provider poll delays. */
  async function drain(maxRounds = 60) {
    for (let i = 0; i < maxRounds; i++) {
      await ctx.db.update(queueJobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(queueJobs.status, 'pending'));
      const n = await worker.drain(5);
      const pending = await ctx.db.select({ id: queueJobs.id }).from(queueJobs).where(inArray(queueJobs.status, ['pending', 'running']));
      const onlyMaintenance = (await ctx.db.select({ name: queueJobs.name }).from(queueJobs).where(inArray(queueJobs.status, ['pending', 'running']))).every((j) => j.name === 'maintenance.sweep');
      if (!n && (!pending.length || onlyMaintenance)) return;
    }
  }

  async function makeUser(email = `u${Math.random().toString(36).slice(2, 8)}@test.dev`, role: 'user' | 'admin' = 'user', bonus = 300) {
    const u = await registerUser(ctx.db, { email, password: 'password123', name: 'Test User', signupBonus: bonus, role });
    return { ...u, role } as { id: string; role: 'user' | 'admin'; email: string; name: string };
  }

  async function setRole(userId: string, role: 'user' | 'admin') {
    await ctx.db.update(users).set({ role }).where(eq(users.id, userId));
  }

  return { ctx, worker, drain, makeUser, setRole, close: () => ctx.dbHandle.close() };
}

export type TestHarness = Awaited<ReturnType<typeof createTestContext>>;
export type { AppContext };
