import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { emailSchema } from '@framecraft/shared';
import { loadEnv } from '../config/env';
import { createDb } from '../db/client';

/**
 * Local development helper: copies one account's projects and media into another account, so a
 * second login can open them. The source account is not changed. Every copied row gets a new id
 * and every stored file is linked (or copied) under the new account, so deleting a copy never
 * touches the original. Only finished generation jobs are copied: nothing is queued, nothing runs.
 * The server must be stopped (PGlite). Usage:
 *   npx tsx --env-file-if-exists=../../.env src/cli/copy-account.ts <from-email> <to-email>
 */
const from = emailSchema.parse(process.argv[2]);
const to = emailSchema.parse(process.argv[3]);
const env = loadEnv();
if (env.STORAGE_DRIVER !== 'local') throw new Error('Only local storage is supported');
const handle = await createDb(env.DATABASE_URL);
const db = handle.db;
const rows = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;

const [src] = await rows<{ id: string }>(sql`select id from users where email = ${from}`);
const [dst] = await rows<{ id: string }>(sql`select id from users where email = ${to}`);
if (!src || !dst) throw new Error(`No account with ${!src ? from : to}`);
const U = src.id;

// Table, rows to copy (as JSON text). Order follows the foreign keys.
const P = sql`(select id from projects where user_id = ${U})`;
const plan: [string, ReturnType<typeof sql>][] = [
  ['projects', sql`user_id = ${U}`],
  ['assets', sql`user_id = ${U}`],
  ['project_versions', sql`project_id in ${P}`],
  ['characters', sql`user_id = ${U}`],
  ['character_references', sql`character_id in (select id from characters where user_id = ${U})`],
  ['locations', sql`user_id = ${U}`],
  ['location_references', sql`location_id in (select id from locations where user_id = ${U})`],
  ['scenes', sql`project_id in ${P}`],
  ['shots', sql`project_id in ${P}`],
  ['storyboards', sql`project_id in ${P}`],
  ['generation_jobs', sql`user_id = ${U} and status in ('completed', 'failed', 'cancelled')`],
  ['shot_versions', sql`project_id in ${P}`],
  ['edit_operations', sql`project_id in ${P} and status not in ('queued', 'processing')`],
  ['shot_comments', sql`project_id in ${P}`],
  ['chat_sessions', sql`user_id = ${U}`],
  ['chat_messages', sql`session_id in (select id from chat_sessions where user_id = ${U})`],
  ['brand_kits', sql`user_id = ${U}`],
  ['brand_products', sql`user_id = ${U}`],
  ['ad_campaigns', sql`user_id = ${U}`],
  ['footage_segments', sql`campaign_id in (select id from ad_campaigns where user_id = ${U})`],
  ['quality_reports', sql`project_id in ${P}`],
];

const loaded: [string, { id?: string; json: string }[]][] = [];
const map = new Map<string, string>([[U, dst.id]]);
for (const [table, where] of plan) {
  const list = await rows<{ j: string }>(sql`select row_to_json(_r)::text as j from ${sql.raw(table)} _r where ${where}`);
  const parsed = list.map((r) => ({ id: (JSON.parse(r.j) as { id?: string }).id, json: r.j }));
  for (const r of parsed) if (r.id) map.set(r.id, crypto.randomUUID());
  loaded.push([table, parsed]);
}
const remap = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => map.get(m) ?? m);

const files: [string, string, string][] = [];
await db.transaction(async (tx) => {
  for (const [table, list] of loaded) {
    for (const r of list) {
      const json = remap(r.json);
      if (table === 'assets') files.push([r.id!, (JSON.parse(r.json) as { storage_key: string }).storage_key, (JSON.parse(json) as { storage_key: string }).storage_key]);
      await tx.execute(sql`insert into ${sql.raw(table)} select * from json_populate_record(null::${sql.raw(table)}, ${json}::json)`);
    }
    console.log(`${table}: ${list.length}`);
  }
});
await handle.close();

// Stored media: each asset lives in its own folder (master, proxy, AI inputs), linked under the new key.
const root = path.resolve(env.STORAGE_LOCAL_DIR);
const place = (a: string, b: string) => {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  if (fs.existsSync(b)) return;
  try {
    fs.linkSync(a, b);
  } catch {
    fs.copyFileSync(a, b);
  }
};
let placed = 0;
let missing = 0;
for (const [assetId, oldKey, newKey] of files) {
  const a = path.join(root, oldKey);
  const b = path.join(root, newKey);
  if (!fs.existsSync(a)) {
    missing++;
    continue;
  }
  const dirA = path.dirname(a);
  const dirB = path.dirname(b);
  if (path.basename(dirA) === assetId) {
    for (const f of fs.readdirSync(dirA)) if (fs.statSync(path.join(dirA, f)).isFile()) place(path.join(dirA, f), path.join(dirB, f));
  } else place(a, b);
  placed++;
}
console.log(`files: ${placed} assets placed, ${missing} missing on disk`);
