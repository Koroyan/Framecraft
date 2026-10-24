import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { loginSchema, passwordSchema, registerSchema } from '@framecraft/shared';
import type { AppContext } from '../../context';
import { authenticate, createSession, destroyAllSessions, destroySession, hashPassword, registerUser, verifyPassword } from '../../auth/auth';
import { parse, requireUser, SESSION_COOKIE } from '../app';
import { users } from '../../db/schema';
import { getWallet } from '../../billing/wallet';
import { audit, getUserPlan } from '../../services/common';
import { unauthorized } from '../../lib/errors';
import { deleteAccount } from '../../services/account';

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const setCookie = (reply: FastifyReply, token: string, expiresAt: Date) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: ctx.env.cookieSecure, path: '/', expires: expiresAt });

  // Strict brute-force protection in production; relaxed locally so E2E suites can create accounts.
  const authLimit = { config: { rateLimit: { max: ctx.env.isProduction ? 10 : 200, timeWindow: '1 minute' } } };

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const user = await registerUser(ctx.db, { ...body, ip: req.ip, signupBonus: ctx.env.SIGNUP_BONUS_CREDITS });
    const s = await createSession(ctx.db, user.id, ctx.env.SESSION_TTL_DAYS, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(reply, s.token, s.expiresAt);
    await audit(ctx.db, { actorUserId: user.id, action: 'user.registered', ip: req.ip });
    return reply.status(201).send({ user });
  });

  app.post('/api/auth/login', authLimit, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const user = await authenticate(ctx.db, body.email, body.password);
    const s = await createSession(ctx.db, user.id, ctx.env.SESSION_TTL_DAYS, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(reply, s.token, s.expiresAt);
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(ctx.db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.user) return { user: null };
    const [wallet, plan] = await Promise.all([getWallet(ctx.db, req.user.id), getUserPlan(ctx.db, req.user.id)]);
    return { user: req.user, wallet, plan: { key: plan.key, name: plan.name, limits: plan.limits } };
  });

  app.post('/api/auth/password', authLimit, async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ currentPassword: z.string(), newPassword: passwordSchema }), req.body);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, u.id));
    if (!row?.passwordHash || !(await verifyPassword(body.currentPassword, row.passwordHash))) throw unauthorized('Current password is incorrect');
    await ctx.db.update(users).set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() }).where(eq(users.id, u.id));
    await destroyAllSessions(ctx.db, u.id);
    await audit(ctx.db, { actorUserId: u.id, action: 'user.password_changed', ip: req.ip });
    return { ok: true, signedOut: true };
  });

  app.post('/api/account/delete', authLimit, async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({ password: z.string(), confirm: z.literal('DELETE') }), req.body);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, u.id));
    if (!row?.passwordHash || !(await verifyPassword(body.password, row.passwordHash))) throw unauthorized('Password is incorrect');
    await deleteAccount(ctx, u.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
