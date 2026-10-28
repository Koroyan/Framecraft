import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { cartoonBriefSchema } from '@framecraft/shared';
import { createTestContext, type TestHarness } from './helpers/context';
import { FakeLlm } from '../src/director/llm';
import { generatePlaceholderImage } from '../src/media/ffmpeg';
import { storeAsset } from '../src/services/assets';
import { characterReferences, characters, generationJobs, projects, shots } from '../src/db/schema';
import { brandKits } from '../src/db/schema-ads';
import { createCartoon } from '../src/movie/cartoon';

/*
 * Create a Cartoon: an original style, the user's saved characters cast as themselves (no duplicate
 * with a new look), brand films limited to approved facts, and protected characters refused.
 * The screenplay model is fake; nothing paid runs.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cartoon-'));
let lastPrompt = '';
const llm = new FakeLlm(({ system, prompt }) => {
  if (!system.startsWith('You are a film director planning')) return { reply: '', operations: [] };
  lastPrompt = prompt;
  return {
    title: 'Bolt the Chef',
    logline: 'A small robot learns to cook.',
    genre: 'animated cartoon',
    characters: [
      { key: 'c1', name: 'Bolt', description: 'the robot', appearance: 'blue', clothing: 'chef hat', voiceStyle: 'bright', gender: 'unknown', referenceTokens: ['photo1'] },
      { key: 'c2', name: 'Chef Mira', description: 'a kind chef', appearance: 'curly hair', clothing: 'apron', voiceStyle: 'warm', gender: 'female', referenceTokens: [] },
    ],
    locations: [{ key: 'l1', name: 'Kitchen', description: 'tiny bright kitchen', referenceTokens: [] }],
    scenes: [
      { title: 'First try', synopsis: 'Bolt burns the soup.', locationKey: 'l1', shots: [
        { description: 'Bolt stirs', prompt: 'Bolt stirs a pot', durationSec: 6, shotType: 'medium', camera: 'dolly_in', characterKeys: ['c1'], dialogue: [{ speakerKey: 'c1', line: 'Soup time!' }], sfx: '', needsNativeAudio: false, referenceTokens: [] },
        { description: 'Mira laughs', prompt: 'Mira laughs', durationSec: 6, shotType: 'close-up', camera: 'static', characterKeys: ['c2', 'c1'], dialogue: [], sfx: '', needsNativeAudio: false, referenceTokens: [] },
      ] },
    ],
    music: { mood: 'playful', prompt: 'playful pizzicato' },
  };
});

let h: TestHarness;
let user: { id: string; role: 'user' | 'admin' };
let boltId = '';
let refId = '';

beforeAll(async () => {
  h = await createTestContext({ llm });
  const u = await h.makeUser(undefined, 'user', 1000);
  user = { id: u.id, role: 'user' };
  const img = path.join(dir, 'bolt.jpg');
  await generatePlaceholderImage(img, { width: 256, height: 256, title: 'Bolt' });
  const a = await storeAsset(h.ctx, { userId: u.id, kind: 'upload', mediaType: 'image', filePath: img, mimeType: 'image/jpeg' });
  refId = a.id;
  const [bolt] = await h.ctx.db.insert(characters).values({ userId: u.id, name: 'Bolt', description: 'A small blue robot with round eyes', clothing: 'a white chef hat' }).returning();
  boltId = bolt!.id;
  await h.ctx.db.insert(characterReferences).values({ characterId: boltId, assetId: a.id, isPrimary: true, label: 'Approved front view' });
}, 60_000);
afterAll(() => h.close());

describe('Create a Cartoon', () => {
  it('refuses protected characters and explains why', async () => {
    await expect(createCartoon(h.ctx, user, cartoonBriefSchema.parse({ idea: 'Pikachu learns to bake a cake', style: 'cartoon_3d' }), 'cartoon-key-0')).rejects.toThrow(/original characters/);
  });

  it('casts a saved character as itself, with its approved reference, in the chosen original style', async () => {
    const r = await createCartoon(h.ctx, user, cartoonBriefSchema.parse({ idea: 'A small robot wants to become a chef', style: 'cartoon_clay', lengthSec: 30, audience: 'kids', characterIds: [boltId] }), 'cartoon-key-1');
    const [project] = await h.ctx.db.select().from(projects).where(eq(projects.id, r.projectId));
    const settings = project!.settings as { brief: { style: string; idea: string; references: { token: string; assetId: string }[]; genre: string }; cartoon: { audience: string } };
    expect(settings.brief.style).toBe('cartoon_clay');
    expect(settings.brief.genre).toBe('animated cartoon');
    expect(settings.cartoon.audience).toBe('kids');
    expect(settings.brief.references).toEqual([{ token: 'photo1', assetId: refId, note: 'Bolt (character)' }]);
    expect(settings.brief.idea).toContain('clay stop-motion animation');
    expect(settings.brief.idea).toContain('Bolt — A small blue robot with round eyes; wearing a white chef hat');
    expect(settings.brief.idea).toContain('no existing or trademarked characters');

    await h.drain();
    const [job] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, r.planJobId));
    expect(job!.status).toBe('completed');
    expect(lastPrompt).toContain('Visual style: cartoon_clay');
    // Bolt is the saved character (no second "Bolt" with a new look); Chef Mira is new to this film.
    const named = await h.ctx.db.select().from(characters).where(eq(characters.userId, user.id));
    expect(named.filter((c) => c.name === 'Bolt')).toHaveLength(1);
    const mira = named.find((c) => c.name === 'Chef Mira')!;
    const filmShots = await h.ctx.db.select().from(shots).where(eq(shots.projectId, r.projectId));
    expect(filmShots.find((s) => s.description === 'Bolt stirs')!.characterIds).toEqual([boltId]);
    expect(filmShots.find((s) => s.description === 'Mira laughs')!.characterIds).toEqual([mira.id, boltId]);
  });

  it('a brand film uses only approved facts, the product photos and the logo', async () => {
    const [brand] = await h.ctx.db
      .insert(brandKits)
      .values({
        userId: user.id,
        name: 'Sunny Bakery',
        logoAssetId: refId,
        industry: 'bakery',
        ctas: ['Order on sunnybakery.ge'],
        knowledge: { facts: [{ id: 'f1', text: 'Cakes are baked every morning', kind: 'about', sourceUrl: null, confidence: 1, status: 'approved' }, { id: 'f2', text: 'Best bakery in the world', kind: 'claim', sourceUrl: null, confidence: 0.4, status: 'pending' }], sources: [] },
      })
      .returning();
    const r = await createCartoon(h.ctx, user, cartoonBriefSchema.parse({ idea: 'Our cake mascot shows how cakes are made', style: 'cartoon_mascot', lengthSec: 30, audience: 'customers', brandId: brand!.id }), 'cartoon-key-2');
    const [project] = await h.ctx.db.select().from(projects).where(eq(projects.id, r.projectId));
    const brief = (project!.settings as { brief: { idea: string; references: { note?: string }[] } }).brief;
    expect(brief.idea).toContain('Cakes are baked every morning');
    expect(brief.idea).not.toContain('Best bakery in the world');
    expect(brief.idea).toContain('End with this invitation: “Order on sunnybakery.ge”');
    expect(brief.references.map((x) => x.note)).toEqual(['Sunny Bakery logo']);
  });
});
