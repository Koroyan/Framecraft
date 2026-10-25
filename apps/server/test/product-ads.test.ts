import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createTestContext, type TestHarness } from './helpers/context';
import { createMockFetch } from './helpers/mock-fetch';
import { FakeLlm } from '../src/director/llm';
import { ffmpeg, probe } from '../src/media/ffmpeg';
import { downloadAssetToTemp, storeAsset, type Asset } from '../src/services/assets';
import { adCampaigns, assets, editOperations, footageSegments, generationJobs, shots } from '../src/db/schema';
import { createCampaign, createVariant, estimateCampaign, getCampaign, runEnhancements, saveBrandKit, startAssembly } from '../src/ads/campaigns';
import { getTimeline } from '../src/editor/editor';
import { activateShotVersion, projectShots } from '../src/editing/versions';
import { rejectAiEdit } from '../src/editing/ai-edit';
import { adBriefSchema, adPlanSchema } from '@framecraft/shared';

/*
 * Product video → ad, end to end with real FFmpeg (scene detection, metrics, assembly, render).
 * The AI Director is a scripted model; ElevenLabs and Runway are mocked HTTP — no paid calls.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ads-'));
const f = (n: string) => path.join(dir, n);
let mp3: Buffer;
let edited: Buffer;

beforeAll(async () => {
  // Four "raw" product videos (figurine studio): printing, painting (with a cut), packaging, finished piece.
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=4:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('printing.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xC06030:s=1280x720:d=2:r=25', '-f', 'lavfi', '-i', 'color=c=0x3060C0:s=1280x720:d=2:r=25', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('painting.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'mandelbrot=s=1280x720:r=25', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('packaging.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=1280x720:d=3:r=25', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('finished.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xFFD000:s=400x200', '-frames:v', '1', f('logo.png')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', f('voice.mp3')]);
  mp3 = fs.readFileSync(f('voice.mp3'));
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xFF00FF:s=640x360:d=6:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('edited.mp4')]);
  edited = fs.readFileSync(f('edited.mp4'));
}, 120_000);

describe('product video → ad', () => {
  let h: TestHarness;
  const mock = createMockFetch();
  const llm = new FakeLlm(({ system, prompt }) => {
    if (system.startsWith('You are a commercial video editor reviewing')) {
      const n = Number(prompt.match(/^(\d+) frames/)?.[1] ?? 0);
      return { segments: Array.from({ length: n }, (_, i) => ({ index: i + 1, description: `Footage frame ${i + 1}: figurine work`, product: 0.6 + (i % 3) * 0.1, closeup: i % 2 ? 0.8 : 0.3, demonstration: 0.5, appeal: 0.7, emotion: 0.2, tags: ['figurine'], text_in_frame: '' })) };
    }
    if (system.startsWith('You are an award-winning commercial director')) {
      const ids = [...prompt.matchAll(/^(S\d+):/gm)].map((m) => m[1]!);
      return {
        title: 'PIJILO — ხელით შექმნილი',
        audience: 'gift buyers',
        objective: 'orders',
        hook: 'painting close-up',
        narrative: 'from printing to the finished figurine',
        benefits: ['handmade'],
        scenes: ids.slice(0, 4).map((s, i) => ({ segment: s, offsetSec: 0, durationSec: 2, role: i === 0 ? 'hook' : i === 3 ? 'reveal' : 'story', purpose: 'show the craft', overlayText: i === 0 ? 'ხელით შექმნილი' : i === 3 ? 'შეუკვეთე ახლა' : '', overlayKind: i === 0 ? 'title' : i === 3 ? 'cta' : 'none', transition: i === 1 ? 'dissolve' : 'cut', enhanceMode: i === 2 ? 'relight' : 'none', enhanceInstruction: i === 2 ? 'Warmer, softer studio light on the background' : '' })),
        voiceover: [{ text: 'ყოველი ფიგურა ხელით იქმნება.', sceneIndex: 0 }, { text: 'შეუკვეთე შენი PIJILO.', sceneIndex: 3 }],
        musicMood: 'warm cinematic',
        cta: 'შეუკვეთე ახლა',
        notes: [],
      };
    }
    if (system.startsWith('Translate advertising copy')) {
      const j = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { overlays: string[]; voiceover: string[]; cta: string };
      return { overlays: j.overlays.map((o) => (o ? `EN ${o}` : '')), voiceover: j.voiceover.map((v) => `EN ${v}`), cta: 'Order now' };
    }
    throw new Error(`unexpected prompt: ${system.slice(0, 60)}`);
  });

  beforeAll(async () => {
    const RW = 'https://api.dev.runwayml.com/v1';
    mock
      .on('POST', 'https://api.elevenlabs.io/v1/music', () => ({ bytes: mp3 }))
      .on('POST', 'https://api.elevenlabs.io/v1/text-to-speech/', (call) => {
        const chars = [...(call.body as { text: string }).text];
        return { json: { audio_base64: mp3.toString('base64'), alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.04), character_end_times_seconds: chars.map((_, i) => 0.04 + i * 0.04) } } };
      })
      .on('POST', `${RW}/video_to_video`, () => ({ json: { id: 'enh-1' } }))
      .on('GET', new RegExp(`${RW}/tasks/`), () => ({ json: { id: 'enh-1', status: 'SUCCEEDED', output: ['https://cdn.runway.test/enh.mp4'] } }))
      .on('GET', 'https://cdn.runway.test/enh.mp4', () => ({ bytes: edited }));
    h = await createTestContext({ llm, env: { LIVE_GENERATION_ENABLED: 'true', ELEVENLABS_API_KEY: 'el_test_key', RUNWAYML_API_SECRET: 'rw_test_key', DEV_FIXTURES_ENABLED: 'false' }, fetch: mock.fetch });
  });
  afterAll(() => h.close());

  async function setup(mode: 'original' | 'enhanced') {
    const u = await h.makeUser(undefined, 'user', 50_000);
    const up = async (name: string, mime: string, media: 'video' | 'image') => storeAsset(h.ctx, { userId: u.id, kind: 'upload', mediaType: media, filePath: f(name), mimeType: mime, originalName: name });
    const footage = [await up('printing.mp4', 'video/mp4', 'video'), await up('painting.mp4', 'video/mp4', 'video'), await up('packaging.mp4', 'video/mp4', 'video'), await up('finished.mp4', 'video/mp4', 'video')];
    const logo = await up('logo.png', 'image/png', 'image');
    const kit = await saveBrandKit(h.ctx, u, { name: 'PIJILO', logoAssetId: logo.id, colors: { primary: '#7C5CFF', secondary: '#101010', text: '#FFFFFF' }, voice: 'warm', products: '3D figurines from photos', ctas: ['შეუკვეთე ახლა'], slogans: [], handles: {}, website: null, musicStyle: '', offers: '' });
    const c = await createCampaign(h.ctx, u, { request: '35 წამიანი ემოციური რეკლამა ქართულად, მთხრობელით', style: 'emotional', mode, preservation: 'strict', language: 'ka', lengthSec: 8, aspectRatio: '9:16', voiceover: true, music: 'generate', footageAssetIds: footage.map((x) => x.id), brandKitId: kit.id });
    await h.drain(200);
    return { u, c, footage, logo };
  }

  it('Tests 5, 6, 8 — analyse, plan, assemble an editable ad with voice and music, render it, and make variants (original footage only)', async () => {
    const { u, c, footage, logo } = await setup('original');
    let view = await getCampaign(h.ctx, u, c.id);
    expect(view.campaign.status).toBe('planned');
    // Footage catalog: the painting video's colour cut was detected; every segment has a frame and scores.
    const painting = view.segments.filter((s) => s.assetId === footage[1]!.id);
    expect(painting.length).toBeGreaterThanOrEqual(2);
    expect(view.segments.every((s) => s.frameAssetId && (s.scores as Record<string, number>).overall !== undefined)).toBe(true);
    const plan = adPlanSchema.parse(view.campaign.plan);
    expect(plan.scenes).toHaveLength(4);
    expect(plan.scenes.every((s) => s.enhance === null)).toBe(true); // original mode: no generative changes
    const est = await estimateCampaign(h.ctx, u, adBriefSchema.parse(view.campaign.brief), plan);
    expect(est.voice).toBeGreaterThan(0);

    await startAssembly(h.ctx, u, c.id, est.assembleTotal);
    await h.drain(400);
    view = await getCampaign(h.ctx, u, c.id);
    expect(view.campaign.status).toBe('ready');
    const pid = view.campaign.projectId!;
    const { timeline } = await getTimeline(h.ctx, u, pid);
    // Test 6: every picture is the client's own footage (or the logo card made from their logo file).
    const used = await h.ctx.db.select().from(assets).where(inArray(assets.id, timeline.clips.map((x) => x.assetId)));
    for (const a of used) expect(footage.some((x) => x.id === a.id) || (a.source as { logoCard?: boolean }).logoCard).toBe(true);
    expect(used.every((a) => !(a.source as { aiGenerated?: boolean }).aiGenerated)).toBe(true);
    // Each clip keeps its source interval inside the analysed segment.
    const segs = await h.ctx.db.select().from(footageSegments).where(eq(footageSegments.campaignId, c.id));
    for (const [i, sc] of plan.scenes.entries()) {
      const seg = segs.find((s) => s.id === sc.segmentId)!;
      expect(timeline.clips[i]!.assetId).toBe(seg.assetId);
      expect(timeline.clips[i]!.inSec).toBeCloseTo(seg.startSec + sc.inSec, 2);
    }
    expect(timeline.layers.some((l) => l.kind === 'text' && l.text?.content === 'ხელით შექმნილი')).toBe(true);
    expect(timeline.layers.some((l) => l.kind === 'image' && l.assetId === logo.id)).toBe(true);
    expect(timeline.audio.filter((a) => a.kind === 'voice')).toHaveLength(2);
    expect(timeline.audio.find((a) => a.kind === 'music')?.duck).toBe(true);
    // Rendered: a playable 9:16 MP4 with sound.
    const renderId = (view.campaign.plan as { renderJobId: string }).renderJobId;
    const [render] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, renderId));
    expect(render!.status).toBe('completed');
    const [out] = await h.ctx.db.select().from(assets).where(eq(assets.id, render!.outputAssetId!));
    const file = await downloadAssetToTemp(h.ctx, out as Asset);
    const meta = await probe(file);
    expect(meta.height).toBeGreaterThan(meta.width!);
    expect(meta.hasAudio).toBe(true);
    expect(meta.durationSec).toBeGreaterThan(8);

    // Test 8: square and landscape English variants reuse the same footage and plan.
    await createVariant(h.ctx, u, c.id, { aspectRatio: '1:1' });
    await createVariant(h.ctx, u, c.id, { aspectRatio: '16:9', language: 'en' });
    await h.drain(500);
    view = await getCampaign(h.ctx, u, c.id);
    expect(view.campaign.variants).toHaveLength(2);
    for (const v of view.campaign.variants) {
      const [j] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, v.renderJobId!));
      expect(j!.status).toBe('completed');
      const [o] = await h.ctx.db.select().from(assets).where(eq(assets.id, j!.outputAssetId!));
      const m = await probe(await downloadAssetToTemp(h.ctx, o as Asset));
      if (v.aspectRatio === '1:1') expect(m.width).toBe(m.height);
      else expect(m.width!).toBeGreaterThan(m.height!);
      expect(m.hasAudio).toBe(true);
    }
    const en = view.campaign.variants.find((v) => v.aspectRatio === '16:9')!;
    const enTl = (await getTimeline(h.ctx, u, en.projectId)).timeline;
    expect(enTl.layers.some((l) => l.text?.content.startsWith('EN '))).toBe(true);
  }, 900_000);

  it('Test 9 — an AI-enhanced shot is reviewed: rejecting keeps the real footage, other shots stay as approved', async () => {
    const { u, c, footage } = await setup('enhanced');
    let view = await getCampaign(h.ctx, u, c.id);
    const plan = adPlanSchema.parse(view.campaign.plan);
    expect(plan.scenes.filter((s) => s.enhance)).toHaveLength(1);
    const est = await estimateCampaign(h.ctx, u, adBriefSchema.parse(view.campaign.brief), plan);
    await startAssembly(h.ctx, u, c.id, est.assembleTotal);
    await h.drain(400);
    view = await getCampaign(h.ctx, u, c.id);
    const pid = view.campaign.projectId!;
    const { started } = await runEnhancements(h.ctx, u, c.id, est.enhance);
    expect(started).toHaveLength(1);
    await h.drain(100);
    const [op] = await h.ctx.db.select().from(editOperations).where(eq(editOperations.id, started[0]!));
    expect(op!.status).toBe('ready');
    // The prompt carried the product lock.
    const body = mock.calls.find((x) => x.url.endsWith('/video_to_video'))!.body as { promptText: string };
    expect(body.promptText).toMatch(/Do not alter the product/);
    // Not used until accepted; reject → the shot is still the client's footage.
    const before = await h.ctx.db.select().from(shots).where(eq(shots.projectId, pid));
    await rejectAiEdit(h.ctx, u, op!.id);
    const after = await h.ctx.db.select().from(shots).where(eq(shots.projectId, pid));
    expect(after.map((s) => s.currentAssetId)).toEqual(before.map((s) => s.currentAssetId));
    expect(footage.some((x) => x.id === after.find((s) => s.id === op!.shotId)!.currentAssetId)).toBe(true);
    // Using the AI version and then restoring the original also works and touches nothing else.
    const studio = await projectShots(h.ctx, u, pid);
    const shot = studio.shots.find((s) => s.id === op!.shotId)!;
    await activateShotVersion(h.ctx, u, op!.resultVersionId!);
    await activateShotVersion(h.ctx, u, shot.versions.find((v) => v.source === 'upload')!.id);
    const final = await h.ctx.db.select().from(shots).where(eq(shots.projectId, pid));
    expect(final.map((s) => s.currentAssetId)).toEqual(before.map((s) => s.currentAssetId));
    const [campaign] = await h.ctx.db.select().from(adCampaigns).where(eq(adCampaigns.id, c.id));
    expect(campaign!.status).toBe('ready');
  }, 900_000);
});
