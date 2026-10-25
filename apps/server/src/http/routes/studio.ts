import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  TEMPLATES,
  characterSchema,
  conceptsRequestSchema,
  createGenerationSchema,
  createProjectSchema,
  estimateSchema,
  locationSchema,
  socialCopyRequestSchema,
  updateProjectSchema,
  videoSpecSchema,
} from '@framecraft/shared';
import type { AppContext } from '../../context';
import { liveProviders } from '../../context';
import { parse, requireUser } from '../app';
import { assets, characterReferences, characters, consents, generationJobs, locationReferences, locations, notifications, projects, savedPrompts, templates, userSettings } from '../../db/schema';
import { cancelGeneration, createGeneration, estimateGeneration, getOwnedJob, listJobs, providerJobsFor, retryGeneration, toPublicJob } from '../../generation/service';
import { loadRoutableModels, toPublicModel } from '../../services/registry';
import { ALLOWED_UPLOADS, assetUrl, downloadAssetToTemp, getOwnedAsset, prepOf, sniffMime, storeAsset, tmpFile } from '../../services/assets';
import { publicAsset } from '../../services/uploads';
import { removeSolidBackground } from '../../media/remove-bg';
import { detectBeats, type BeatAnalysis } from '../../media/beats';
import { deleteAsset } from '../../services/account';
import { badRequest, notFound } from '../../lib/errors';
import { audit } from '../../services/common';
import { TERMS_VERSION } from '../../auth/auth';
import { enqueue } from '../../queue/queue';
import { createImageJob } from '../../images/images';

const uuid = z.object({ id: z.string().uuid() });

