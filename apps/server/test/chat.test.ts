import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestHarness } from './helpers/context';
import { FakeLlm } from '../src/director/llm';
import { generateFixtureClip, generatePlaceholderImage } from '../src/media/ffmpeg';
import { storeAsset } from '../src/services/assets';
import { chatAction, createChatSession, getChatSession, postChatMessage } from '../src/chat/chat';
import { htmlToText, linksIn, readWebPage } from '../src/chat/web';
import { buildDefaultTimeline } from '../src/editor/editor';
import { assets, characterReferences, characters, locations, projects, shots } from '../src/db/schema';
import { createMovie, estimateMovie, regenerateShot } from '../src/movie/movie';
import type { MoviePlan } from '../src/director/director';

const plan = (heroName: string): MoviePlan => ({
  title: 'The Gift',
  logline: 'A couple and a figurine.',
  genre: 'Drama',
  characters: [
    { key: 'c1', name: heroName, description: 'young woman', appearance: 'chestnut hair', clothing: 'mustard sweater', voiceStyle: 'warm', gender: 'female', referenceTokens: [] },
    { key: 'c2', name: 'Giorgi', description: 'young man', appearance: 'beard', clothing: 'blue cap', voiceStyle: 'calm', gender: 'male', referenceTokens: [] },
  ],
  locations: [{ key: 'l1', name: 'Studio', description: 'a small workshop', referenceTokens: [] }],
  scenes: [
    {
      title: 'Workshop',
      synopsis: 'They unwrap the gift.',
      locationKey: 'l1',
      shots: [
        { description: 'Close-up', prompt: 'Close-up of a figurine', durationSec: 6, shotType: 'close-up', camera: 'static', characterKeys: ['c1'], dialogue: [{ speakerKey: 'c1', line: 'ეს ჩვენ ვართ?' }], sfx: 'paper rustle', needsNativeAudio: true, referenceTokens: [] },
        { description: 'Wide', prompt: 'Wide shot of the workshop', durationSec: 9, shotType: 'wide', camera: 'orbit', characterKeys: ['c1', 'c2'], dialogue: [], sfx: '', needsNativeAudio: false, referenceTokens: [] },
      ],
    },
  ],
  music: { mood: 'warm', prompt: 'soft piano' },
});

describe('link reading (Ad Studio)', () => {
  it('extracts text and links, and refuses private addresses', async () => {
    expect(htmlToText('<html><head><title>PIJILO</title><script>x()</script></head><body><h1>3D figurines</h1><p>From your photo&nbsp;to a statue.</p></body></html>')).toBe('Title: PIJILO\n3D figurines\nFrom your photo to a statue.');
    expect(linksIn('see https://pijilo.ge/shop, and www.instagram.com/pijilo.')).toEqual(['https://pijilo.ge/shop', 'www.instagram.com/pijilo']);
    await expect(readWebPage('http://127.0.0.1:4000/api/admin')).rejects.toThrow(/public/);
    await expect(readWebPage('http://[::1]/')).rejects.toThrow(/public/);
    await expect(readWebPage('file:///etc/passwd')).rejects.toThrow(/http/);
  });
});

