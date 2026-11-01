import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { movieBriefSchema } from '@framecraft/shared';
import { createTestContext, type TestHarness } from './helpers/context';
import { createMockFetch } from './helpers/mock-fetch';
import { generatePlaceholderImage } from '../src/media/ffmpeg';
import { storeAsset } from '../src/services/assets';
import { createReferenceViews, viewsEstimateFor } from '../src/images/views';
import { createMovie, getMovie } from '../src/movie/movie';
import { Director } from '../src/director/director';
import { FakeLlm } from '../src/director/llm';
import { getWallet } from '../src/billing/wallet';
import { characterReferences, characters, generationJobs, locationReferences, locations, scenes, shots } from '../src/db/schema';

let jpg: Buffer;
beforeAll(async () => {
  const i = path.join(os.tmpdir(), `fc-views-${process.pid}.jpg`);
  await generatePlaceholderImage(i, { width: 720, height: 1280, title: 'Mock view' });
  jpg = fs.readFileSync(i);
}, 60_000);

async function photo(h: TestHarness, userId: string, title: string) {
  const f = path.join(os.tmpdir(), `fc-views-${title}-${process.pid}.jpg`);
  await generatePlaceholderImage(f, { width: 512, height: 512, title });
  return storeAsset(h.ctx, { userId, kind: 'reference', mediaType: 'image', filePath: f, mimeType: 'image/jpeg' });
}

