import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { movieBriefSchema, photoTokensIn } from '@framecraft/shared';
import { classifyReferences, Director } from '../src/director/director';
import { FakeLlm } from '../src/director/llm';
import { createTestContext, type TestHarness } from './helpers/context';
import { generatePlaceholderImage } from '../src/media/ffmpeg';
import { storeAsset } from '../src/services/assets';
import { createMovie, estimateMovie, getMovie } from '../src/movie/movie';
import { characterReferences, characters, locationReferences, locations } from '../src/db/schema';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('photo references (photo1, photo2…)', () => {
  it('finds tokens in text', () => {
    expect(photoTokensIn('My hero (photo1) meets PHOTO3 near photo1')).toEqual(['photo1', 'photo3']);
  });

  it('classifies characters, locations and objects in English, Georgian and Russian', () => {
    const refs = classifyReferences({
      idea: 'A detective photo1 investigates a city. She lives in a house like photo2. She always carries the bottle from photo3.',
      references: [
        { token: 'photo1', assetId: A },
        { token: 'photo2', assetId: B },
        { token: 'photo3', assetId: C },
      ],
    });
    expect(refs.map((r) => r.kind)).toEqual(['character', 'location', 'object']);
    const ka = classifyReferences({ idea: 'გმირი photo1 ცხოვრობს სახლში photo2.', references: [{ token: 'photo1', assetId: A }, { token: 'photo2', assetId: B }] });
    expect(ka.map((r) => r.kind)).toEqual(['character', 'location']);
    const ru = classifyReferences({ idea: 'Девушка photo1 гуляет. Её дом как на photo2.', references: [{ token: 'photo1', assetId: A }, { token: 'photo2', assetId: B }] });
    expect(ru.map((r) => r.kind)).toEqual(['character', 'location']);
    // The user's note wins over the surrounding words.
    expect(classifyReferences({ idea: 'He walks into photo1', references: [{ token: 'photo1', assetId: A, note: 'our café interior' }] })[0]!.kind).toBe('location');
  });

  it('offline plan maps tokens and never leaks them into video prompts', async () => {
    const plan = await new Director(new FakeLlm(() => ({})) as never).screenplay(
      movieBriefSchema.parse({ idea: 'A detective photo1 searches a ruined city like photo2 for the stolen watch photo3.', lengthSec: 30, references: [{ token: 'photo1', assetId: A, note: 'Nino' }, { token: 'photo2', assetId: B }, { token: 'photo3', assetId: C }] }),
    );
    // FakeLlm returns {} which fails validation, so the offline planner answers.
    expect(plan.source).toBe('offline');
    expect(plan.characters[0]!.referenceTokens).toEqual(['photo1']);
    expect(plan.characters[0]!.name).toBe('Nino');
    expect(plan.locations[0]!.referenceTokens).toEqual(['photo2']);
    const shots = plan.scenes.flatMap((s) => s.shots);
    expect(shots.every((s) => s.referenceTokens.includes('photo3'))).toBe(true);
    expect(shots.some((s) => /photo\d/i.test(s.prompt))).toBe(false);
  });

  it('passes the photos to the AI Director when an LLM is configured', async () => {
    const llm = new FakeLlm(() => ({
      title: 'T',
      logline: 'L',
      genre: 'Drama',
      characters: [{ key: 'c1', name: 'Nino', description: 'd', appearance: 'looks like photo1', clothing: 'red coat', voiceStyle: 'calm', referenceTokens: ['photo1', 'photo9'] }],
      locations: [{ key: 'l1', name: 'Old town', description: 'd', referenceTokens: [] }],
      scenes: [{ title: 'S', synopsis: 's', locationKey: 'l1', shots: [{ description: 'x', prompt: 'Nino (photo1) walks', durationSec: 5, shotType: 'Wide', camera: 'tracking', characterKeys: ['c1'], dialogue: [], sfx: '', needsNativeAudio: false, referenceTokens: [] }] }],
      music: { mood: 'm', prompt: 'p' },
    }));
    const plan = await new Director(llm).screenplay(movieBriefSchema.parse({ idea: 'A woman photo1 explores the old town', lengthSec: 15, references: [{ token: 'photo1', assetId: A }] }), [{ label: 'photo1:', mediaType: 'image/jpeg', data: 'AAAA' }]);
    expect(plan.source).toBe('llm');
    expect(llm.calls[0]!.images).toBe(1);
    expect(llm.calls[0]!.prompt).toContain('Reference photos supplied by the user');
    // Unknown tokens are dropped; tokens never reach the video prompt.
    expect(plan.characters[0]!.referenceTokens).toEqual(['photo1']);
    expect(plan.scenes[0]!.shots[0]!.prompt).toBe('Nino (Nino) walks');
  });
});

describe('movie maker with user photos (integration)', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createTestContext();
  });
  afterAll(() => h.close());

  it('attaches photos to characters/locations and uses them as generation references', async () => {
    const u = await h.makeUser();
    const ids: string[] = [];
    for (const name of ['hero', 'house']) {
      const f = path.join(os.tmpdir(), `fc-ref-${name}-${process.pid}.jpg`);
      await generatePlaceholderImage(f, { width: 512, height: 512, title: name });
      ids.push((await storeAsset(h.ctx, { userId: u.id, kind: 'reference', mediaType: 'image', filePath: f, mimeType: 'image/jpeg' })).id);
    }
    const { projectId } = await createMovie(
      h.ctx,
      u,
      { idea: 'A young painter photo1 returns to her childhood home like photo2 and finds a hidden letter.', lengthSec: 30, quality: 'balanced', references: [{ token: 'photo1', assetId: ids[0] }, { token: 'photo2', assetId: ids[1] }] },
      'movie-refs-1',
    );
    await h.drain();
    const m = await getMovie(h.ctx, u, projectId);
    expect(m.planJob?.status).toBe('completed');
    const chars = await h.ctx.db.select().from(characters).where(eq(characters.projectId, projectId));
    const cRefs = await h.ctx.db.select().from(characterReferences).where(inArray(characterReferences.characterId, chars.map((c) => c.id)));
    expect(cRefs.map((r) => r.assetId)).toEqual([ids[0]]);
    const locs = await h.ctx.db.select().from(locations).where(eq(locations.projectId, projectId));
    const lRefs = await h.ctx.db.select().from(locationReferences).where(inArray(locationReferences.locationId, locs.map((l) => l.id)));
    expect(lRefs.map((r) => r.assetId)).toEqual([ids[1]]);
    expect(m.characters[0]!.referenceAssetIds).toEqual([ids[0]]);

    // Shots now need reference-capable models (character + location photos).
    const est = await estimateMovie(h.ctx, u, projectId);
    expect(est.ok).toBe(true);
    expect(est.modelMix.every((x) => /Omni|Kling O3|Seedance 2\.5|Grok/.test(x.model))).toBe(true);
  });

  it("rejects another user's photo", async () => {
    const owner = await h.makeUser();
    const f = path.join(os.tmpdir(), `fc-ref-other-${process.pid}.jpg`);
    await generatePlaceholderImage(f, { width: 256, height: 256, title: 'x' });
    const a = await storeAsset(h.ctx, { userId: owner.id, kind: 'reference', mediaType: 'image', filePath: f, mimeType: 'image/jpeg' });
    const thief = await h.makeUser();
    await expect(createMovie(h.ctx, thief, { idea: 'A story about photo1 in the mountains', lengthSec: 30, references: [{ token: 'photo1', assetId: a.id }] }, 'movie-refs-2')).rejects.toMatchObject({ status: 404 });
  });
});
