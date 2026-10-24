import { eq } from 'drizzle-orm';
import { loadEnv } from '../config/env';
import { createDb, runMigrations } from './client';
import { syncCatalog } from '../services/registry';
import { seedReferenceData } from './seed';
import { registerUser } from '../auth/auth';
import { users } from './schema';

/**
 * Development seed: reference data plus a demo admin and a demo creator.
 * Refuses to run in production.
 */
const env = loadEnv();
if (env.isProduction) {
  console.error('db:seed creates demo accounts and is disabled in production. Use `pnpm --filter @framecraft/server admin:create` instead.');
  process.exit(1);
}
const handle = await createDb(env.DATABASE_URL);
await runMigrations(handle);
await syncCatalog(handle.db);
await seedReferenceData(handle.db);
for (const u of [
  { email: 'admin@framecraft.local', name: 'Demo Admin', role: 'admin' as const },
  { email: 'creator@framecraft.local', name: 'Demo Creator', role: 'user' as const },
]) {
  const [existing] = await handle.db.select().from(users).where(eq(users.email, u.email));
  if (existing) continue;
  await registerUser(handle.db, { ...u, password: 'framecraft-demo-1', signupBonus: 2000 });
  console.log(`Created ${u.role} ${u.email} / framecraft-demo-1`);
}
console.log('Seed complete.');
await handle.close();
