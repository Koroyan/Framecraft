import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { providerJobs, webhookEvents } from '../../db/schema';
import { fetchFalJwks, verifyFalWebhookSignature } from '../../providers/video/fal';
import { wakeJob } from '../../queue/queue';
import { jobDedupeKey } from '../../generation/service';
import { AppError } from '../../lib/errors';

/**
 * Provider completion webhooks. They never trust the payload: a verified webhook only
 * wakes the job, which then fetches the authoritative status from the provider API.
 */
export async function webhookRoutes(app: FastifyInstance, ctx: AppContext) {
  const wake = async (provider: string, externalId: string, eventId: string, payload: Record<string, unknown>) => {
    const inserted = await ctx.db.insert(webhookEvents).values({ source: provider, eventId, type: 'completion', payload }).onConflictDoNothing().returning();
    if (!inserted.length) return { duplicate: true };
    const [pj] = await ctx.db.select().from(providerJobs).where(and(eq(providerJobs.providerKey, provider), eq(providerJobs.externalId, externalId)));
    if (pj) await wakeJob(ctx.db, jobDedupeKey(pj.generationJobId));
    return { ok: true };
  };

  app.post('/api/webhooks/providers/fal', async (req) => {
    const keys = await fetchFalJwks(ctx.fetch);
    if (!verifyFalWebhookSignature(req.headers as Record<string, string>, req.rawBody ?? Buffer.alloc(0), keys)) throw new AppError('invalid_signature', 'Invalid webhook signature', 401);
    const body = req.body as { request_id?: string };
    if (!body.request_id) throw new AppError('bad_request', 'Missing request_id', 400);
    return wake('fal', body.request_id, String(req.headers['x-fal-webhook-request-id']), { status: (req.body as { status?: string }).status });
  });

  // Replicate signs webhooks (webhook-id / webhook-timestamp / webhook-signature) with a
  // per-account secret. Until REPLICATE_WEBHOOK_SECRET verification is configured this
  // endpoint is disabled; jobs are polled instead.
  app.post('/api/webhooks/providers/replicate', async (_req, reply) => reply.status(404).send({ error: { code: 'not_enabled', message: 'Replicate webhooks are not enabled; polling is used.' } }));
}