describe('chat mode (scripted AI Director)', () => {
  let h: TestHarness;
  // Scripted model: chat turns come from a queue; screenplay / revision / concepts answer by prompt.
  const turns: unknown[] = [];
  const llm = new FakeLlm(({ system, prompt }) => {
    if (system.startsWith('You are the AI Director of Framecraft') || system.startsWith("You are the creative director of Framecraft's Ad Studio")) return turns.shift();
    if (system.includes('You are revising an existing plan')) return plan(prompt.includes('older') ? 'Nino (60)' : 'Nino');
    if (system.startsWith('You are an award-winning')) {
      return {
        concepts: [0, 1, 2].map((i) => ({ title: `Idea ${i + 1}`, angle: 'a', hook: 'h', story: 'A couple unwraps a figurine of themselves.', voiceover: ['შენი ფოტო — ქანდაკებად.'], cta: 'შეუკვეთე PIJILO-ზე', musicMood: 'warm', lengthSec: 15 })),
      };
    }
    return plan('Nino');
  });

  beforeAll(async () => {
    h = await createTestContext({ llm });
  });
  afterAll(() => h.close());

  const image = async (userId: string, name: string) => {
    const f = path.join(os.tmpdir(), `fc-chat-${name}-${process.pid}.jpg`);
    await generatePlaceholderImage(f, { width: 512, height: 512, title: name });
    return (await storeAsset(h.ctx, { userId, kind: 'upload', mediaType: 'image', filePath: f, mimeType: 'image/jpeg' })).id;
  };

  it('movie: idea → screenplay → chat revision → approval → budget, all in the conversation', async () => {
    const u = await h.makeUser();
    const { session, messages } = await createChatSession(h.ctx, u, 'movie');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('assistant');

    const photo = await image(u.id, 'nino');
    turns.push({ reply: 'შესანიშნავი იდეაა — ვწერ სცენარს.', action: 'write_screenplay', brief: { idea: 'Nino (photo1) and Giorgi receive a 3D figurine of themselves', lengthSec: 15, language: 'ka' }, revision: '', suggestions: [] });
    await postChatMessage(h.ctx, u, session.id, { content: 'ნინო (photo1) და გიორგი იღებენ საკუთარ 3D ფიგურას საჩუქრად', attachments: [{ assetId: photo }] });
    // The reply is written in the queue (model calls can outlast an HTTP request); meanwhile the chat shows "thinking".
    let s = await getChatSession(h.ctx, u, session.id);
    expect(s.session.thinking).toBe(true);
    expect(s.messages.at(-1)!.role).toBe('user');
    await expect(postChatMessage(h.ctx, u, session.id, { content: 'და კიდევ' })).rejects.toMatchObject({ status: 409 });
    await h.drain();
    s = await getChatSession(h.ctx, u, session.id);
    expect(s.session.thinking).toBe(false);
    const card = s.messages.at(-1)!.card as { type: string; projectId: string };
    expect(card.type).toBe('screenplay');
    expect(s.session.projectId).toBe(card.projectId);
    expect(s.session.lang).toBe('ka');
    expect(s.session.references).toEqual([{ token: 'photo1', assetId: photo }]);
    await h.drain();
    const [project] = await h.ctx.db.select().from(projects).where(eq(projects.id, card.projectId));
    expect((project!.settings as { brief: { language: string; references: unknown[] } }).brief).toMatchObject({ language: 'ka', references: [{ token: 'photo1', assetId: photo }] });

    // A change asked in plain words revises the screenplay (the model sees the current plan).
    turns.push({ reply: 'კარგი, ნინოს უფრო ასაკოვანს გავხდი.', action: 'revise_screenplay', brief: {}, revision: 'Make Nino older', suggestions: [] });
    await postChatMessage(h.ctx, u, session.id, { content: 'ნინო უფრო ასაკოვანი იყოს' });
    await h.drain();
    expect(llm.calls.some((c) => c.prompt.includes('Current plan (JSON)') && c.prompt.includes('Make Nino older'))).toBe(true);
    const chars = await h.ctx.db.select().from(characters).where(eq(characters.projectId, card.projectId));
    expect(chars.map((c) => c.name).sort()).toEqual(['Giorgi', 'Nino (60)']); // replaced, not duplicated

    // Approval → budget card (generation itself needs the explicit Generate button).
    await chatAction(h.ctx, u, session.id, { type: 'approve_screenplay' });
    s = await getChatSession(h.ctx, u, session.id);
    expect(s.messages.at(-1)!.card).toMatchObject({ type: 'budget', projectId: card.projectId });
    await chatAction(h.ctx, u, session.id, { type: 'generation_started' });
    s = await getChatSession(h.ctx, u, session.id);
    expect(s.messages.at(-1)!.card).toMatchObject({ type: 'film', projectId: card.projectId });
  }, 120_000);

  it('ad: business brief + logo → three concepts → chosen ad with logo and call to action', async () => {
    const u = await h.makeUser();
    const { session } = await createChatSession(h.ctx, u, 'ad');
    const logo = await image(u.id, 'logo');
    turns.push({ reply: 'აი სამი იდეა.', action: 'propose_concepts', business: { name: 'PIJILO', about: '3D printed figurines from photos', platform: 'tiktok', lengthSec: 15, language: 'ka' }, conceptIndex: -1, revision: '', suggestions: [] });
    await postChatMessage(h.ctx, u, session.id, { content: 'PIJILO — ფოტოდან 3D ფიგურები, TikTok-ისთვის 15 წამი', attachments: [{ assetId: logo, kind: 'logo' }] });
    await h.drain();
    let s = await getChatSession(h.ctx, u, session.id);
    expect(s.session.business).toMatchObject({ name: 'PIJILO', platform: 'tiktok' });
    expect(s.session.logoAssetId).toBe(logo);
    const concepts = s.messages.at(-1)!.card as { type: string; concepts: { title: string }[] };
    expect(concepts.type).toBe('concepts');
    expect(concepts.concepts).toHaveLength(3);

    await chatAction(h.ctx, u, session.id, { type: 'choose_concept', index: 1 });
    s = await getChatSession(h.ctx, u, session.id);
    const card = s.messages.at(-1)!.card as { type: string; projectId: string };
    expect(card.type).toBe('screenplay');
    await h.drain();
    const [project] = await h.ctx.db.select().from(projects).where(eq(projects.id, card.projectId));
    expect(project!.kind).toBe('ad');
    expect(project!.aspectRatio).toBe('9:16');
    const brief = (project!.settings as { brief: { idea: string; lengthSec: number } }).brief;
    expect(brief.lengthSec).toBe(15);
    expect(brief.idea).toContain('შენი ფოტო — ქანდაკებად.');
    expect(brief.idea).toContain('Idea 2');

    // Assembled ad: brand logo in the corner, call to action over the last seconds.
    const clipFile = path.join(os.tmpdir(), `fc-chat-clip-${process.pid}.mp4`);
    await generateFixtureClip(clipFile, { width: 720, height: 1280, durationSec: 6, title: 'clip' });
    const clip = await storeAsset(h.ctx, { userId: u.id, projectId: card.projectId, kind: 'generated', mediaType: 'video', filePath: clipFile, mimeType: 'video/mp4' });
    await h.ctx.db.update(shots).set({ currentAssetId: clip.id }).where(eq(shots.projectId, card.projectId));
    const tl = await buildDefaultTimeline(h.ctx, card.projectId, '9:16');
    expect(tl.logo).toMatchObject({ assetId: logo, position: 'top-right' });
    expect(tl.texts.find((t) => t.id === 'auto-cta')).toMatchObject({ text: 'შეუკვეთე PIJILO-ზე', position: 'center' });
  }, 120_000);

  it('builds logo shots from the logo file itself (no AI model, no charge)', async () => {
    const u = await h.makeUser();
    const logo = await image(u.id, 'brand');
    const { projectId } = await createMovie(h.ctx, u, { idea: 'A brand film for PIJILO, ending on our logo', lengthSec: 15, quality: 'economy' }, 'logo-card-1');
    await h.drain();
    const [first] = await h.ctx.db.select().from(shots).where(eq(shots.projectId, projectId));
    await h.ctx.db.update(shots).set({ description: 'Logo end card', prompt: 'The PIJILO logo on a dark background', referenceAssetIds: [logo] }).where(eq(shots.id, first!.id));
    const est = await estimateMovie(h.ctx, u, projectId);
    const card = est.shots.find((s) => s.shotId === first!.id)!;
    expect(card).toMatchObject({ credits: 0, ok: true });
    expect(card.modelName).toMatch(/Logo end card/);
    const res = await regenerateShot(h.ctx, u, first!.id, 'logo-card-regen');
    expect(res.job).toBeNull();
    const [after] = await h.ctx.db.select().from(shots).where(eq(shots.id, first!.id));
    expect(after!.status).toBe('ready');
    const [clip] = await h.ctx.db.select().from(assets).where(eq(assets.id, after!.currentAssetId!));
    expect(clip).toMatchObject({ mediaType: 'video', hasAudio: true });
    expect(clip!.source).toMatchObject({ logoCard: true, aiGenerated: false, fromAssetId: logo });
  }, 120_000);

  it('@mentions bring saved characters and locations into the conversation (their photos become references)', async () => {
    const u = await h.makeUser();
    const face = await image(u.id, 'nino-face');
    const [nino] = await h.ctx.db.insert(characters).values({ userId: u.id, name: 'Nino', description: 'young woman, chestnut hair' }).returning();
    await h.ctx.db.insert(characterReferences).values({ characterId: nino!.id, assetId: face, isPrimary: true });
    const [yard] = await h.ctx.db.insert(locations).values({ userId: u.id, name: 'Old Tbilisi yard', description: 'wooden balconies at dusk' }).returning();
    const { session } = await createChatSession(h.ctx, u, 'movie');
    turns.push({ reply: 'ვწერ სცენარს.', action: 'write_screenplay', brief: { idea: 'Nino (photo1) in an old Tbilisi yard', lengthSec: 15, language: 'ka' }, revision: '', suggestions: [] });
    await postChatMessage(h.ctx, u, session.id, { content: '@Nino ცეკვავს @Old Tbilisi yard-ში', mentions: [{ kind: 'character', id: nino!.id }, { kind: 'location', id: yard!.id }] });
    const s = await getChatSession(h.ctx, u, session.id);
    const sent = s.messages.find((m) => m.role === 'user')!;
    expect(sent.content).toBe('Nino (photo1) ცეკვავს Old Tbilisi yard (saved location: wooden balconies at dusk)-ში');
    expect(s.session.references).toEqual([{ token: 'photo1', assetId: face, note: 'saved character Nino: young woman, chestnut hair' }]);
    // Someone else's character cannot be mentioned.
    const other = await h.makeUser();
    await h.drain();
    const { session: s2 } = await createChatSession(h.ctx, other, 'movie');
    await expect(postChatMessage(h.ctx, other, s2.id, { content: '@Nino', mentions: [{ kind: 'character', id: nino!.id }] })).rejects.toMatchObject({ status: 404 });
  });

  it("does not open another user's conversation", async () => {
    const a = await h.makeUser();
    const b = await h.makeUser();
    const { session } = await createChatSession(h.ctx, a, 'movie');
    await expect(getChatSession(h.ctx, b, session.id)).rejects.toMatchObject({ status: 404 });
  });
});
