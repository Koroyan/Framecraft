import { loadEnv } from '../config/env';
import { createDb, runMigrations } from './client';
import { syncCatalog } from '../services/registry';
import { seedReferenceData } from './seed';

const env = loadEnv();
const handle = await createDb(env.DATABASE_URL);
await runMigrations(handle);
await syncCatalog(handle.db);
await seedReferenceData(handle.db);
console.log(`Migrations applied and catalog synced (${handle.kind}).`);
await handle.close();
