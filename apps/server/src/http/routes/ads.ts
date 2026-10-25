import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adBriefSchema, adBriefSchema as briefSchema, adPlanSchema } from '@framecraft/shared';
import type { AppContext } from '../../context';
import { parse, requireUser } from '../app';
import { applyReviewOption, brandKitInputSchema, chooseConcept, setBudget, createCampaign, createVariant, estimateCampaign, getCampaign, listBrandKits, listCampaigns, replan, runEnhancements, saveBrandKit, startAssembly, updatePlan } from '../../ads/campaigns';
import { analyzeWebsite } from '../../brand/website';
import { createAiScenes } from '../../ads/ai-scenes';
import { applySceneRevision, proposeSceneRevision, reviseCampaign, revisionSchema } from '../../ads/revise';
import { approveIdentity, latestQuality } from '../../ads/quality';
import { enqueue } from '../../queue/queue';
import { AD_MODES, type AdModeKey } from '@framecraft/shared';
import { and, desc, eq } from 'drizzle-orm';
import { generationJobs, projects } from '../../db/schema';
import { notFound } from '../../lib/errors';
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
    const body = parse(z.object({ environment: z.string().trim().min(3).max(500), lengthSec: z.number().int().min(15).max(60).optional(), mode: z.enum(AD_MODES.map((m) => m.key) as [AdModeKey, ...AdModeKey[]]).optional() }), req.body);
    return reply.status(201).send(await createAiScenes(ctx, requireUser(req), id, body));
  });
  // Revisions after a preview (footage ads: free plan edits, then re-assemble).
  app.post('/api/ads/campaigns/:id/revise', limit, async (req) => {
    const { id } = parse(idParam, req.params);
    return reviseCampaign(ctx, requireUser(req), id, parse(revisionSchema, req.body));
  });
  // AI-scene ads: propose (price only the affected shots), then apply with approval.
  app.post('/api/projects/:id/ad-revise/propose', limit, async (req) => {
    const { id } = parse(idParam, req.params);
    return proposeSceneRevision(ctx, requireUser(req), id, parse(revisionSchema, req.body));
  });
  app.post('/api/projects/:id/ad-revise/apply', limit, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(revisionSchema.extend({ approvedCredits: z.number().int().min(0) }), req.body);
    return applySceneRevision(ctx, requireUser(req), id, body, body.approvedCredits);
  });

  // Verified quality report of the latest render (measured from the file + product identity).
  const ownedProject = async (userId: string, id: string) => {
    const [p] = await ctx.db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, userId)));
    if (!p) throw notFound('Project');
    return p;
  };
  app.get('/api/projects/:id/quality', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await ownedProject(u.id, id);
    const [running] = await ctx.db.select({ id: generationJobs.id }).from(generationJobs).where(and(eq(generationJobs.projectId, id), eq(generationJobs.kind, 'render'), eq(generationJobs.status, 'rendering'))).limit(1);
    return { report: await latestQuality(ctx, id), rendering: Boolean(running) };
  });
  app.post('/api/projects/:id/quality', limit, async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await ownedProject(u.id, id);
    const [render] = await ctx.db.select().from(generationJobs).where(and(eq(generationJobs.projectId, id), eq(generationJobs.kind, 'render'), eq(generationJobs.status, 'completed'))).orderBy(desc(generationJobs.completedAt)).limit(1);
    if (!render) throw notFound('Finished render');
    await enqueue(ctx.db, 'ad.quality', { projectId: id, renderJobId: render.id }, { queue: 'media', dedupeKey: `ad-quality:${render.id}:${Date.now()}`, maxAttempts: 1 });
    return { queued: true };
  });
  app.post('/api/projects/:id/quality/:reportId/approve', async (req) => {
    const u = requireUser(req);
    const { id, reportId } = parse(z.object({ id: z.string().uuid(), reportId: z.string().uuid() }), req.params);
    await ownedProject(u.id, id);
    const { shot } = parse(z.object({ shot: z.number().int().min(0) }), req.body);
    return { report: await approveIdentity(ctx, id, reportId, shot) };
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
