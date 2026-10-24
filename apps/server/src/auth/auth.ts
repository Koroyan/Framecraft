import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { consents, sessions, userSettings, users } from '../db/schema';
import { addCredits, ensureWallet } from '../billing/wallet';
import { conflict, unauthorized } from '../lib/errors';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const TERMS_VERSION = '2026-10-21';

/** scrypt$N$r$p$salt$hash — memory-hard, no native dependencies. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(expected, actual);
}

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export type SessionUser = { id: string; email: string; name: string; role: 'user' | 'admin'; status: 'active' | 'suspended'; locale: string };

export async function registerUser(
  db: Db,
  p: { email: string; password: string; name: string; ip?: string; signupBonus: number; role?: 'user' | 'admin' },
): Promise<SessionUser> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, p.email));
  if (existing.length) throw conflict('An account with this email already exists');
  const passwordHash = await hashPassword(p.password);
  const user = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [u] = await t.insert(users).values({ email: p.email, name: p.name, passwordHash, role: p.role ?? 'user' }).returning();
    await t.insert(userSettings).values({ userId: u!.id });
    await t.insert(consents).values([
      { userId: u!.id, kind: 'terms', version: TERMS_VERSION, ip: p.ip },
      { userId: u!.id, kind: 'ai_content', version: TERMS_VERSION, ip: p.ip },
    ]);
    await ensureWallet(t, u!.id);
    return u!;
  });
  if (p.signupBonus > 0) {
    await addCredits(db, { userId: user.id, amount: p.signupBonus, type: 'grant', description: 'Free trial credits', idempotencyKey: `signup:${user.id}` });
  }
  return { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status, locale: user.locale };
}

export async function authenticate(db: Db, email: string, password: string): Promise<SessionUser> {
  const [u] = await db.select().from(users).where(eq(users.email, email));
  // Always run a hash to keep timing similar for unknown emails.
  const ok = u?.passwordHash ? await verifyPassword(password, u.passwordHash) : (await hashPassword(password), false);
  if (!u || !ok) throw unauthorized('Incorrect email or password');
  if (u.status !== 'active') throw unauthorized('This account is suspended');
  return { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, locale: u.locale };
}

export async function createSession(db: Db, userId: string, ttlDays: number, meta: { ip?: string; userAgent?: string } = {}): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlDays * 86400_000);
  await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) });
  await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, userId));
  return { token, expiresAt };
}

export async function resolveSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, status: users.status, locale: users.locale, sessionId: sessions.id, lastActiveAt: users.lastActiveAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  const r = rows[0];
  if (!r || r.status !== 'active') return null;
  if (!r.lastActiveAt || Date.now() - r.lastActiveAt.getTime() > 15 * 60_000) {
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, r.id));
  }
  return { id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, locale: r.locale };
}

export async function destroySession(db: Db, token: string | undefined) {
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function destroyAllSessions(db: Db, userId: string) {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
