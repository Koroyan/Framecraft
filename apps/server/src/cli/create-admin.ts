import { eq } from 'drizzle-orm';
import { emailSchema, passwordSchema } from '@framecraft/shared';
import { loadEnv } from '../config/env';
import { createDb, runMigrations } from '../db/client';
import { registerUser } from '../auth/auth';
import { users } from '../db/schema';

/** Usage: pnpm --filter @framecraft/server admin:create admin@example.com "a-strong-password1" "Name" */
const [emailArg, passwordArg, name = 'Administrator'] = process.argv.slice(2);
const email = emailSchema.parse(emailArg);
const password = passwordSchema.parse(passwordArg);
const env = loadEnv();
const handle = await createDb(env.DATABASE_URL);
await runMigrations(handle);
const [existing] = await handle.db.select().from(users).where(eq(users.email, email));
if (existing) {
  await handle.db.update(users).set({ role: 'admin' }).where(eq(users.id, existing.id));
  console.log(`Promoted existing user ${email} to admin.`);
} else {
  await registerUser(handle.db, { email, password, name, role: 'admin', signupBonus: 0 });
  console.log(`Created admin ${email}.`);
}
await handle.close();
