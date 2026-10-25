import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adBriefSchema, adBriefSchema as briefSchema, adPlanSchema } from '@framecraft/shared';
import type { AppContext } from '../../context';
import { parse, requireUser } from '../app';
import { brandKitInputSchema, createCampaign, createVariant, estimateCampaign, getCampaign, listBrandKits, listCampaigns, replan, runEnhancements, saveBrandKit, startAssembly, updatePlan } from '../../ads/campaigns';


const idParam = z.object({ id: z.string().uuid() });

/** Product ads from the client's own footage, and brand kits. */
export async function adsRoutes(app: FastifyInstance, ctx: AppContext) {
  const limit = { config: { rateLimit: { max: ctx.env.isTest ? 10_000 : 20, timeWindow: '1 minute' } } };

  app.get('/api/brand-kits', async (req) => ({ brandKits: await listBrandKits(ctx, requireUser(req)) }));
  app.post('/api/brand-kits', async (req, reply) => reply.status(201).send({ brandKit: await saveBrandKit(ctx, requireUser(req), parse(brandKitInputSchema, req.body)) }));
  app.put('/api/brand-kits/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return { brandKit: await saveBrandKit(ctx, requireUser(req), parse(brandKitInputSchema, req.body), id) };
  });

  app.get('/api/ads/campaigns', async (req) => ({ campaigns: await listCampaigns(ctx, requireUser(req)) }));
  app.post('/api/ads/campaigns', limit, async (req, reply) => {
    const body = parse(adBriefSchema.extend({ title: z.string().max(80).optional() }), req.body);
    return reply.status(201).send({ campaign: await createCampaign(ctx, requireUser(req), body) });
  });
  app.get('/api/ads/campaigns/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return getCampaign(ctx, requireUser(req), id);
  });
  app.put('/api/ads/campaigns/:id/plan', async (req) => {
    const { id } = parse(idParam, req.params);
    return updatePlan(ctx, requireUser(req), id, (req.body as { plan?: unknown })?.plan);
  });
  app.post('/api/ads/campaigns/:id/replan', limit, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.union([z.object({ scope: z.literal('all') }), z.object({ scope: z.literal('scene'), sceneIndex: z.number().int().min(0) })]), req.body);
    return replan(ctx, requireUser(req), id, body);
  });
  app.post('/api/ads/campaigns/:id/estimate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { campaign } = await getCampaign(ctx, u, id);
    if (!campaign.plan) return { estimate: null };
    return { estimate: await estimateCampaign(ctx, u, briefSchema.parse(campaign.brief), adPlanSchema.parse(campaign.plan)) };
  });
  app.post('/api/ads/campaigns/:id/assemble', limit, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ approvedCredits: z.number().int().min(0) }), req.body);
    return startAssembly(ctx, requireUser(req), id, body.approvedCredits);
  });
  app.post('/api/ads/campaigns/:id/variants', limit, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ aspectRatio: z.enum(['9:16', '16:9', '1:1', '4:5']).optional(), lengthSec: z.number().min(6).max(90).optional(), language: z.enum(['ka', 'en', 'ru']).optional() }), req.body);
    return createVariant(ctx, requireUser(req), id, body);
  });
  app.post('/api/ads/campaigns/:id/enhance', limit, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ approvedCredits: z.number().int().min(0) }), req.body);
    return runEnhancements(ctx, requireUser(req), id, body.approvedCredits);
  });
}
