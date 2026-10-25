import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { parse, requireUser } from '../app';
import { badRequest } from '../../lib/errors';
import { getOwnedAsset } from '../../services/assets';
import { appendChunk, cancelUpload, completeUpload, createUploadSession, getUploadSession, publicAsset, storageUsedBytes } from '../../services/uploads';

const idParam = z.object({ id: z.string().uuid() });

/** Resumable chunked uploads for large media (see services/uploads.ts). */
export async function uploadRoutes(app: FastifyInstance, ctx: AppContext) {
  const chunkLimit = ctx.env.UPLOAD_CHUNK_MB * 1024 * 1024;
  // Chunks are raw bytes; this parser only exists inside this plugin.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: chunkLimit + 1024 }, (_req, body, done) => done(null, body));

  app.get('/api/uploads/config', async (req) => {
    const u = requireUser(req);
    return { chunkSize: chunkLimit, maxBytes: ctx.env.MAX_LARGE_UPLOAD_MB * 1024 * 1024, quotaBytes: ctx.env.STORAGE_QUOTA_MB * 1024 * 1024 || null, usedBytes: await storageUsedBytes(ctx, u.id) };
  });

  app.post('/api/uploads', async (req, reply) => {
    const body = parse(
      z.object({
        filename: z.string().trim().min(1).max(300),
        sizeBytes: z.number().int().positive(),
        fingerprint: z.string().min(1).max(300),
        kind: z.enum(['upload', 'reference']).default('upload'),
        projectId: z.string().uuid().optional(),
        rightsConfirmed: z.boolean(),
        containsPeople: z.boolean().default(false),
      }),
      req.body,
    );
    const r = await createUploadSession(ctx, requireUser(req), body);
    return reply.status(r.resumed ? 200 : 201).send(r);
  });

  app.get('/api/uploads/:id', async (req) => ({ session: await getUploadSession(ctx, requireUser(req), parse(idParam, req.params).id) }));

  app.put('/api/uploads/:id/chunk', { bodyLimit: chunkLimit + 1024 }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { offset } = parse(z.object({ offset: z.coerce.number().int().min(0) }), req.query);
    if (!Buffer.isBuffer(req.body)) throw badRequest('Send the chunk as application/octet-stream');
    return { session: await appendChunk(ctx, requireUser(req), id, offset, req.body) };
  });

  app.post('/api/uploads/:id/complete', async (req, reply) => reply.status(201).send(await completeUpload(ctx, requireUser(req), parse(idParam, req.params).id, req.ip)));

  app.delete('/api/uploads/:id', async (req) => cancelUpload(ctx, requireUser(req), parse(idParam, req.params).id));

  /** Preparation status of a media file (proxy for editing, technical properties). */
  app.get('/api/assets/:id/prep', async (req) => {
    const u = requireUser(req);
    const a = await getOwnedAsset(ctx, u.id, parse(idParam, req.params).id);
    return { asset: await publicAsset(ctx, a) };
  });
}
