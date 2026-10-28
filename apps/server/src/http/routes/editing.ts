import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { parse, requireUser } from '../app';
import { editOperations } from '../../db/schema';
import { getOwnedJob, toPublicJob } from '../../generation/service';
import { activateShotVersion, ensureClipShot, ownedShot, projectShots, renameShotVersion, saveGraphLayout } from '../../editing/versions';
import { acceptAiEdit, aiEditRequestSchema, createAiEdit, estimateAiEdit, rejectAiEdit } from '../../editing/ai-edit';
import { addComment, commentInputSchema, COMMENT_STATUSES, deleteComment, grabFrame, updateComment } from '../../editing/comments';
import { copilotPlan, copilotRequestSchema } from '../../editing/copilot';
import { directorRequestSchema } from '@framecraft/shared';
import { applyDirectorOps, applyRequestSchema, directorPlan, estimateDirectorOps, estimateRequestSchema, runDirectorOp, runRequestSchema } from '../../director/story';
import { assetUrl } from '../../services/assets';
import { notFound } from '../../lib/errors';
import { filmstrip, importLut, rasterLayer, trackInAsset, waveform } from '../../editing/media-tools';
import { shotVersions } from '../../db/schema';

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
    const body = parse(z.object({ positions: z.record(z.string().max(80), z.object({ x: z.number(), y: z.number() })).optional(), collapsed: z.array(z.string().max(80)).max(200).optional(), removed: z.array(z.string().uuid()).max(500).optional() }), req.body);
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

  // ---------------------------------------------------------------- media tools (free, local FFmpeg)

  app.get('/api/assets/:id/waveform', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return waveform(ctx, u, id);
  });

  app.get('/api/assets/:id/filmstrip', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return filmstrip(ctx, u, id);
  });

  app.post('/api/layers/raster', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ layer: z.record(z.string(), z.unknown()), frameHeight: z.number().min(240).max(2160) }), req.body);
    return rasterLayer(ctx, u, body.layer as never, body.frameHeight);
  });

  // Your own footage → a shot (so AI edits, comments and versions work on it).
  app.post('/api/projects/:id/shots/from-clip', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return ensureClipShot(ctx, u, id, parse(z.object({ assetId: z.string().uuid(), label: z.string().max(200).optional() }), req.body));
  });

  const trackBody = z.object({ box: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.005).max(1), h: z.number().min(0.005).max(1) }), atSec: z.number().min(0), startSec: z.number().min(0), endSec: z.number().min(0.05), smoothing: z.number().min(0).max(1).optional(), region: z.array(z.tuple([z.number().min(-0.5).max(1.5), z.number().min(-0.5).max(1.5)])).min(3).max(400).optional() });
  app.post('/api/assets/:id/track', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return { track: await trackInAsset(ctx, u, id, parse(trackBody, req.body)) };
  });
  app.post('/api/shot-versions/:id/track', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [v] = await ctx.db.select().from(shotVersions).where(eq(shotVersions.id, id));
    if (!v) throw notFound('Version');
    await ownedShot(ctx, u, v.shotId);
    return { track: await trackInAsset(ctx, u, v.assetId, parse(trackBody, req.body)) };
  });

  app.post('/api/luts', { bodyLimit: 13 * 1024 * 1024 }, async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ name: z.string().min(1).max(120), cube: z.string().min(20).max(12 * 1024 * 1024) }), req.body);
    return { lut: await importLut(ctx, u, body.name, body.cube) };
  });

  // ---------------------------------------------------------------- assistant

  // AI Director in the story graph / storyboard: plan (proposes only), apply free steps, price and run paid ones.
  app.post('/api/projects/:id/director', aiLimit, async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return directorPlan(ctx, u, id, parse(directorRequestSchema, req.body));
  });

  app.post('/api/projects/:id/director/apply', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return applyDirectorOps(ctx, u, id, parse(applyRequestSchema, req.body));
  });

  app.post('/api/projects/:id/director/estimate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return estimateDirectorOps(ctx, u, id, parse(estimateRequestSchema, req.body).ops);
  });

  app.post('/api/projects/:id/director/run', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const r = await runDirectorOp(ctx, u, id, parse(runRequestSchema, req.body));
    return { jobs: await Promise.all(r.jobs.map((j) => toPublicJob(ctx, j))) };
  });

  app.post('/api/projects/:id/copilot', aiLimit, async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return copilotPlan(ctx, u, id, parse(copilotRequestSchema, req.body));
  });
}
