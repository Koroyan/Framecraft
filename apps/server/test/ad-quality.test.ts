import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { AD_MODES, adMode, endCardSeconds, reviewPlanDiversity, timelineSchema } from '@framecraft/shared';
import { createTestContext, type TestHarness } from './helpers/context';
import { createMockFetch } from './helpers/mock-fetch';
import { FakeLlm } from '../src/director/llm';
import { ffmpeg } from '../src/media/ffmpeg';
import { storeAsset } from '../src/services/assets';
import { judgeRender, approveIdentity, latestQuality, type IdentityResult, type QualityIssue } from '../src/ads/quality';
import { applySceneRevision, proposeSceneRevision } from '../src/ads/revise';
import { buildDefaultTimeline, createRenderJob, saveTimeline } from '../src/editor/editor';
import { projects, qualityReports, scenes, shots } from '../src/db/schema';

/*
 * The ad production engine's judgement: honest predicted scores, Creative Director modes, the
 * verified post-render quality check (measured from the real rendered file, product identity
 * against the original images — the vision model is scripted here), and revisions that touch
 * only the affected shots. Real FFmpeg; providers mocked — no paid calls.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-adq-'));
const f = (n: string) => path.join(dir, n);
beforeAll(async () => {
  for (const [i, c] of ['0xB04020', '0x2050B0', '0x30A050'].entries()) await ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=720x1280:d=4:r=25`, '-f', 'lavfi', '-i', `color=c=${c}:s=720x1280:d=4:r=25`, '-filter_complex', '[0:v][1:v]blend=all_mode=overlay:all_opacity=0.6,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', f(`shot${i + 1}.mp4`)]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xF0C020:s=600x600', '-frames:v', '1', f('figurine.png')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x7C3AED:s=400x200', '-frames:v', '1', f('logo.png')]);
}, 120_000);

describe('predicted plan scores are honest', () => {
  const seg = (id: string, assetId: string) => ({ id, assetId, startSec: 0, endSec: 5, duplicateOf: null, metrics: { motion: 0.2 }, scores: { product: 0.9 } });
  const S = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const scene = (i: number, segmentId: string, extra: Record<string, unknown> = {}) => ({ id: `sc${i}`, segmentId, inSec: 0, durationSec: 3, role: i === 0 ? 'hook' : 'reveal', purpose: '', overlay: null, transition: 'cut', enhance: null, framing: null, camera: null, lighting: '', sound: '', crop: null, ...extra }) as never;

  it('one take re-used as crops is never 100/100, and a plan that never says what the product is gets flagged', () => {
    const r = reviewPlanDiversity({ scenes: [scene(0, S[0]!), scene(1, S[0]!, { crop: { x: 0.4, y: 0.4, scale: 1.7 } }), scene(2, S[0]!, { crop: { x: 0.6, y: 0.5, scale: 1.4 } })], cta: 'Order' }, [seg(S[0]!, 'a')], 9);
    expect(r.kind).toBe('predicted');
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['reused_footage', 'single_take', 'missing_message']));
    expect(r.score).toBeLessThan(80);
    const good = reviewPlanDiversity({ scenes: [scene(0, S[0]!), scene(1, S[1]!)], cta: 'Order', messaging: { what: { text: 'A 3D figurine from your photo', scene: 0 }, why: { text: 'A gift that lasts', scene: 1 }, unique: { text: 'Painted by hand', scene: 1 }, cta: { text: 'Order', scene: -1 } } }, [seg(S[0]!, 'a'), seg(S[1]!, 'b')], 6);
    expect(good.score).toBeLessThanOrEqual(95); // a plan is a prediction, not a verified result
    expect(good.issues.some((i) => i.code === 'missing_message')).toBe(false);
  });

  it('six Creative Director modes with genuinely different strategies', () => {
    expect(AD_MODES.map((m) => m.key)).toEqual(['product_showcase', 'emotional_story', 'product_demo', 'luxury_commercial', 'social_sales', 'behind_the_scenes']);
    expect(new Set(AD_MODES.map((m) => m.style)).size).toBe(6);
    expect(new Set(AD_MODES.map((m) => `${m.editing.pacing}:${m.editing.shotSec.join('-')}:${m.editing.transitions.join('/')}`)).size).toBe(6);
    expect(adMode('social_sales').editing.transitions).toEqual(['cut']);
    // The brand ending scales with the ad: 15 s → under 2 s, 60 s → capped at 3 s.
    expect(endCardSeconds(15, 0.12)).toBe(1.8);
    expect(endCardSeconds(60, 0.12)).toBe(3);
  });
});

describe('post-render judgement (measured facts)', () => {
  const m = { durationSec: 15, width: 1080, height: 1920, shots: [{ startSec: 0, endSec: 4 }, { startSec: 4, endSec: 8 }, { startSec: 8, endSec: 11 }, { startSec: 11, endSec: 15 }], duplicateShots: [[0, 2]] as [number, number][], black: [], frozen: [], jumps: [9.5], audio: { meanDb: -20, maxDb: -2, silent: [] } };
  const tl = timelineSchema.parse({
    aspectRatio: '9:16',
    clips: [],
    layers: [
      { id: 'logo', name: 'logo', kind: 'image', track: 3, assetId: '00000000-0000-4000-8000-000000000009', startSec: 0, endSec: 15, x: 0.86, y: 0.08, w: 0.15 },
      { id: 'fast', name: 'caption', kind: 'text', track: 2, startSec: 2, endSec: 2.6, x: 0.5, y: 0.74, w: 0.8, text: { content: 'Hand-painted personalised figurines made from one photo' } },
    ],
  });
  it('flags a watermark, a long brand ending, an unreadable caption, repeated shots and a missing CTA', () => {
    const issues = judgeRender(m, tl, { modeKey: 'luxury_commercial', cta: 'Order at PIJILO', logoCard: { startSec: 11, endSec: 15 } });
    const text = issues.map((i) => i.message).join('\n');
    expect(text).toMatch(/watermark/);
    expect(text).toMatch(/brand ending lasts 4\.0 s/);
    expect(text).toMatch(/too briefly to read/);
    expect(text).toMatch(/Shots 1 and 3 look almost the same/);
    expect(text).toMatch(/call to action is not shown/);
    expect(text).toMatch(/1 abrupt jump/);
  });
});

describe('verified quality check and targeted revisions on a real render', () => {
  let h: TestHarness;
  const mock = createMockFetch();
  const llm = new FakeLlm(({ system }) => {
    if (system.startsWith('You are a strict product-fidelity reviewer')) {
      return {
        shots: [
          { frame: 1, productVisible: true, face: 'same', proportions: 'same', accessories: 'same', clothing: 'same', surfaceDetails: 'same', geometry: 'same', artefacts: [], changes: [] },
          { frame: 2, productVisible: true, face: 'same', proportions: 'same', accessories: 'changed', clothing: 'changed', surfaceDetails: 'same', geometry: 'same', artefacts: [], changes: ['The syringe is missing', 'The coat is now blue'] },
          { frame: 3, productVisible: true, face: 'same', proportions: 'same', accessories: 'same', clothing: 'same', surfaceDetails: 'same', geometry: 'same', artefacts: [], changes: [] },
        ],
      };
    }
    throw new Error('offline');
  });
  beforeAll(async () => {
    h = await createTestContext({ llm, fetch: mock.fetch, env: { LIVE_GENERATION_ENABLED: 'true', RUNWAYML_API_SECRET: 'rw_test_key', DEV_FIXTURES_ENABLED: 'false' } });
  });
  afterAll(() => h.close());

  it('renders → measures the file → compares each shot with the product photo → flags shot 2 → approval clears it; revisions touch only what is asked', async () => {
    const u = await h.makeUser(undefined, 'user', 10_000);
    const ref = await storeAsset(h.ctx, { userId: u.id, kind: 'reference', mediaType: 'image', filePath: f('figurine.png'), mimeType: 'image/png' });
    const logo = await storeAsset(h.ctx, { userId: u.id, kind: 'upload', mediaType: 'image', filePath: f('logo.png'), mimeType: 'image/png' });
    const [p] = await h.ctx.db
      .insert(projects)
      .values({ userId: u.id, kind: 'ad', title: 'Figurine ad', aspectRatio: '9:16', settings: { brief: { idea: 'A luxury commercial for a hand-painted figurine', lengthSec: 15, aspectRatio: '9:16', references: [{ token: 'photo1', assetId: ref.id, note: 'the product' }, { token: 'photo2', assetId: logo.id, note: 'brand logo' }] }, ad: { cta: 'შეუკვეთე PIJILO-ზე', logoAssetId: logo.id, website: 'https://pijilo.ge/', mode: 'luxury_commercial', references: [ref.id], messages: [{ text: 'შენი ფოტოდან — 3D ფიგურა', shot: 1 }] } } })
      .returning();
    const [scene] = await h.ctx.db.insert(scenes).values({ projectId: p!.id, index: 0, title: 'Ad' }).returning();
    for (let i = 0; i < 3; i++) {
      const clip = await storeAsset(h.ctx, { userId: u.id, projectId: p!.id, kind: 'generated', mediaType: 'video', filePath: f(`shot${i + 1}.mp4`), mimeType: 'video/mp4', source: { aiGenerated: true } });
      await h.ctx.db.insert(shots).values({ projectId: p!.id, sceneId: scene!.id, index: i, description: ['Macro hook', 'Turntable orbit', 'Hero shot'][i]!, prompt: ['Extreme macro on the face', 'Smooth 360° orbit', 'Low-angle hero shot'][i]!, durationSec: 4, status: 'ready', currentAssetId: clip.id, referenceAssetIds: [ref.id] });
    }
    // The brand ending: a logo shot, built locally from the logo file.
    const [card] = await h.ctx.db.insert(shots).values({ projectId: p!.id, sceneId: scene!.id, index: 3, description: 'Logo end card', prompt: 'Logo end card', durationSec: 4, status: 'draft', referenceAssetIds: [logo.id] }).returning();
    const { regenerateShot } = await import('../src/movie/movie');
    await regenerateShot(h.ctx, u, card!.id, 'logo-card-1');

    const tl = await buildDefaultTimeline(h.ctx, p!.id, '9:16');
    expect(tl.logo).toBeUndefined(); // no permanent watermark
    expect(tl.clips.slice(0, -1).some((c) => c.transition?.type === 'dissolve')).toBe(true); // luxury: dissolves
    expect(tl.layers.find((l) => l.id === 'msg-0')?.text?.content).toBe('შენი ფოტოდან — 3D ფიგურა');
    expect(tl.layers.find((l) => l.id === 'auto-site')?.text?.content).toBe('pijilo.ge');
    await saveTimeline(h.ctx, u, p!.id, tl, { label: 'test' });
    await createRenderJob(h.ctx, u, p!.id, { timeline: tl, preset: 'master', idempotencyKey: 'qc-render-1' });
    await h.drain(200);

    // The render triggered the verified check automatically.
    const report = (await latestQuality(h.ctx, p!.id))!;
    expect(report).toBeTruthy();
    expect(report.identitySource).toBe('vision');
    const m = report.measurements as { durationSec: number; width: number; height: number };
    expect(m).toMatchObject({ width: 1080, height: 1920 });
    const identity = report.identity as unknown as IdentityResult[];
    expect(identity).toHaveLength(3); // the logo card is not a product shot
    expect(identity[1]).toMatchObject({ verdict: 'changed', method: 'vision' });
    expect(identity[1]!.changes).toContain('The syringe is missing');
    const issues = report.issues as unknown as QualityIssue[];
    expect(issues.find((i) => i.area === 'identity')).toMatchObject({ severity: 'error', shot: 1 });
    expect(issues.some((i) => /watermark/.test(i.message))).toBe(false);
    expect(report.status).toBe('needs_review');
    // The brand ending is 4 s of a ~15 s ad: flagged as too long.
    expect(issues.some((i) => /brand ending lasts/.test(i.message))).toBe(true);

    // The user looks at shot 2 and accepts it as it is.
    const approved = await approveIdentity(h.ctx, p!.id, report.id, 1);
    expect((approved.issues as unknown as QualityIssue[]).some((i) => i.area === 'identity')).toBe(false);
    expect((approved.identity as unknown as IdentityResult[])[1]!.approved).toBe(true);

    // "Shorten the logo ending": free, local, only the card changes; the film re-renders.
    const before = await h.ctx.db.select().from(shots).where(eq(shots.projectId, p!.id));
    const short = await proposeSceneRevision(h.ctx, u, p!.id, { preset: 'shorten_ending' });
    expect(short).toMatchObject({ free: true, totalCredits: 0 });
    const applied = await applySceneRevision(h.ctx, u, p!.id, { preset: 'shorten_ending' }, 0);
    expect(applied.renderJobId).toBeTruthy();
    const after = await h.ctx.db.select().from(shots).where(eq(shots.projectId, p!.id));
    for (const s of after.filter((x) => x.id !== card!.id)) expect(s.currentAssetId).toBe(before.find((b) => b.id === s.id)!.currentAssetId);
    expect(after.find((x) => x.id === card!.id)!.durationSec).toBe(3);

    // "Improve the hook": only shot 1 gets a new prompt and a price; nothing runs without approval.
    const hook = await proposeSceneRevision(h.ctx, u, p!.id, { preset: 'improve_hook' });
    expect(hook.shots).toHaveLength(1);
    expect(hook.shots[0]!.index).toBe(0);
    expect(hook.shots[0]!.newPrompt).toMatch(/\[Revision: Make the first second striking/);
    expect(hook.totalCredits).toBeGreaterThan(0);
    await expect(applySceneRevision(h.ctx, u, p!.id, { preset: 'improve_hook' }, hook.totalCredits - 1)).rejects.toMatchObject({ status: 402 });
    const rows = await h.ctx.db.select().from(qualityReports).where(eq(qualityReports.projectId, p!.id));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  }, 600_000);
});
