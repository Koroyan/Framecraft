import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestHarness } from './helpers/context';
import { createMockFetch } from './helpers/mock-fetch';
import { generateFixtureClip, generatePlaceholderImage } from '../src/media/ffmpeg';
import { storeAsset } from '../src/services/assets';
import { createMovie, estimateMovie, generateMovie } from '../src/movie/movie';
import { createGeneration, estimateGeneration } from '../src/generation/service';
import { characterReferences, characters, generationJobs, shots } from '../src/db/schema';

let mp4: Buffer;
let jpg: Buffer;
beforeAll(async () => {
  const v = path.join(os.tmpdir(), `fc-kf-video-${process.pid}.mp4`);
  await generateFixtureClip(v, { width: 1280, height: 720, durationSec: 6, title: 'Mock clip' });
  mp4 = fs.readFileSync(v);
  const i = path.join(os.tmpdir(), `fc-kf-frame-${process.pid}.jpg`);
  await generatePlaceholderImage(i, { width: 1280, height: 720, title: 'Mock keyframe' });
  jpg = fs.readFileSync(i);
}, 60_000);

describe('keyframed films (consistent characters on cheap image-to-video models)', () => {
  let h: TestHarness;
  const mock = createMockFetch();
  let n = 0;
  beforeAll(async () => {
    const RW = 'https://api.dev.runwayml.com/v1';
    mock
      .on('POST', `${RW}/text_to_image`, () => ({ json: { id: `img-${++n}` } }))
      .on('POST', `${RW}/image_to_video`, () => ({ json: { id: `vid-${++n}` } }))
      .on('POST', `${RW}/text_to_video`, () => ({ json: { id: `vid-${++n}` } }))
      .on('GET', new RegExp(`${RW}/tasks/`), (c) => {
        const id = c.url.split('/tasks/')[1]!;
        return { json: { id, status: 'SUCCEEDED', progress: 1, output: [id.startsWith('img') ? 'https://cdn.runway.test/frame.jpg' : 'https://cdn.runway.test/clip.mp4'] } };
      })
      .on('GET', 'https://cdn.runway.test/frame.jpg', () => ({ bytes: jpg }))
      .on('GET', 'https://cdn.runway.test/clip.mp4', () => ({ bytes: mp4 }));
    h = await createTestContext({ env: { LIVE_GENERATION_ENABLED: 'true', RUNWAYML_API_SECRET: 'rw_test_key', DEV_FIXTURES_ENABLED: 'false' }, fetch: mock.fetch });
  });
  afterAll(() => h.close());

  it('draws each keyframe with the character photo, then animates it within the approved budget', async () => {
    const u = await h.makeUser(undefined, 'user', 50_000);
    const { projectId } = await createMovie(h.ctx, u, { idea: 'Nino walks through old Tbilisi at dawn and finds a lost letter.', lengthSec: 15, quality: 'economy', withDialogue: false, withMusic: false }, 'kf-movie-1');
    await h.drain();

    // Nino is a library character with a photo, cast in every shot.
    const f = path.join(os.tmpdir(), `fc-kf-nino-${process.pid}.jpg`);
    await generatePlaceholderImage(f, { width: 512, height: 512, title: 'Nino' });
    const photo = await storeAsset(h.ctx, { userId: u.id, kind: 'reference', mediaType: 'image', filePath: f, mimeType: 'image/jpeg' });
    const [nino] = await h.ctx.db.insert(characters).values({ userId: u.id, name: 'Nino', description: 'young woman' }).returning();
    await h.ctx.db.insert(characterReferences).values({ characterId: nino!.id, assetId: photo.id, isPrimary: true });
    await h.ctx.db.update(shots).set({ characterIds: [nino!.id] }).where(eq(shots.projectId, projectId));

    const est = await estimateMovie(h.ctx, u, projectId, { onlyMissing: true });
    expect(est.ok).toBe(true);
    expect(est.shots.every((s) => s.keyframe === 'drawn first')).toBe(true);

    const mj = await generateMovie(h.ctx, u, projectId, { approvedCredits: est.totalCredits, idempotencyKey: 'kf-gen-1' });
    await h.drain(150);

    // Every keyframe request carried Nino's photo.
    const frameCalls = mock.calls.filter((c) => c.url.endsWith('/text_to_image'));
    expect(frameCalls.length).toBe(est.shots.length);
    expect(frameCalls.every((c) => ((c.body as { referenceImages?: unknown[] }).referenceImages ?? []).length >= 1)).toBe(true);
    // muse_image rejects a `tag` on reference images.
    expect(frameCalls.every((c) => ((c.body as { referenceImages?: object[] }).referenceImages ?? []).every((r) => !('tag' in r)))).toBe(true);
    // Every shot started from its keyframe (image-to-video), never text-to-video.
    const videoCalls = mock.calls.filter((c) => /\/(image|text)_to_video$/.test(c.url));
    expect(videoCalls.length).toBeGreaterThan(0);
    expect(videoCalls.every((c) => c.url.endsWith('/image_to_video'))).toBe(true);

    const rows = await h.ctx.db.select().from(shots).where(eq(shots.projectId, projectId));
    expect(rows.every((s) => s.storyboardAssetId && s.currentAssetId)).toBe(true);
    const [done] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, mj.id));
    expect(done!.status).toBe('completed');
    expect(done!.chargedCredits).toBeLessThanOrEqual(est.totalCredits);
  }, 240_000);

  it('single video with a saved character: first frame from the photo, then image-to-video', async () => {
    const u = await h.makeUser(undefined, 'user', 50_000);
    const f = path.join(os.tmpdir(), `fc-kf-giorgi-${process.pid}.jpg`);
    await generatePlaceholderImage(f, { width: 512, height: 512, title: 'Giorgi' });
    const photo = await storeAsset(h.ctx, { userId: u.id, kind: 'reference', mediaType: 'image', filePath: f, mimeType: 'image/jpeg' });
    const [giorgi] = await h.ctx.db.insert(characters).values({ userId: u.id, name: 'Giorgi', description: 'bearded man' }).returning();
    await h.ctx.db.insert(characterReferences).values({ characterId: giorgi!.id, assetId: photo.id, isPrimary: true });
    const spec = { prompt: 'Giorgi laughs in a cozy workshop', aspectRatio: '16:9' as const, durationSec: 5, quality: 'economy' as const, characterIds: [giorgi!.id], enhancePrompt: false };
    const est = await estimateGeneration(h.ctx, u, spec);
    expect(est.ok).toBe(true);
    expect(est.warnings.join(' ')).toMatch(/first frame is drawn/);
    const before = mock.calls.length;
    const { job } = await createGeneration(h.ctx, u, { spec, idempotencyKey: 'kf-single-1', confirmEstimate: true });
    await h.drain(60);
    const calls = mock.calls.slice(before);
    const frame = calls.find((c) => c.url.endsWith('/text_to_image'))!;
    expect(((frame.body as { referenceImages?: unknown[] }).referenceImages ?? []).length).toBe(1);
    expect(calls.filter((c) => /_to_video$/.test(c.url)).every((c) => c.url.endsWith('/image_to_video'))).toBe(true);
    const [done] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, job.id));
    expect(done!.status).toBe('completed');
    expect(done!.chargedCredits).toBe(est.credits);
  }, 120_000);
});
