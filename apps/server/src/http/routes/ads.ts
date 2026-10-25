import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adBriefSchema, adBriefSchema as briefSchema, adPlanSchema } from '@framecraft/shared';
import type { AppContext } from '../../context';
import { parse, requireUser } from '../app';
import { applyReviewOption, brandKitInputSchema, chooseConcept, setBudget, createCampaign, createVariant, estimateCampaign, getCampaign, listBrandKits, listCampaigns, replan, runEnhancements, saveBrandKit, startAssembly, updatePlan } from '../../ads/campaigns';
import { analyzeWebsite } from '../../brand/website';
import { createAiScenes } from '../../ads/ai-scenes';
import { FetchBlocked } from '../../brand/safe-fetch';
import { deleteProduct, importBrandImage, listProducts, productInputSchema, saveProduct } from '../../brand/brand';
import { badRequest } from '../../lib/errors';


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

  // Brand intelligence: read the brand's public website into a draft the user reviews.
  app.post('/api/brand-kits/analyze-website', limit, async (req) => {
    requireUser(req);
    const { url } = parse(z.object({ url: z.string().trim().min(3).max(500) }), req.body);
    try {
      return { draft: await analyzeWebsite(ctx, url) };
    } catch (err) {
      if (err instanceof FetchBlocked) throw badRequest(err.message);
      throw err;
    }
  });
  app.post('/api/brand-kits/import-image', limit, async (req, reply) => {
    const body = parse(z.object({ url: z.string().url().max(1000), rightsConfirmed: z.boolean() }), req.body);
    try {
      return reply.status(201).send(await importBrandImage(ctx, requireUser(req), body.url, { rightsConfirmed: body.rightsConfirmed, ip: req.ip }));
    } catch (err) {
      if (err instanceof FetchBlocked) throw badRequest(err.message);
      throw err;
    }
  });
  const productParams = z.object({ id: z.string().uuid(), productId: z.string().uuid() });
  app.get('/api/brand-kits/:id/products', async (req) => ({ products: await listProducts(ctx, requireUser(req), parse(idParam, req.params).id) }));
  app.post('/api/brand-kits/:id/products', async (req, reply) => reply.status(201).send({ product: await saveProduct(ctx, requireUser(req), parse(idParam, req.params).id, parse(productInputSchema, req.body)) }));
  app.put('/api/brand-kits/:id/products/:productId', async (req) => {
    const { id, productId } = parse(productParams, req.params);
    return { product: await saveProduct(ctx, requireUser(req), id, parse(productInputSchema, req.body), productId) };
  });
  app.delete('/api/brand-kits/:id/products/:productId', async (req) => {
    const { id, productId } = parse(productParams, req.params);
    return deleteProduct(ctx, requireUser(req), id, productId);
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
  app.put('/api/ads/campaigns/:id/budget', async (req) => {
    const { id } = parse(idParam, req.params);
    const { budgetCredits } = parse(z.object({ budgetCredits: z.number().int().min(0).max(10_000_000).nullable() }), req.body);
    return setBudget(ctx, requireUser(req), id, budgetCredits);
  });
  // Only the product, staged in a new AI environment (screenplay + price first, then approval).
  app.post('/api/ads/campaigns/:id/ai-scenes', limit, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ environment: z.string().trim().min(3).max(500), lengthSec: z.number().int().min(15).max(60).optional() }), req.body);
    return reply.status(201).send(await createAiScenes(ctx, requireUser(req), id, body));
  });
  app.post('/api/ads/campaigns/:id/concept', limit, async (req) => {
    const { id } = parse(idParam, req.params);
    const { key } = parse(z.object({ key: z.string().min(1).max(40) }), req.body);
    return chooseConcept(ctx, requireUser(req), id, key);
  });
  app.post('/api/ads/campaigns/:id/review-option', limit, async (req) => {
    const { id } = parse(idParam, req.params);
    const { key } = parse(z.object({ key: z.enum(['shorter', 'crops']) }), req.body);
    return applyReviewOption(ctx, requireUser(req), id, key);
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
    const body = parse(z.object({ approvedCredits: z.number().int().min(0), sceneIds: z.array(z.string().max(40)).max(60).optional() }), req.body);
    return runEnhancements(ctx, requireUser(req), id, body.approvedCredits, body.sceneIds);
  });
}
