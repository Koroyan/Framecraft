import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { TEMPLATES } from '@framecraft/shared';
import type { AppContext } from '../../context';
import { parse, requireAdmin } from '../app';
import { generationJobs, modelEvaluations, modelRegistry, plans, providerJobs, providers, templates, users } from '../../db/schema';
import { adminAuditLog, adminFailedJobs, adminListUsers, adminModels, adminOverview, planMarginReport } from '../../services/admin';
import { getConfig, setConfig, type ConfigKey } from '../../services/admin-config';
import { invalidateRegistryCache, updateModelPrice } from '../../services/registry';
import { addCredits, debitAdjustment, refundJob } from '../../billing/wallet';
import { audit } from '../../services/common';
import { destroyAllSessions, hashPassword } from '../../auth/auth';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { ProviderHttpError } from '../../providers/video/types';
import { queueHealth } from '../../queue/queue';
import { toPublicJob } from '../../generation/service';

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const log = (actor: string, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>, ip: string) => audit(ctx.db, { actorUserId: actor, action, targetType, targetId, metadata, ip });

  app.get('/api/admin/overview', async (req) => {
    requireAdmin(req);
    return { overview: await adminOverview(ctx), planMargins: await planMarginReport(ctx) };
  });

  app.get('/api/admin/models', async (req) => {
    requireAdmin(req);
    return adminModels(ctx);
  });

  app.patch('/api/admin/models/:key', async (req) => {
    const a = requireAdmin(req);
    const { key } = parse(z.object({ key: z.string().max(80) }), req.params);
    const body = parse(z.object({ enabled: z.boolean().optional(), status: z.enum(['active', 'preview', 'deprecated', 'discontinued', 'unverified']).optional(), qualityTier: z.number().min(1).max(5).optional(), notes: z.string().max(1000).optional() }), req.body);
    const [m] = await ctx.db.update(modelRegistry).set({ ...body, ...(body.qualityTier !== undefined ? { qualitySource: 'admin' } : {}), updatedAt: new Date() }).where(eq(modelRegistry.key, key)).returning();
    if (!m) throw notFound('Model');
    invalidateRegistryCache();
    await log(a.id, 'admin.model.update', 'model', key, body, req.ip);
    return { model: m };
  });

  app.put('/api/admin/models/:key/pricing', async (req) => {
    const a = requireAdmin(req);
    const { key } = parse(z.object({ key: z.string().max(80) }), req.params);
    const body = parse(
      z.object({
        resolution: z.enum(['480p', '720p', '1080p', '1440p', '4k']),
        audio: z.union([z.boolean(), z.literal('any')]),
        usdPerSecond: z.number().min(0).max(10),
        usdPerReference: z.number().min(0).max(10).optional(),
        minimumUsd: z.number().min(0).max(100).optional(),
        confidence: z.enum(['verified', 'partial', 'unverified']),
      }),
      req.body,
    );
    const [m] = await ctx.db.select().from(modelRegistry).where(eq(modelRegistry.key, key));
    if (!m) throw notFound('Model');
    await updateModelPrice(ctx.db, key, body);
    await log(a.id, 'admin.model.pricing', 'model', key, body, req.ip);
    return { ok: true };
  });

  app.patch('/api/admin/providers/:key', async (req) => {
    const a = requireAdmin(req);
    const { key } = parse(z.object({ key: z.string().max(40) }), req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const [p] = await ctx.db.update(providers).set({ enabled, updatedAt: new Date() }).where(eq(providers.key, key)).returning();
    if (!p) throw notFound('Provider');
    invalidateRegistryCache();
    await log(a.id, 'admin.provider.update', 'provider', key, { enabled }, req.ip);
    return { provider: p };
  });

  app.post('/api/admin/providers/:key/check', async (req) => {
    requireAdmin(req);
    const { key } = parse(z.object({ key: z.string().max(40) }), req.params);
    const provider = key === 'elevenlabs' ? ctx.audio : (ctx.video as Record<string, { checkCredentials?: () => Promise<{ ok: boolean; message: string }>; isConfigured(): boolean }>)[key];
    if (!provider) throw notFound('Provider');
    if (!('checkCredentials' in provider) || !provider.checkCredentials) return { ok: provider.isConfigured(), message: provider.isConfigured() ? 'Key present (this provider has no free credential-check endpoint wired up)' : 'Not configured' };
    return provider.checkCredentials();
  });

  app.get('/api/admin/config/:key', async (req) => {
    requireAdmin(req);
    const { key } = parse(z.object({ key: z.enum(['pricing', 'routing', 'spending', 'voices']) }), req.params);
    return { value: await getConfig(ctx.db, key) };
  });

  app.put('/api/admin/config/:key', async (req) => {
    const a = requireAdmin(req);
    const { key } = parse(z.object({ key: z.enum(['pricing', 'routing', 'spending', 'voices']) }), req.params);
    const value = await setConfig(ctx.db, key as ConfigKey, req.body, a.id);
    invalidateRegistryCache();
    await log(a.id, 'admin.config.update', 'config', key, req.body as Record<string, unknown>, req.ip);
    return { value };
  });

  // Dialogue voices: browse the ElevenLabs Voice Library for native speakers and adopt them.
  /** Surface ElevenLabs permission errors (e.g. a key without "Voices: read") instead of a generic 500. */
  const elevenlabs = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        const d = (err.body as { detail?: { message?: string } } | undefined)?.detail;
        throw new AppError('provider_error', `ElevenLabs: ${d?.message ?? err.message}`, err.status === 401 || err.status === 403 ? 403 : 502);
      }
      throw err;
    }
  };
  app.get('/api/admin/voices/library', async (req) => {
    requireAdmin(req);
    const q = parse(z.object({ language: z.string().min(2).max(8), gender: z.enum(['male', 'female']).optional() }), req.query);
    return { voices: await elevenlabs(() => ctx.audio.sharedVoices(q)) };
  });

  app.post('/api/admin/voices/adopt', async (req) => {
    const a = requireAdmin(req);
    const b = parse(z.object({ language: z.string().min(2).max(8), gender: z.enum(['male', 'female']), publicOwnerId: z.string().min(1).max(128), voiceId: z.string().min(1).max(64), name: z.string().min(1).max(100) }), req.body);
    const accountVoiceId = await elevenlabs(() => ctx.audio.addSharedVoice(b.publicOwnerId, b.voiceId, `${b.name} (${b.language})`));
    const cfg = await getConfig(ctx.db, 'voices');
    const pool = cfg[b.language] ?? { male: [], female: [] };
    const next = { ...pool, [b.gender]: [accountVoiceId, ...pool[b.gender].filter((v) => v !== accountVoiceId)].slice(0, 20) };
    // A language list needs both genders; fill the missing one from the default list until adopted.
    for (const g of ['male', 'female'] as const) if (!next[g].length) next[g] = cfg.default![g];
    const value = await setConfig(ctx.db, 'voices', { [b.language]: next }, a.id);
    await log(a.id, 'admin.voice.adopt', 'config', 'voices', { ...b, accountVoiceId }, req.ip);
    return { voiceId: accountVoiceId, value };
  });

  app.get('/api/admin/plans', async (req) => {
    requireAdmin(req);
    return { plans: await ctx.db.select().from(plans).orderBy(plans.sort), margins: await planMarginReport(ctx) };
  });

  app.patch('/api/admin/plans/:key', async (req) => {
    const a = requireAdmin(req);
    const { key } = parse(z.object({ key: z.string().max(40) }), req.params);
    const body = parse(
      z.object({
        name: z.string().max(60).optional(),
        priceCents: z.number().int().min(0).optional(),
        monthlyCredits: z.number().int().min(0).optional(),
        active: z.boolean().optional(),
        limits: z.object({ maxConcurrentJobs: z.number().int().min(1).max(64), maxClipSeconds: z.number().int().min(2).max(600), maxMovieSeconds: z.number().int().min(0).max(3600), maxResolution: z.enum(['480p', '720p', '1080p', '1440p', '4k']), qualityModes: z.array(z.enum(['economy', 'balanced', 'high', 'cinematic'])).min(1), watermark: z.boolean(), commercialUse: z.boolean(), storageGb: z.number().min(0) }).optional(),
        providerPriceIds: z.record(z.string(), z.string()).optional(),
      }),
      req.body,
    );
    const [p] = await ctx.db.update(plans).set({ ...body, updatedAt: new Date() }).where(eq(plans.key, key)).returning();
    if (!p) throw notFound('Plan');
    await log(a.id, 'admin.plan.update', 'plan', key, body, req.ip);
    return { plan: p };
  });

  app.get('/api/admin/templates', async (req) => {
    requireAdmin(req);
    const rows = await ctx.db.select().from(templates).orderBy(templates.sort);
    return { templates: rows.map((r) => ({ ...r, name: TEMPLATES.find((t) => t.key === r.key)?.name ?? r.key })) };
  });

  app.patch('/api/admin/templates/:key', async (req) => {
    const a = requireAdmin(req);
    const { key } = parse(z.object({ key: z.string().max(60) }), req.params);
    const body = parse(z.object({ enabled: z.boolean().optional(), featured: z.boolean().optional(), sort: z.number().int().optional(), overrides: z.object({ name: z.string().max(60).optional(), description: z.string().max(300).optional() }).optional() }), req.body);
    const [t] = await ctx.db.update(templates).set({ ...body, updatedAt: new Date() }).where(eq(templates.key, key)).returning();
    if (!t) throw notFound('Template');
    await log(a.id, 'admin.template.update', 'template', key, body, req.ip);
    return { template: t };
  });

  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const { q } = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    return { users: await adminListUsers(ctx, q) };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ role: z.enum(['user', 'admin']).optional(), status: z.enum(['active', 'suspended']).optional() }), req.body);
    if (id === a.id && (body.role === 'user' || body.status === 'suspended')) throw badRequest('You cannot remove your own admin access');
    const [u] = await ctx.db.update(users).set({ ...body, updatedAt: new Date() }).where(eq(users.id, id)).returning({ id: users.id, role: users.role, status: users.status });
    if (!u) throw notFound('User');
    if (body.status === 'suspended') await destroyAllSessions(ctx.db, id);
    await log(a.id, 'admin.user.update', 'user', id, body, req.ip);
    return { user: u };
  });

  /**
   * Forgotten password (no email reset yet): set a random temporary password, shown once to the
   * admin, and sign the user out everywhere. The user should change it in Settings after signing in.
   */
  app.post('/api/admin/users/:id/reset-password', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const temporaryPassword = crypto.randomBytes(12).toString('base64url');
    const [u] = await ctx.db.update(users).set({ passwordHash: await hashPassword(temporaryPassword), updatedAt: new Date() }).where(eq(users.id, id)).returning({ id: users.id, email: users.email });
    if (!u) throw notFound('User');
    await destroyAllSessions(ctx.db, id);
    await log(a.id, 'admin.user.reset_password', 'user', id, {}, req.ip);
    return { email: u.email, temporaryPassword };
  });

  app.post('/api/admin/users/:id/credits', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ amount: z.number().int().refine((n) => n !== 0), reason: z.string().min(3).max(200), idempotencyKey: z.string().min(8) }), req.body);
    const r =
      body.amount > 0
        ? await addCredits(ctx.db, { userId: id, amount: body.amount, type: 'adjustment', description: `Admin: ${body.reason}`, idempotencyKey: `admin:${body.idempotencyKey}` })
        : await debitAdjustment(ctx.db, { userId: id, amount: -body.amount, description: `Admin: ${body.reason}`, idempotencyKey: `admin:${body.idempotencyKey}` });
    await log(a.id, 'admin.credits.adjust', 'user', id, body, req.ip);
    return r;
  });

  app.get('/api/admin/jobs/failed', async (req) => {
    requireAdmin(req);
    const rows = await adminFailedJobs(ctx);
    return { jobs: await Promise.all(rows.map(async (r) => ({ ...(await toPublicJob(ctx, r.job)), email: r.email, providerKey: r.job.providerKey, actualCostUsd: r.job.actualCostUsd }))) };
  });

  app.post('/api/admin/jobs/:id/refund', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { reason } = parse(z.object({ reason: z.string().min(3).max(200) }), req.body);
    const [job] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, id));
    if (!job) throw notFound('Job');
    if (!job.chargedCredits) throw badRequest('This job has no charged credits to refund');
    const r = await refundJob(ctx.db, { userId: job.userId, jobId: job.id, amount: job.chargedCredits, reason });
    await log(a.id, 'admin.job.refund', 'generation_job', id, { reason, credits: job.chargedCredits, applied: r.applied }, req.ip);
    return r;
  });

  app.post('/api/admin/evaluations', async (req, reply) => {
    const a = requireAdmin(req);
    const body = parse(
      z.object({
        modelKey: z.string().max(80),
        jobId: z.string().uuid().optional(),
        category: z.enum(['general', 'humans', 'motion', 'product', 'text']).default('general'),
        overall: z.number().min(1).max(5),
        motion: z.number().min(1).max(5).optional(),
        consistency: z.number().min(1).max(5).optional(),
        promptAdherence: z.number().min(1).max(5).optional(),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    if (body.jobId) {
      const [j] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.id, body.jobId), eq(generationJobs.isFixture, false)));
      if (!j) throw badRequest('Evaluations must reference a real (non-fixture) generation');
    }
    const [e] = await ctx.db.insert(modelEvaluations).values({ ...body, evaluatorId: a.id }).returning();
    invalidateRegistryCache();
    return reply.status(201).send({ evaluation: e });
  });

  /** Running jobs with their provider task ids and live provider status — for diagnosing slow jobs. */
  app.get('/api/admin/jobs/active', async (req) => {
    requireAdmin(req);
    const rows = await ctx.db
      .select()
      .from(generationJobs)
      .where(inArray(generationJobs.status, ['queued', 'preparing', 'generating', 'processing', 'rendering']))
      .orderBy(generationJobs.createdAt)
      .limit(100);
    return {
      jobs: await Promise.all(
        rows.map(async (j) => {
          const pjs = await ctx.db.select().from(providerJobs).where(eq(providerJobs.generationJobId, j.id));
          return { id: j.id, kind: j.kind, status: j.status, phase: j.phase, model: j.modelKey, progress: j.progress, createdAt: j.createdAt, startedAt: j.startedAt, providerTasks: pjs.map((p) => ({ externalId: p.externalId, status: p.status, attempt: p.attempt, submittedAt: p.submittedAt })) };
        }),
      ),
    };
  });

  /** One job with its provider attempts (redacted payloads and errors) — for diagnosing rejections. */
  app.get('/api/admin/jobs/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [j] = await ctx.db.select().from(generationJobs).where(eq(generationJobs.id, id));
    if (!j) throw notFound('Job not found');
    const attempts = await ctx.db.select().from(providerJobs).where(eq(providerJobs.generationJobId, id));
    return { job: { ...j, checkpoint: undefined }, attempts: attempts.map((p) => ({ attempt: p.attempt, status: p.status, model: p.modelKey, payload: p.requestPayload, error: p.error, response: p.response })) };
  });

  app.get('/api/admin/queue', async (req) => {
    requireAdmin(req);
    return { queue: await queueHealth(ctx.db) };
  });

  app.get('/api/admin/audit', async (req) => {
    requireAdmin(req);
    return { entries: await adminAuditLog(ctx) };
  });
}
