import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { parse, requireUser } from '../app';
import { editOperations } from '../../db/schema';
import { getOwnedJob, toPublicJob } from '../../generation/service';
import { activateShotVersion, ownedShot, projectShots, renameShotVersion, saveGraphLayout } from '../../editing/versions';
import { acceptAiEdit, aiEditRequestSchema, createAiEdit, estimateAiEdit, rejectAiEdit } from '../../editing/ai-edit';
import { addComment, commentInputSchema, COMMENT_STATUSES, deleteComment, grabFrame, updateComment } from '../../editing/comments';
import { copilotPlan, copilotRequestSchema } from '../../editing/copilot';
import { assetUrl } from '../../services/assets';
import { notFound } from '../../lib/errors';

const idParam = z.object({ id: z.string().uuid() });

/** Editor studio: shot versions, story graph layout, comments, localized AI edits and the assistant. */
export async function editingRoutes(app: FastifyInstance, ctx: AppContext) {
  const aiLimit = { config: { rateLimit: { max: ctx.env.isTest ? 10_000 : 20, timeWindow: '1 minute' } } };

  app.get('/api/projects/:id/shots', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return projectShots(ctx, u, id);
  });

  app.put('/api/projects/:id/graph', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ positions: z.record(z.string().max(80), z.object({ x: z.number(), y: z.number() })).default({}), collapsed: z.array(z.string().max(80)).max(200).default([]) }), req.body);
    await saveGraphLayout(ctx, u, id, body);
    return { ok: true };
  });

  app.post('/api/shot-versions/:id/activate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return activateShotVersion(ctx, u, id);
  });

  app.patch('/api/shot-versions/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ label: z.string().trim().min(1).max(80) }), req.body);
    await renameShotVersion(ctx, u, id, body.label);
    return { ok: true };
  });

  app.post('/api/shot-versions/:id/frame', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ atSec: z.number().min(0) }), req.body);
    const asset = await grabFrame(ctx, u, id, body.atSec);
    return { asset: { id: asset.id, url: await assetUrl(ctx, asset) } };
  });

  // ---------------------------------------------------------------- comments

  app.post('/api/shots/:id/comments', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return reply.status(201).send({ comment: await addComment(ctx, u, id, parse(commentInputSchema, req.body)) });
  });

  app.patch('/api/comments/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await updateComment(ctx, u, id, parse(z.object({ text: z.string().trim().min(1).max(2000).optional(), status: z.enum(COMMENT_STATUSES).optional() }), req.body));
    return { ok: true };
  });

  app.delete('/api/comments/:id', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await deleteComment(ctx, u, id);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- localized AI edits

  app.post('/api/edits/estimate', async (req) => {
    const u = requireUser(req);
    return { estimate: await estimateAiEdit(ctx, u, parse(aiEditRequestSchema.omit({ idempotencyKey: true }), req.body)) };
  });

  app.post('/api/edits', aiLimit, async (req, reply) => {
    const u = requireUser(req);
    const r = await createAiEdit(ctx, u, parse(aiEditRequestSchema, req.body));
    return reply.status(201).send({ operation: r.operation, job: await toPublicJob(ctx, r.job) });
  });

  app.get('/api/edits/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [op] = await ctx.db.select().from(editOperations).where(eq(editOperations.id, id));
    if (!op) throw notFound('Edit');
    await ownedShot(ctx, u, op.shotId);
    const job = op.generationJobId ? await getOwnedJob(ctx, u, op.generationJobId).catch(() => null) : null;
    return { operation: op, job: job ? await toPublicJob(ctx, job) : null };
  });

  app.post('/api/edits/:id/accept', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return acceptAiEdit(ctx, u, id);
  });

  app.post('/api/edits/:id/reject', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await rejectAiEdit(ctx, u, id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- assistant

  app.post('/api/projects/:id/copilot', aiLimit, async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return copilotPlan(ctx, u, id, parse(copilotRequestSchema, req.body));
  });
}
