import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Schema = typeof schema;
/** Common database type: node-postgres in production, PGlite (embedded Postgres) in dev/tests. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export type DbHandle = {
  db: Db;
  kind: 'postgres' | 'pglite';
  close: () => Promise<void>;
};

const here = path.dirname(fileURLToPath(import.meta.url));

export function migrationsFolder(): string {
  const candidates = [path.resolve(here, '../../drizzle'), path.resolve(here, '../drizzle'), path.resolve(process.cwd(), 'drizzle')];
  const found = candidates.find((p) => fs.existsSync(path.join(p, 'meta', '_journal.json')));
  if (!found) throw new Error(`Migrations folder not found (looked in ${candidates.join(', ')})`);
  return found;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * PGlite is single-process: two processes opening the same directory overwrite each other's WAL and
 * corrupt the database. Hold a pid lock next to the directory; wait briefly for a restarting holder.
 */
async function lockDataDir(dir: string): Promise<() => void> {
  const file = `${dir}.lock`;
  for (let i = 0; ; i++) {
    const holder = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0);
    if (!holder || holder === process.pid || !alive(holder)) break;
    if (i >= 20) throw new Error(`The embedded database ${dir} is already open in process ${holder}. Stop that server first (only one API may run against a PGlite directory).`);
    await new Promise((r) => setTimeout(r, 500));
  }
  fs.writeFileSync(file, String(process.pid));
  const unlock = () => {
    try {
      if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
  process.once('exit', unlock);
  return unlock;
}

export async function createDb(url: string): Promise<DbHandle> {
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const target = url.slice('pglite:'.length);
    let client: InstanceType<typeof PGlite>;
    if (target === 'memory' || target === '') {
      client = new PGlite();
    } else {
      const dir = path.resolve(target);
      fs.mkdirSync(dir, { recursive: true });
      const unlock = await lockDataDir(dir);
      client = new PGlite(dir);
      await client.waitReady;
      const db = drizzle(client, { schema }) as unknown as Db;
      return { db, kind: 'pglite', close: () => client.close().finally(unlock) };
    }
    await client.waitReady;
    const db = drizzle(client, { schema }) as unknown as Db;
    return { db, kind: 'pglite', close: () => client.close() };
  }
  const pg = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pool = new pg.default.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, kind: 'postgres', close: () => pool.end() };
}

export async function runMigrations(handle: DbHandle): Promise<void> {
  const folder = migrationsFolder();
  if (handle.kind === 'pglite') {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(handle.db as never, { migrationsFolder: folder });
  } else {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(handle.db as never, { migrationsFolder: folder });
  }
}

export { schema };
