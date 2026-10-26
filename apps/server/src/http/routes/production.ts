import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { movieBriefSchema, renderRequestSchema, timelineSchema } from '@framecraft/shared';
import type { AppContext } from '../../context';
import { parse, requireUser } from '../app';
import { addShot, createMovie, deleteShot, estimateMovie, chooseVoiceTake, generateMovie, getMovie, redubMovie, estimateShotRegeneration, regenerateShot, reorderScenes, reorderShots, storyboardMovie, updateShot } from '../../movie/movie';
import { createRenderJob, getTimeline, listVersions, restoreVersion, saveTimeline } from '../../editor/editor';
import { createAudioJob, estimateAudio, type AudioJobInput } from '../../audio/audio';
import { DEFAULT_VOICES } from '../../providers/audio/elevenlabs';
import { createImageJob } from '../../images/images';
import { dubTrack, estimateDialogue } from '../../movie/dub';
import { inArray } from 'drizzle-orm';
import { assets } from '../../db/schema';
import { getOwnedJob, toPublicJob } from '../../generation/service';
import { assetUrl } from '../../services/assets';

const idParam = z.object({ id: z.string().uuid() });
const idem = z.object({ idempotencyKey: z.string().min(8).max(120) });

const audioInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tts'), text: z.string().min(1).max(5000), voiceId: z.string().max(80).optional(), language: z.enum(['en', 'ka', 'ru']).default('en'), quality: z.enum(['standard', 'high']).optional(), projectId: z.string().uuid().optional() }),
  z.object({ kind: z.literal('music'), prompt: z.string().min(3).max(2000), durationSec: z.number().min(5).max(300), projectId: z.string().uuid().optional() }),
  z.object({ kind: z.literal('sfx'), prompt: z.string().min(3).max(500), durationSec: z.number().min(0.5).max(30).optional(), projectId: z.string().uuid().optional() }),
  z.object({ kind: z.literal('transcribe'), assetId: z.string().uuid(), language: z.enum(['en', 'ka', 'ru']).optional(), projectId: z.string().uuid().optional() }),
]);

const shotPatchSchema = z.object({
  description: z.string().max(500).optional(),
  prompt: z.string().max(4000).optional(),
  durationSec: z.number().int().min(2).max(30).optional(),
  shotType: z.string().max(40).nullable().optional(),
  camera: z.string().max(40).nullable().optional(),
  characterIds: z.array(z.string().uuid()).max(5).optional(),
  dialogue: z.array(z.object({ characterId: z.string().uuid().optional(), speaker: z.string().max(80), line: z.string().max(300) })).max(6).optional(),
  sfx: z.string().max(200).nullable().optional(),
  modelOverride: z.string().max(80).nullable().optional(),
  quality: z.enum(['economy', 'balanced', 'high', 'cinematic']).nullable().optional(),
  approved: z.boolean().optional(),
});

