import crypto from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { emailTokens, users } from '../db/schema';
import { AppError, badRequest, forbidden } from '../lib/errors';
import { sendEmail } from '../services/email';

/* Account protection: who may sign up, bot checks, and email verification. */

/** Invite / closed modes: only listed emails (or @domains) may create an account. */
export function assertSignupAllowed(ctx: AppContext, email: string) {
  if (ctx.env.SIGNUP_MODE === 'open') return;
  if (ctx.env.SIGNUP_MODE === 'closed') throw forbidden('New accounts are not open at the moment.');
  const e = email.trim().toLowerCase();
  const ok = ctx.env.signupAllowlist.some((entry) => (entry.startsWith('@') ? e.endsWith(entry) : e === entry));
  if (!ok) throw forbidden('Framecraft is in private beta. Ask for an invitation to create an account.');
}

/** Cloudflare Turnstile: required whenever a secret key is configured. */
export async function verifyHuman(ctx: AppContext, token: string | undefined, ip?: string) {
  if (!ctx.env.TURNSTILE_SECRET_KEY) return;
  if (!token) throw badRequest('Please complete the security check.');
  const res = await ctx.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: ctx.env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) }),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean };
  if (!data.success) throw new AppError('bot_check_failed', 'The security check failed. Please try again.', 400);
}

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const TTL_MS = 48 * 3600_000;

export async function sendVerificationEmail(ctx: AppContext, user: { id: string; email: string; name: string }) {
  const token = crypto.randomBytes(32).toString('base64url');
  await ctx.db.insert(emailTokens).values({ userId: user.id, purpose: 'verify_email', tokenHash: hash(token), expiresAt: new Date(Date.now() + TTL_MS) });
  const link = `${ctx.env.PUBLIC_APP_URL.replace(/\/$/, '')}/verify-email?token=${token}`;
  await sendEmail(ctx, {
    to: user.email,
    subject: 'Confirm your Framecraft email',
    text: `Hi ${user.name},\n\nConfirm your email address to start using Framecraft:\n${link}\n\nThe link is valid for 48 hours. If you did not create an account, ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.name)},</p><p>Confirm your email address to start using Framecraft:</p><p><a href="${link}">Confirm my email</a></p><p>The link is valid for 48 hours. If you did not create an account, ignore this email.</p>`,
  });
}

export async function confirmEmail(ctx: AppContext, token: string) {
  const [t] = await ctx.db.select().from(emailTokens).where(and(eq(emailTokens.tokenHash, hash(token)), eq(emailTokens.purpose, 'verify_email'), isNull(emailTokens.usedAt), gt(emailTokens.expiresAt, new Date())));
  if (!t) throw badRequest('This confirmation link is invalid or has expired. Request a new one.');
  await ctx.db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, t.id));
  await ctx.db.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(and(eq(users.id, t.userId), isNull(users.emailVerifiedAt)));
  return { userId: t.userId };
}

export async function isEmailVerified(ctx: AppContext, userId: string) {
  const [u] = await ctx.db.select({ v: users.emailVerifiedAt }).from(users).where(eq(users.id, userId));
  return Boolean(u?.v);
}

/** Paying (and thus generating) needs a confirmed email when verification is on. */
export async function assertVerified(ctx: AppContext, userId: string) {
  if (!ctx.env.REQUIRE_EMAIL_VERIFICATION) return;
  if (!(await isEmailVerified(ctx, userId))) throw new AppError('email_unverified', 'Confirm your email address first — we sent you a link.', 403);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
