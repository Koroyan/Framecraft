import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { emailSchema } from '@framecraft/shared';
import { loadEnv } from '../config/env';
import { createDb } from '../db/client';
import { destroyAllSessions, hashPassword } from '../auth/auth';
import { users } from '../db/schema';

/**
 * Local recovery for a forgotten password (development; the server must be stopped for PGlite).
 * Sets a new random password and writes it to a file that is never committed (.data/), so it is
 * not printed in the terminal. Usage: pnpm --filter @framecraft/server password:reset you@example.com
 */
const email = emailSchema.parse(process.argv[2]);
const env = loadEnv();
const handle = await createDb(env.DATABASE_URL);
const [u] = await handle.db.select({ id: users.id }).from(users).where(eq(users.email, email));
if (!u) {
  console.error(`No account with ${email}.`);
  await handle.close();
  process.exit(1);
}
const password = crypto.randomBytes(12).toString('base64url');
await handle.db.update(users).set({ passwordHash: await hashPassword(password), updatedAt: new Date() }).where(eq(users.id, u.id));
await destroyAllSessions(handle.db, u.id);
await handle.close();
const file = path.resolve('.data', 'login-reset.txt');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `Framecraft local login (change it in Settings after signing in)\nEmail: ${email}\nPassword: ${password}\n`);
console.log(`New password written to ${file}`);