export async function productionRoutes(app: FastifyInstance, ctx: AppContext) {
  // ------------------------------------------------------------ movies
  app.post('/api/movies', async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({ brief: z.unknown(), idempotencyKey: z.string().min(8) }), req.body);
    return reply.status(201).send(await createMovie(ctx, u, body.brief, body.idempotencyKey));
  });

  app.get('/api/movies/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const m = await getMovie(ctx, u, id);
    const urls = Object.fromEntries(await Promise.all(m.assets.map(async (a) => [a.id, { url: await assetUrl(ctx, a), isFixture: a.isFixture }] as const)));
    const pub = async (j: typeof m.movieJob) => (j ? toPublicJob(ctx, j) : null);
    // Each shot's current dialogue takes, timed within the shot as in the film, so the shot preview
    // plays the dubbed voices (and mutes speech the video model rendered itself).
    const track = await dubTrack(ctx.db, id);
    const voiceAssets = [...track.voices.values()].flat().map((v) => v.assetId);
    const voiceRows = voiceAssets.length ? await ctx.db.select().from(assets).where(inArray(assets.id, voiceAssets)) : [];
    const voiceUrl = new Map(await Promise.all(voiceRows.map(async (a) => [a.id, await assetUrl(ctx, a)] as const)));
    const takeAssets = [...track.takes.values()].flat().map((t) => t.assetId);
    const takeRows = takeAssets.length ? await ctx.db.select().from(assets).where(inArray(assets.id, takeAssets)) : [];
    const takeUrl = new Map(await Promise.all(takeRows.map(async (a) => [a.id, await assetUrl(ctx, a)] as const)));
    type Take = { assetId: string; url: string; createdAt: string; current: boolean };
    const dub: Record<string, { clipVolume: number; voices: { url: string; startSec: number; durationSec: number }[]; lines: { index: number; takes: Take[] }[] }> = {};
    for (const [line, list] of track.takes) {
      const [shotId, index] = line.split(':');
      dub[shotId!] ??= { clipVolume: 0, voices: [], lines: [] };
      dub[shotId!]!.lines.push({ index: Number(index), takes: list.map((t) => ({ ...t, url: takeUrl.get(t.assetId) ?? '' })) });
    }
    for (const [shotId, list] of track.voices) {
      let at = 0.3;
      dub[shotId] ??= { clipVolume: 0, voices: [], lines: [] };
      for (const v of list) {
        const url = voiceUrl.get(v.assetId);
        if (url) dub[shotId]!.voices.push({ url, startSec: at, durationSec: v.durationSec });
        at += v.durationSec + 0.25;
      }
    }
    return {
      project: m.project,
      scenes: m.scenes,
      characters: m.characters,
      locations: m.locations,
      planJob: await pub(m.planJob),
      movieJob: await pub(m.movieJob),
      renderJob: await pub(m.renderJob),
      shotJobs: await Promise.all(m.shotJobs.map((j) => toPublicJob(ctx, j))),
      assetUrls: urls,
      dub,
    };
  });

  app.post('/api/movies/:id/estimate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { onlyMissing } = parse(z.object({ onlyMissing: z.boolean().default(true) }), req.body);
    return { estimate: await estimateMovie(ctx, u, id, { onlyMissing }) };
  });

  app.post('/api/movies/:id/generate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(idem.extend({ approvedCredits: z.number().int().min(0) }), req.body);
    const job = await generateMovie(ctx, u, id, body);
    return { job: await toPublicJob(ctx, job) };
  });

  // Re-voice a finished film's dialogue with ElevenLabs (no video is regenerated).
  app.post('/api/movies/:id/dub/estimate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const m = await getMovie(ctx, u, id);
    const { shotIds } = parse(z.object({ shotIds: z.array(z.string().uuid()).max(200).optional() }), req.body ?? {});
    const brief = movieBriefSchema.parse((m.project.settings as { brief: unknown }).brief);
    return { estimate: { ...(await estimateDialogue(ctx, u, id, brief.language, shotIds)), language: brief.language } };
  });

  app.post('/api/movies/:id/dub', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(idem.extend({ approvedCredits: z.number().int().min(0), shotIds: z.array(z.string().uuid()).max(200).optional() }), req.body);
    return { job: await toPublicJob(ctx, await redubMovie(ctx, u, id, body)) };
  });

  app.post('/api/movies/:id/voice-take', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ shotId: z.string().uuid(), index: z.number().int().min(0).max(20), assetId: z.string().uuid().nullable() }), req.body);
    return chooseVoiceTake(ctx, u, id, body);
  });

  app.post('/api/movies/:id/storyboard', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { idempotencyKey } = parse(idem, req.body);
    const jobs = await storyboardMovie(ctx, u, id, idempotencyKey);
    return { jobs: await Promise.all(jobs.map((j) => toPublicJob(ctx, j))) };
  });

  app.post('/api/movies/:id/scenes/reorder', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { order } = parse(z.object({ order: z.array(z.string().uuid()).max(200) }), req.body);
    await reorderScenes(ctx, u, id, order);
    return { ok: true };
  });

  app.post('/api/scenes/:id/shots', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ description: z.string().min(1).max(500), prompt: z.string().min(3).max(4000), durationSec: z.number().int().min(2).max(30).optional(), afterIndex: z.number().int().min(-1).optional() }), req.body);
    return reply.status(201).send({ shot: await addShot(ctx, u, id, body) });
  });

  app.post('/api/scenes/:id/reorder', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { order } = parse(z.object({ order: z.array(z.string().uuid()).max(200) }), req.body);
    await reorderShots(ctx, u, id, order);
    return { ok: true };
  });

  app.patch('/api/shots/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return { shot: await updateShot(ctx, u, id, parse(shotPatchSchema, req.body) as never) };
  });

  app.delete('/api/shots/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await deleteShot(ctx, u, id);
    return { ok: true };
  });

  // Price first: the editor shows it and asks before any paid regeneration.
  app.get('/api/shots/:id/regenerate/estimate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return { credits: await estimateShotRegeneration(ctx, u, id) };
  });

  app.post('/api/shots/:id/regenerate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { idempotencyKey } = parse(idem, req.body);
    const { job, estimate } = await regenerateShot(ctx, u, id, idempotencyKey);
    // Logo shots are rebuilt instantly from the logo file (no job).
    return { job: job ? await toPublicJob(ctx, job) : null, estimate };
  });

  // ------------------------------------------------------------ editor
  app.get('/api/projects/:id/timeline', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const t = await getTimeline(ctx, u, id);
    return { timeline: t.timeline, version: t.version, label: t.label, durationSec: t.durationSec, project: t.project };
  });

  app.put('/api/projects/:id/timeline', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ timeline: timelineSchema, label: z.string().max(80).optional(), autosave: z.boolean().default(false) }), req.body);
    return saveTimeline(ctx, u, id, body.timeline, { label: body.label, autosave: body.autosave });
  });

  app.get('/api/projects/:id/versions', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    return { versions: await listVersions(ctx, u, id) };
  });

  app.post('/api/projects/:id/versions/:version/restore', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.string().uuid(), version: z.coerce.number().int().positive() }), req.params);
    return restoreVersion(ctx, u, p.id, p.version);
  });

  app.post('/api/projects/:id/render', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(renderRequestSchema, req.body);
    const job = await createRenderJob(ctx, u, id, body);
    return { job: await toPublicJob(ctx, job) };
  });

  // ------------------------------------------------------------ audio & images
  app.get('/api/audio/voices', async () => ({ voices: DEFAULT_VOICES, configured: ctx.audio.isConfigured() }));

  app.post('/api/audio/estimate', async (req) => {
    const u = requireUser(req);
    const input = parse(audioInputSchema, req.body);
    return { estimate: await estimateAudio(ctx, u, { ...input, idempotencyKey: 'estimate' } as AudioJobInput) };
  });

  app.post('/api/audio', async (req) => {
    const u = requireUser(req);
    const body = parse(z.intersection(audioInputSchema, idem), req.body);
    const { job, reused } = await createAudioJob(ctx, u, body as AudioJobInput);
    return { job: await toPublicJob(ctx, job), reused, transcript: job.kind === 'audio' && job.status === 'completed' ? job.checkpoint : undefined };
  });

  app.get('/api/audio/:id/transcript', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const job = await getOwnedJob(ctx, u, id);
    return { status: job.status, transcript: job.status === 'completed' ? job.checkpoint : null };
  });

  app.post('/api/images', async (req) => {
    const u = requireUser(req);
    const body = parse(
      idem.extend({
        prompt: z.string().min(3).max(2000),
        aspectRatio: z.enum(['9:16', '16:9', '1:1', '4:5']).default('9:16'),
        purpose: z.enum(['storyboard', 'character', 'frame']).default('frame'),
        referenceAssetIds: z.array(z.string().uuid()).max(3).optional(),
        projectId: z.string().uuid().optional(),
      }),
      req.body,
    );
    const job = await createImageJob(ctx, u, body);
    return { job: await toPublicJob(ctx, job) };
  });
}
