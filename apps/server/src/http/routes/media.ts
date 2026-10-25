import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { verifyLocalSignature } from '../../storage/storage';
import { assets } from '../../db/schema';
import { forbidden, notFound } from '../../lib/errors';

/**
 * Serves locally stored media through short-lived HMAC-signed URLs (with S3/R2 the
 * browser uses presigned bucket URLs instead). Supports HTTP Range for video seeking.
 */
export async function mediaRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/media/*', async (req, reply) => {
    if (ctx.storage.kind !== 'local') throw notFound();
    const key = (req.params as { '*': string })['*'].split('/').map(decodeURIComponent).join('/');
    const q = req.query as { exp?: string; sig?: string; dl?: string };
    if (!q.sig || !verifyLocalSignature(ctx.env.storageSigningSecret, key, Number(q.exp), q.sig, q.dl)) throw forbidden('Link expired or invalid');
    const [a] = await ctx.db.select({ mimeType: assets.mimeType }).from(assets).where(eq(assets.storageKey, key));
    const stat = await ctx.storage.stat(key);
    // Prepared representations of a master (editing proxy, AI inputs) are stored next to it, without a row.
    const mimeType = a?.mimeType ?? (/\/(proxy|ai-[\w-]+)\.mp4$/.test(key) ? 'video/mp4' : undefined);
    if (!mimeType || !stat) throw notFound('File');

    reply.header('Content-Type', mimeType);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, max-age=3600');
    if (q.dl) reply.header('Content-Disposition', `attachment; filename="${q.dl.replace(/[^\w.-]/g, '_')}"`);

    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || start > end) return reply.status(416).header('Content-Range', `bytes */${stat.size}`).send();
      const { stream } = await ctx.storage.createReadStream(key, { start, end });
      reply.status(206).header('Content-Range', `bytes ${start}-${end}/${stat.size}`).header('Content-Length', String(end - start + 1));
      return reply.send(stream);
    }
    const { stream } = await ctx.storage.createReadStream(key);
    reply.header('Content-Length', String(stat.size));
    return reply.send(stream);
  });
}
