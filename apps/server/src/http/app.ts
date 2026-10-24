import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError, type z } from 'zod';
import type { AppContext } from '../context';
import { resolveSession, type SessionUser } from '../auth/auth';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import { authRoutes } from './routes/auth';
import { studioRoutes } from './routes/studio';
import { productionRoutes } from './routes/production';
import { chatRoutes } from './routes/chat';
import { editingRoutes } from './routes/editing';
import { billingRoutes } from './routes/billing';
import { adminRoutes } from './routes/admin';
import { mediaRoutes } from './routes/media';
import { webhookRoutes } from './routes/webhooks';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    rawBody?: Buffer;
  }
}

export const SESSION_COOKIE = 'fc_session';

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (u.role !== 'admin') throw forbidden('Administrator access required');
  return u;
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data ?? {});
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.env.isTest ? false : { level: ctx.env.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  // Keep the raw body for signature verification (Stripe, fal).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {});
    } catch {
      done(new AppError('invalid_json', 'Request body is not valid JSON', 400), undefined);
    }
  });

  await app.register(cookie, { secret: ctx.env.sessionSecret });
  await app.register(multipart, { limits: { fileSize: ctx.env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(rateLimit, {
    global: true,
    max: ctx.env.isTest ? 100_000 : 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.user?.id ?? req.ip,
  });

  app.decorateRequest('user', null);

  const appOrigin = new URL(ctx.env.PUBLIC_APP_URL).origin;
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    // CSRF defence in depth: state-changing browser requests must come from our origin.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.url.startsWith('/api/webhooks/')) {
      const origin = req.headers.origin;
      if (origin && origin !== appOrigin && origin !== new URL(ctx.env.PUBLIC_API_URL).origin) throw forbidden('Cross-origin request blocked');
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.user = await resolveSession(ctx.db, token);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply: FastifyReply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) {
      return reply.status(422).send({ error: { code: 'validation_error', message: err.issues[0]?.message ?? 'Invalid input', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    if (err.statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests, please slow down.' } });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: { code: 'file_too_large', message: `Files must be under ${ctx.env.MAX_UPLOAD_MB} MB` } });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } });
  });

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(async (r) => authRoutes(r, ctx));
  await app.register(async (r) => studioRoutes(r, ctx));
  await app.register(async (r) => productionRoutes(r, ctx));
  await app.register(async (r) => chatRoutes(r, ctx));
  await app.register(async (r) => editingRoutes(r, ctx));
  await app.register(async (r) => billingRoutes(r, ctx));
  await app.register(async (r) => adminRoutes(r, ctx));
  await app.register(async (r) => mediaRoutes(r, ctx));
  await app.register(async (r) => webhookRoutes(r, ctx));
  return app;
}