describe('reference views — four angles of a character or place (fixture mode)', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createTestContext();
  });
  afterAll(() => h.close());

  it('makes the first view, then the other three from it; every view becomes a reference', async () => {
    const u = await h.makeUser();
    const [c] = await h.ctx.db.insert(characters).values({ userId: u.id, name: 'Giorgi', description: 'a tall baker with a flour-dusted apron' }).returning();
    const jobs = await createReferenceViews(h.ctx, u, 'character', c!.id, { idempotencyKey: 'views-giorgi-1' });
    expect(jobs).toHaveLength(4);
    expect(jobs.map((j) => j.status)).toEqual(['queued', 'draft', 'draft', 'draft']);
    // Asking again while they are being made does not start (or charge) a second set.
    expect((await createReferenceViews(h.ctx, u, 'character', c!.id, { idempotencyKey: 'views-giorgi-2' })).map((j) => j.id).sort()).toEqual(jobs.map((j) => j.id).sort());

    await h.drain();
    const done = await h.ctx.db.select().from(generationJobs).where(inArray(generationJobs.id, jobs.map((j) => j.id)));
    expect(done.every((j) => j.status === 'completed')).toBe(true);
    // Views 2–4 used the first view's picture as their reference (one design from every side).
    const first = done.find((j) => j.id === jobs[0]!.id)!;
    for (const j of done.filter((x) => x.id !== first.id)) expect((j.request as { referenceAssetIds?: string[] }).referenceAssetIds?.[0]).toBe(first.outputAssetId);
    const refs = await h.ctx.db.select().from(characterReferences).where(eq(characterReferences.characterId, c!.id));
    expect(refs).toHaveLength(4);
    expect(refs.filter((r) => r.isPrimary).map((r) => r.assetId)).toEqual([first.outputAssetId]);
    expect(refs.map((r) => r.label).sort()).toEqual(['AI view: back', 'AI view: front', 'AI view: side', 'AI view: three-quarter']);
    // Fixture mode never presents placeholders as AI.
    expect(done.every((j) => j.isFixture)).toBe(true);
  });

  it('uses the place’s own photo for all four views at once', async () => {
    const u = await h.makeUser();
    const pic = await photo(h, u.id, 'Courtyard');
    const [l] = await h.ctx.db.insert(locations).values({ userId: u.id, name: 'Old courtyard', description: 'a Tbilisi courtyard with wooden balconies' }).returning();
    await h.ctx.db.insert(locationReferences).values({ locationId: l!.id, assetId: pic.id });
    const jobs = await createReferenceViews(h.ctx, u, 'location', l!.id, { idempotencyKey: 'views-yard-1' });
    expect(jobs.map((j) => j.status)).toEqual(['queued', 'queued', 'queued', 'queued']);
    expect(jobs.every((j) => (j.request as { referenceAssetIds?: string[] }).referenceAssetIds?.[0] === pic.id)).toBe(true);
    await h.drain();
    expect(await h.ctx.db.select().from(locationReferences).where(eq(locationReferences.locationId, l!.id))).toHaveLength(5);
  });

  it('refuses someone else’s character', async () => {
    const a = await h.makeUser();
    const b = await h.makeUser();
    const [c] = await h.ctx.db.insert(characters).values({ userId: a.id, name: 'Private', description: 'x' }).returning();
    await expect(createReferenceViews(h.ctx, b, 'character', c!.id, { idempotencyKey: 'views-x-1' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('reference views with a live image provider (mocked HTTP, nothing real is called)', () => {
  let h: TestHarness;
  const mock = createMockFetch();
  let n = 0;
  beforeAll(async () => {
    const RW = 'https://api.dev.runwayml.com/v1';
    mock
      .on('POST', `${RW}/text_to_image`, () => ({ json: { id: `img-${++n}` } }))
      .on('GET', new RegExp(`${RW}/tasks/`), (c) => ({ json: { id: c.url.split('/tasks/')[1], status: 'SUCCEEDED', progress: 1, output: ['https://cdn.runway.test/view.jpg'] } }))
      .on('GET', 'https://cdn.runway.test/view.jpg', () => ({ bytes: jpg }));
    h = await createTestContext({ env: { LIVE_GENERATION_ENABLED: 'true', RUNWAYML_API_SECRET: 'rw_test_key', DEV_FIXTURES_ENABLED: 'false' }, fetch: mock.fetch });
  });
  afterAll(() => h.close());

  it('quotes four images, reserves them up front and charges each view once', async () => {
    const u = await h.makeUser(undefined, 'user', 5_000);
    const [c] = await h.ctx.db.insert(characters).values({ userId: u.id, name: 'Nino', description: 'young woman in a red coat' }).returning();
    const est = await viewsEstimateFor(h.ctx, u, 'character', c!.id);
    expect(est.available).toBe(true);
    expect(est.credits).toBeGreaterThan(0);
    const before = await getWallet(h.ctx.db, u.id);
    const jobs = await createReferenceViews(h.ctx, u, 'character', c!.id, { idempotencyKey: 'live-views-1' });
    const held = await getWallet(h.ctx.db, u.id);
    expect(held.reserved - before.reserved).toBe(jobs.reduce((s, j) => s + (j.estimatedCredits ?? 0), 0));
    await h.drain();
    const after = await getWallet(h.ctx.db, u.id);
    expect(after.reserved).toBe(before.reserved);
    expect(before.balance - after.balance).toBe(jobs.reduce((s, j) => s + (j.estimatedCredits ?? 0), 0));
    expect(await h.ctx.db.select().from(characterReferences).where(eq(characterReferences.characterId, c!.id))).toHaveLength(4);
    expect(mock.calls.filter((x) => x.method === 'POST' && x.url.endsWith('/text_to_image'))).toHaveLength(4);
  });

  it('asks for enough credits for all four before starting', async () => {
    const u = await h.makeUser(undefined, 'user', 0);
    const [c] = await h.ctx.db.insert(characters).values({ userId: u.id, name: 'Poor', description: 'x' }).returning();
    await expect(createReferenceViews(h.ctx, u, 'character', c!.id, { idempotencyKey: 'live-views-poor' })).rejects.toMatchObject({ status: 402 });
    expect(await h.ctx.db.select().from(generationJobs).where(and(eq(generationJobs.userId, u.id), eq(generationJobs.kind, 'image')))).toHaveLength(0);
  });
});

describe('films with saved characters and places', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createTestContext();
  });
  afterAll(() => h.close());

  it('casts the saved character and location as themselves (no copies) and shows them in the film', async () => {
    const u = await h.makeUser();
    const face = await photo(h, u.id, 'Nino');
    const [nino] = await h.ctx.db.insert(characters).values({ userId: u.id, name: 'Nino', description: 'young violinist', clothing: 'green coat' }).returning();
    await h.ctx.db.insert(characterReferences).values({ characterId: nino!.id, assetId: face.id, isPrimary: true });
    const [yard] = await h.ctx.db.insert(locations).values({ userId: u.id, name: 'Old courtyard', description: 'wooden balconies' }).returning();
    const { projectId } = await createMovie(h.ctx, u, { idea: 'Nino plays the violin for her neighbours at dusk.', lengthSec: 15, quality: 'economy', withDialogue: false, withMusic: false, characterIds: [nino!.id], locationIds: [yard!.id] }, 'cast-movie-1');
    await h.drain();

    const shotRows = await h.ctx.db.select().from(shots).where(eq(shots.projectId, projectId));
    expect(shotRows.length).toBeGreaterThan(0);
    expect(shotRows.every((s) => s.characterIds.includes(nino!.id))).toBe(true);
    const sceneRows = await h.ctx.db.select().from(scenes).where(eq(scenes.projectId, projectId));
    expect(sceneRows.every((s) => s.locationId === yard!.id)).toBe(true);
    // No duplicate Nino or courtyard was made for the film.
    expect(await h.ctx.db.select().from(characters).where(eq(characters.userId, u.id))).toHaveLength(1);
    expect(await h.ctx.db.select().from(locations).where(eq(locations.userId, u.id))).toHaveLength(1);
    const movie = await getMovie(h.ctx, u, projectId);
    expect(movie.characters.map((c) => c.id)).toEqual([nino!.id]);
    expect(movie.characters[0]!.referenceAssetIds).toEqual([face.id]);
    expect(movie.locations.map((l) => l.id)).toEqual([yard!.id]);
  });

  it('rejects a character that belongs to someone else', async () => {
    const a = await h.makeUser();
    const b = await h.makeUser();
    const [c] = await h.ctx.db.insert(characters).values({ userId: a.id, name: 'Private', description: 'x' }).returning();
    await expect(createMovie(h.ctx, b, { idea: 'A short story about a quiet street.', lengthSec: 15, characterIds: [c!.id] }, 'cast-movie-x')).rejects.toMatchObject({ status: 404 });
  });

  it('tells the AI Director who the saved cast is, and to invent the rest when nothing is picked', async () => {
    const plan = { title: 'T', logline: 'L', genre: 'Drama', characters: [{ key: 'c1', name: 'Nino', description: 'd', appearance: 'a', clothing: 'c', voiceStyle: 'calm', referenceTokens: [] }], locations: [{ key: 'l1', name: 'Yard', description: 'd', referenceTokens: [] }], scenes: [{ title: 'S', synopsis: 's', locationKey: 'l1', shots: [{ description: 'x', prompt: 'Nino plays', durationSec: 5, shotType: 'Wide', camera: 'static', characterKeys: ['c1'], dialogue: [], sfx: '', needsNativeAudio: false, referenceTokens: [] }] }], music: { mood: 'm', prompt: 'p' } };
    const llm = new FakeLlm(() => plan);
    const brief = movieBriefSchema.parse({ idea: 'Nino plays the violin at dusk.', lengthSec: 15 });
    await new Director(llm).screenplay(brief, [], { characters: [{ name: 'Nino', description: 'young violinist', appearance: 'curly dark hair', clothing: 'green coat' }], locations: [] });
    expect(llm.calls[0]!.prompt).toContain('Saved characters from the user');
    expect(llm.calls[0]!.prompt).toContain('Nino — young violinist; looks: curly dark hair; wears: green coat');
    expect(llm.calls[0]!.prompt).toContain('No saved locations: invent the places yourself');
    await new Director(llm).screenplay(brief, []);
    expect(llm.calls[1]!.prompt).toContain('invent the characters, locations and look yourself');
    expect(llm.calls[1]!.prompt).not.toContain('Saved characters');
  });
});