export async function studioRoutes(app: FastifyInstance, ctx: AppContext) {
  // ------------------------------------------------------------ system & catalog
  app.get('/api/system/status', async () => ({
    signupMode: ctx.env.SIGNUP_MODE,
    turnstileSiteKey: ctx.env.TURNSTILE_SECRET_KEY ? (ctx.env.TURNSTILE_SITE_KEY ?? null) : null,
    signupBonusCredits: ctx.env.SIGNUP_BONUS_CREDITS,
    mode: ctx.env.isProduction ? 'production' : 'development',
    liveGenerationEnabled: ctx.liveEnabled,
    configuredProviders: [...ctx.configured],
    aiDirector: ctx.llm.available ? 'llm' : 'offline',
    devFixtures: ctx.env.devFixturesEnabled,
    audio: ctx.audio.isConfigured(),
    images: ctx.images.available(),
    payments: ctx.env.PAYMENT_PROVIDER,
  }));

  app.get('/api/models', async () => {
    const models = await loadRoutableModels(ctx.db, liveProviders(ctx));
    return { models: models.map((m) => toPublicModel(m, ctx.liveEnabled)) };
  });

  app.get('/api/templates', async () => {
    const rows = await ctx.db.select().from(templates).where(eq(templates.enabled, true)).orderBy(templates.sort);
    return {
      templates: rows
        .map((r) => {
          const t = TEMPLATES.find((x) => x.key === r.key);
          return t ? { ...t, ...(r.overrides as object), featured: r.featured } : null;
        })
        .filter(Boolean),
    };
  });

  // ------------------------------------------------------------ generations
  const genLimit = { config: { rateLimit: { max: ctx.env.isTest ? 10_000 : 30, timeWindow: '1 minute' } } };

  app.post('/api/generations/estimate', async (req) => {
    const u = requireUser(req);
    const { spec } = parse(estimateSchema, req.body);
    return { estimate: await estimateGeneration(ctx, u, spec) };
  });

  app.post('/api/generations', genLimit, async (req, reply) => {
    const u = requireUser(req);
    const body = parse(createGenerationSchema, req.body);
    const { job, estimate, created } = await createGeneration(ctx, u, body);
    return reply.status(created ? 201 : 200).send({ job: await toPublicJob(ctx, job), estimate });
  });

  app.get('/api/generations', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ projectId: z.string().uuid().optional(), before: z.string().datetime().optional(), status: z.string().optional(), limit: z.coerce.number().int().max(100).optional() }), req.query);
    const rows = await listJobs(ctx, u.id, { ...q, before: q.before ? new Date(q.before) : undefined });
    return { jobs: await Promise.all(rows.map((j) => toPublicJob(ctx, j))) };
  });

  app.get('/api/generations/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const job = await getOwnedJob(ctx, u, id);
    const detail = await toPublicJob(ctx, job);
    const routing = job.routing as { estimate?: unknown } | null;
    const attempts = (await providerJobsFor(ctx, id)).map((p) => ({ segment: p.segmentIndex, attempt: p.attempt, status: p.status, model: p.modelKey, error: p.error }));
    return { job: detail, estimate: routing?.estimate ?? null, request: job.request, attempts };
  });

  app.post('/api/generations/:id/cancel', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    return { job: await toPublicJob(ctx, await cancelGeneration(ctx, u, id)) };
  });

  app.post('/api/generations/:id/retry', genLimit, async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const { idempotencyKey } = parse(z.object({ idempotencyKey: z.string().min(8).max(100) }), req.body);
    const { job, estimate } = await retryGeneration(ctx, u, id, idempotencyKey);
    return { job: await toPublicJob(ctx, job), estimate };
  });

  // ------------------------------------------------------------ AI Director
  const directorLimit = { config: { rateLimit: { max: ctx.env.isTest ? 10_000 : 20, timeWindow: '1 minute' } } };

  app.post('/api/director/enhance', directorLimit, async (req) => {
    requireUser(req);
    const spec = parse(videoSpecSchema, req.body);
    return ctx.director.enhancePrompt({ ...spec });
  });

  app.post('/api/director/concepts', directorLimit, async (req) => {
    requireUser(req);
    return ctx.director.concepts(parse(conceptsRequestSchema, req.body));
  });

  app.post('/api/director/social-copy', directorLimit, async (req) => {
    requireUser(req);
    const body = parse(socialCopyRequestSchema.extend({ durationSec: z.number().int().min(3).max(600).optional() }), req.body);
    return ctx.director.socialCopy(body);
  });

  // ------------------------------------------------------------ projects
  app.get('/api/projects', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ kind: z.string().optional(), status: z.string().optional() }), req.query);
    const conds = [eq(projects.userId, u.id), isNull(projects.deletedAt)];
    if (q.kind) conds.push(eq(projects.kind, q.kind as never));
    if (q.status) conds.push(eq(projects.status, q.status));
    const rows = await ctx.db.select().from(projects).where(and(...conds)).orderBy(desc(projects.updatedAt)).limit(200);
    const thumbIds = rows.map((r) => r.thumbnailAssetId).filter(Boolean) as string[];
    const thumbs = thumbIds.length ? await ctx.db.select().from(assets).where(inArray(assets.id, thumbIds)) : [];
    const counts = await ctx.db
      .select({ projectId: generationJobs.projectId, n: sql<number>`count(*)::int` })
      .from(generationJobs)
      .where(and(eq(generationJobs.userId, u.id), eq(generationJobs.kind, 'video')))
      .groupBy(generationJobs.projectId);
    return {
      projects: await Promise.all(
        rows.map(async (p) => {
          const t = thumbs.find((x) => x.id === p.thumbnailAssetId);
          return { ...p, thumbnailUrl: t ? await assetUrl(ctx, t) : null, generations: counts.find((c) => c.projectId === p.id)?.n ?? 0 };
        }),
      ),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    const u = requireUser(req);
    const body = parse(createProjectSchema, req.body);
    const [p] = await ctx.db.insert(projects).values({ ...body, userId: u.id, settings: body.settings ?? {} }).returning();
    return reply.status(201).send({ project: p });
  });

  app.get('/api/projects/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const [p] = await ctx.db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, u.id), isNull(projects.deletedAt)));
    if (!p) throw notFound('Project');
    const jobs = await listJobs(ctx, u.id, { projectId: id, limit: 100 });
    return { project: p, jobs: await Promise.all(jobs.map((j) => toPublicJob(ctx, j))) };
  });

  app.patch('/api/projects/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const body = parse(updateProjectSchema, req.body);
    const [p] = await ctx.db.update(projects).set({ ...body, updatedAt: new Date() }).where(and(eq(projects.id, id), eq(projects.userId, u.id), isNull(projects.deletedAt))).returning();
    if (!p) throw notFound('Project');
    return { project: p };
  });

  app.post('/api/projects/:id/duplicate', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const [p] = await ctx.db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, u.id), isNull(projects.deletedAt)));
    if (!p) throw notFound('Project');
    const [copy] = await ctx.db
      .insert(projects)
      .values({ userId: u.id, kind: p.kind, title: `${p.title} (copy)`.slice(0, 120), aspectRatio: p.aspectRatio, templateKey: p.templateKey, settings: p.settings, plan: p.plan })
      .returning();
    return reply.status(201).send({ project: copy });
  });

  app.delete('/api/projects/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const [p] = await ctx.db.update(projects).set({ deletedAt: new Date() }).where(and(eq(projects.id, id), eq(projects.userId, u.id), isNull(projects.deletedAt))).returning();
    if (!p) throw notFound('Project');
    return { ok: true };
  });

  // ------------------------------------------------------------ assets
  const uploadLimit = { config: { rateLimit: { max: ctx.env.isTest ? 10_000 : 30, timeWindow: '1 minute' } } };

  app.post('/api/assets', uploadLimit, async (req, reply) => {
    const u = requireUser(req);
    const file = await req.file();
    if (!file) throw badRequest('No file uploaded');
    const fields = Object.fromEntries(Object.entries(file.fields).map(([k, v]) => [k, (v as { value?: string })?.value]));
    const meta = parse(
      z.object({
        projectId: z.string().uuid().optional(),
        kind: z.enum(['upload', 'reference']).default('upload'),
        rightsConfirmed: z.enum(['true', 'false']).optional(),
        containsPeople: z.enum(['true', 'false']).optional(),
      }),
      fields,
    );
    const tmp = tmpFile();
    try {
      await pipeline(file.file, fs.createWriteStream(tmp));
      if (file.file.truncated) throw badRequest(`Files must be under ${ctx.env.MAX_UPLOAD_MB} MB`);
      const sniffed = (await sniffMime(tmp)) ?? (file.mimetype === 'text/plain' || file.filename.endsWith('.srt') ? 'text/plain' : undefined);
      const mediaType = sniffed ? ALLOWED_UPLOADS[sniffed] : undefined;
      if (!sniffed || !mediaType) throw badRequest('Unsupported file type. Upload JPG, PNG, WebP, MP4, MOV, M4V, WebM, MKV, MP3, WAV, M4A or SRT.');
      if (meta.rightsConfirmed !== 'true') throw badRequest('Please confirm you own or have permission to use this file.');
      if (meta.projectId) {
        const [p] = await ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, meta.projectId), eq(projects.userId, u.id)));
        if (!p) throw notFound('Project');
      }
      if (sniffed === 'image/heic') throw badRequest('HEIC photos cannot be decoded on this server. Upload as JPEG.');
      const asset = await storeAsset(ctx, { userId: u.id, projectId: meta.projectId, kind: meta.kind, mediaType, filePath: tmp, mimeType: sniffed, originalName: file.filename, source: { uploaded: true, containsPeople: meta.containsPeople === 'true', ...(mediaType === 'video' ? { prep: { status: 'processing' } } : {}) } });
      await ctx.db.insert(consents).values({ userId: u.id, kind: meta.containsPeople === 'true' ? 'likeness' : 'copyright', version: TERMS_VERSION, subjectRef: asset.id, ip: req.ip });
      // Editing proxy for MOV/HEVC/4K/HDR footage (the master stays untouched).
      if (mediaType === 'video') await enqueue(ctx.db, 'media.prepare', { assetId: asset.id }, { queue: 'media', dedupeKey: `media-prepare:${asset.id}`, maxAttempts: 3 });
      return reply.status(201).send({ asset: await publicAsset(ctx, asset) });
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  });

  app.get('/api/assets', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ projectId: z.string().uuid().optional(), mediaType: z.enum(['video', 'image', 'audio', 'text']).optional(), kind: z.string().optional(), limit: z.coerce.number().int().max(200).default(60) }), req.query);
    const conds = [eq(assets.userId, u.id), isNull(assets.deletedAt), sql`${assets.kind} not in ('thumbnail','frame')`];
    if (q.projectId) conds.push(eq(assets.projectId, q.projectId));
    if (q.mediaType) conds.push(eq(assets.mediaType, q.mediaType));
    if (q.kind) conds.push(eq(assets.kind, q.kind as never));
    const rows = await ctx.db.select().from(assets).where(and(...conds)).orderBy(desc(assets.createdAt)).limit(q.limit);
    const thumbIds = rows.map((r) => r.thumbnailAssetId).filter(Boolean) as string[];
    const thumbs = thumbIds.length ? await ctx.db.select().from(assets).where(inArray(assets.id, thumbIds)) : [];
    return {
      assets: await Promise.all(
        rows
          .filter((a) => (a.source as { segment?: number }).segment === undefined)
          .map(async (a) => {
            const t = thumbs.find((x) => x.id === a.thumbnailAssetId);
            return { ...a, url: await assetUrl(ctx, a), downloadUrl: await assetUrl(ctx, a, { download: true }), thumbnailUrl: t ? await assetUrl(ctx, t) : null, prep: prepOf(a) ?? null };
          }),
      ),
    };
  });

  app.get('/api/assets/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const a = await getOwnedAsset(ctx, u.id, id);
    return { asset: { ...a, url: await assetUrl(ctx, a), downloadUrl: await assetUrl(ctx, a, { download: true }) } };
  });

  /** Beats of a music track (for cutting to the beat). Cached on the asset; local analysis, free. */
  app.post('/api/assets/:id/beats', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const a = await getOwnedAsset(ctx, u.id, id);
    if (a.mediaType !== 'audio' && a.mediaType !== 'video') throw badRequest('Only music or video files have beats');
    const cached = (a.source as { beats?: BeatAnalysis }).beats;
    if (cached) return { beats: cached };
    const file = await downloadAssetToTemp(ctx, a);
    try {
      const beats = await detectBeats(file);
      await ctx.db.update(assets).set({ source: sql`jsonb_set(${assets.source}, '{beats}', ${JSON.stringify(beats)}::jsonb)` }).where(eq(assets.id, a.id));
      return { beats };
    } finally {
      await fsp.rm(file, { force: true });
    }
  });

  /** Logo "no background" variant: local flood-fill background removal (free). Cached per source + tolerance. */
  app.post('/api/assets/:id/remove-background', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const { tolerance } = parse(z.object({ tolerance: z.number().min(0.02).max(0.4).default(0.12) }), req.body);
    const src = await getOwnedAsset(ctx, u.id, id);
    if (src.mediaType !== 'image') throw badRequest('Only images can have their background removed');
    const [cached] = await ctx.db
      .select()
      .from(assets)
      .where(and(eq(assets.userId, u.id), isNull(assets.deletedAt), sql`${assets.source}->>'derivedFrom' = ${id}`, sql`(${assets.source}->>'bgTolerance')::float = ${tolerance}`));
    if (cached) return { asset: { ...cached, url: await assetUrl(ctx, cached) } };
    const input = await downloadAssetToTemp(ctx, src);
    const out = tmpFile('.png');
    try {
      await removeSolidBackground(input, out, { tolerance });
      const asset = await storeAsset(ctx, { userId: u.id, projectId: src.projectId, kind: 'upload', mediaType: 'image', filePath: out, mimeType: 'image/png', originalName: `${src.originalName ?? 'logo'} (no background)`, source: { derivedFrom: id, backgroundRemoved: true, bgTolerance: tolerance }, makeThumbnail: false });
      return reply.status(201).send({ asset: { ...asset, url: await assetUrl(ctx, asset) } });
    } finally {
      await Promise.all([fsp.rm(input, { force: true }), fsp.rm(out, { force: true })]);
    }
  });

  app.delete('/api/assets/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    await deleteAsset(ctx, u.id, id);
    await audit(ctx.db, { actorUserId: u.id, action: 'asset.deleted', targetType: 'asset', targetId: id });
    return { ok: true };
  });

  // ------------------------------------------------------------ characters & locations
  const withRefs = async <T extends { id: string }>(rows: T[], table: 'character' | 'location') => {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const refs =
      table === 'character'
        ? (await ctx.db.select({ ownerId: characterReferences.characterId, assetId: characterReferences.assetId, isPrimary: characterReferences.isPrimary }).from(characterReferences).where(inArray(characterReferences.characterId, ids)))
        : (await ctx.db.select({ ownerId: locationReferences.locationId, assetId: locationReferences.assetId }).from(locationReferences).where(inArray(locationReferences.locationId, ids))).map((r) => ({ ...r, isPrimary: false }));
    const refAssets = refs.length ? await ctx.db.select().from(assets).where(and(inArray(assets.id, refs.map((r) => r.assetId)), isNull(assets.deletedAt))) : [];
    return Promise.all(
      rows.map(async (r) => ({
        ...r,
        references: await Promise.all(
          refs
            .filter((x) => x.ownerId === r.id)
            .map(async (x) => {
              const a = refAssets.find((z) => z.id === x.assetId);
              return a ? { assetId: a.id, isPrimary: x.isPrimary, url: await assetUrl(ctx, a), isFixture: a.isFixture } : null;
            }),
        ).then((l) => l.filter(Boolean)),
      })),
    );
  };

  app.get('/api/characters', async (req) => {
    const u = requireUser(req);
    const rows = await ctx.db.select().from(characters).where(eq(characters.userId, u.id)).orderBy(desc(characters.updatedAt));
    return { characters: await withRefs(rows, 'character') };
  });

  const saveCharacter = async (userId: string, body: z.infer<typeof characterSchema>, id?: string) => {
    for (const a of body.referenceAssetIds) {
      const asset = await getOwnedAsset(ctx, userId, a);
      if (asset.mediaType !== 'image') throw badRequest('Character references must be images');
      if ((asset.source as { containsPeople?: boolean }).containsPeople && !body.likenessConsent) throw badRequest('Confirm you have consent from any real person shown in the reference images.');
    }
    const values = { name: body.name, description: body.description, appearance: body.appearance, clothing: body.clothing, styleMeta: body.styleMeta, voice: body.voice, likenessConsentAt: body.likenessConsent ? new Date() : null, updatedAt: new Date() };
    return ctx.db.transaction(async (tx) => {
      let row;
      if (id) {
        [row] = await tx.update(characters).set(values).where(and(eq(characters.id, id), eq(characters.userId, userId))).returning();
        if (!row) throw notFound('Character');
        await tx.delete(characterReferences).where(eq(characterReferences.characterId, id));
      } else {
        [row] = await tx.insert(characters).values({ ...values, userId }).returning();
      }
      if (body.referenceAssetIds.length) await tx.insert(characterReferences).values(body.referenceAssetIds.map((assetId, i) => ({ characterId: row!.id, assetId, isPrimary: i === 0 })));
      if (body.likenessConsent) await tx.insert(consents).values({ userId, kind: 'likeness', version: TERMS_VERSION, subjectRef: row!.id });
      return row!;
    });
  };

  app.post('/api/characters', async (req, reply) => {
    const u = requireUser(req);
    return reply.status(201).send({ character: await saveCharacter(u.id, parse(characterSchema, req.body)) });
  });

  app.put('/api/characters/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    return { character: await saveCharacter(u.id, parse(characterSchema, req.body), id) };
  });

  app.delete('/api/characters/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const r = await ctx.db.delete(characters).where(and(eq(characters.id, id), eq(characters.userId, u.id))).returning();
    if (!r.length) throw notFound('Character');
    return { ok: true };
  });

  app.post('/api/characters/:id/sheet', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const { idempotencyKey } = parse(z.object({ idempotencyKey: z.string().min(8) }), req.body);
    const [c] = await ctx.db.select().from(characters).where(and(eq(characters.id, id), eq(characters.userId, u.id)));
    if (!c) throw notFound('Character');
    const look = Object.values(c.appearance).filter(Boolean).join(', ');
    const job = await createImageJob(ctx, u, {
      prompt: `Character reference sheet, full body and close-up portrait, neutral background, consistent design: ${c.name}. ${c.description}. ${look}. Wearing ${c.clothing}.`,
      aspectRatio: '1:1',
      purpose: 'character',
      characterId: c.id,
      projectId: c.projectId ?? undefined,
      idempotencyKey,
    });
    return { job: await toPublicJob(ctx, job) };
  });

  app.get('/api/locations', async (req) => {
    const u = requireUser(req);
    const rows = await ctx.db.select().from(locations).where(eq(locations.userId, u.id)).orderBy(desc(locations.updatedAt));
    return { locations: await withRefs(rows, 'location') };
  });

  const saveLocation = async (userId: string, body: z.infer<typeof locationSchema>, id?: string) => {
    for (const a of body.referenceAssetIds) await getOwnedAsset(ctx, userId, a);
    return ctx.db.transaction(async (tx) => {
      let row;
      const values = { name: body.name, description: body.description, styleMeta: body.styleMeta, updatedAt: new Date() };
      if (id) {
        [row] = await tx.update(locations).set(values).where(and(eq(locations.id, id), eq(locations.userId, userId))).returning();
        if (!row) throw notFound('Location');
        await tx.delete(locationReferences).where(eq(locationReferences.locationId, id));
      } else [row] = await tx.insert(locations).values({ ...values, userId }).returning();
      if (body.referenceAssetIds.length) await tx.insert(locationReferences).values(body.referenceAssetIds.map((assetId) => ({ locationId: row!.id, assetId })));
      return row!;
    });
  };

  app.post('/api/locations', async (req, reply) => {
    const u = requireUser(req);
    return reply.status(201).send({ location: await saveLocation(u.id, parse(locationSchema, req.body)) });
  });
  app.put('/api/locations/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    return { location: await saveLocation(u.id, parse(locationSchema, req.body), id) };
  });
  app.delete('/api/locations/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    const r = await ctx.db.delete(locations).where(and(eq(locations.id, id), eq(locations.userId, u.id))).returning();
    if (!r.length) throw notFound('Location');
    return { ok: true };
  });

  // ------------------------------------------------------------ settings, prompts, notifications
  app.get('/api/settings', async (req) => {
    const u = requireUser(req);
    const [s] = await ctx.db.select().from(userSettings).where(eq(userSettings.userId, u.id));
    let logoUrl: string | null = null;
    if (s?.brandKit.logoAssetId) {
      const [a] = await ctx.db.select().from(assets).where(and(eq(assets.id, s.brandKit.logoAssetId), eq(assets.userId, u.id)));
      if (a) logoUrl = await assetUrl(ctx, a);
    }
    return { settings: s, logoUrl };
  });

  app.put('/api/settings', async (req) => {
    const u = requireUser(req);
    const body = parse(
      z.object({
        defaultQuality: z.enum(['economy', 'balanced', 'high', 'cinematic']).optional(),
        defaultAspectRatio: z.enum(['9:16', '16:9', '1:1', '4:5']).optional(),
        language: z.enum(['en', 'ka', 'ru']).optional(),
        brandKit: z.object({ colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8), logoAssetId: z.string().uuid().optional(), fontFamily: z.string().max(60).optional(), name: z.string().max(80).optional() }).optional(),
        dailySpendLimit: z.number().int().positive().nullable().optional(),
        perJobSpendLimit: z.number().int().positive().nullable().optional(),
        notifyEmail: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.brandKit?.logoAssetId) await getOwnedAsset(ctx, u.id, body.brandKit.logoAssetId);
    const [s] = await ctx.db.update(userSettings).set({ ...body, updatedAt: new Date() }).where(eq(userSettings.userId, u.id)).returning();
    return { settings: s };
  });

  app.get('/api/saved-prompts', async (req) => {
    const u = requireUser(req);
    return { prompts: await ctx.db.select().from(savedPrompts).where(eq(savedPrompts.userId, u.id)).orderBy(desc(savedPrompts.createdAt)).limit(100) };
  });
  app.post('/api/saved-prompts', async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({ title: z.string().min(1).max(80), prompt: z.string().min(1).max(4000), settings: z.record(z.string(), z.unknown()).default({}) }), req.body);
    const [p] = await ctx.db.insert(savedPrompts).values({ ...body, userId: u.id }).returning();
    return reply.status(201).send({ prompt: p });
  });
  app.delete('/api/saved-prompts/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuid, req.params);
    await ctx.db.delete(savedPrompts).where(and(eq(savedPrompts.id, id), eq(savedPrompts.userId, u.id)));
    return { ok: true };
  });

  app.get('/api/notifications', async (req) => {
    const u = requireUser(req);
    const rows = await ctx.db.select().from(notifications).where(eq(notifications.userId, u.id)).orderBy(desc(notifications.createdAt)).limit(30);
    return { notifications: rows, unread: rows.filter((n) => !n.readAt).length };
  });
  app.post('/api/notifications/read', async (req) => {
    const u = requireUser(req);
    await ctx.db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, u.id), isNull(notifications.readAt)));
    return { ok: true };
  });
}
