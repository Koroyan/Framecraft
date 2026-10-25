import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestHarness } from './helpers/context';
import { createMockFetch } from './helpers/mock-fetch';
import { ffmpeg, generateFixtureClip } from '../src/media/ffmpeg';
import { createMovie, estimateMovie, generateMovie } from '../src/movie/movie';
import { generationJobs, shots } from '../src/db/schema';
import { getTimeline } from '../src/editor/editor';
import { VOICE_LEAD_SEC } from '../src/movie/dub';
import { cancelGeneration } from '../src/generation/service';

/*
 * Georgian dialogue with lip-sync: the lines are voiced first (ElevenLabs), then the speaking shot
 * is generated FROM that recording (Runway reference audio), so the mouth follows Georgian words.
 * Providers are mocked HTTP — no paid calls.
 */

let mp4: Buffer;
let mp3: Buffer;
let png: Buffer;
beforeAll(async () => {
  const v = path.join(os.tmpdir(), `fc-ls-${process.pid}.mp4`);
  await generateFixtureClip(v, { width: 1280, height: 720, durationSec: 6, title: 'clip' });
  mp4 = fs.readFileSync(v);
  const a = path.join(os.tmpdir(), `fc-ls-${process.pid}.mp3`);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.6', a]);
  mp3 = fs.readFileSync(a);
  const i = path.join(os.tmpdir(), `fc-ls-${process.pid}.png`);
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=0x806050:s=720x1280', '-frames:v', '1', i]);
  png = fs.readFileSync(i);
}, 60_000);

describe('lip-sync for dubbed (Georgian) dialogue', () => {
  let h: TestHarness;
  const mock = createMockFetch();
  let n = 0;
  beforeAll(async () => {
    const RW = 'https://api.dev.runwayml.com/v1';
    mock
      .on('POST', 'https://api.elevenlabs.io/v1/text-to-speech/', (call) => {
        const chars = [...(call.body as { text: string }).text];
        return { json: { audio_base64: mp3.toString('base64'), alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => 0.05 + i * 0.05) } } };
      })
      .on('POST', `${RW}/text_to_image`, () => ({ json: { id: `img-${++n}` } }))
      .on('POST', `${RW}/text_to_video`, () => ({ json: { id: `v-${++n}` } }))
      .on('POST', `${RW}/image_to_video`, () => ({ json: { id: `v-${++n}` } }))
      .on('GET', new RegExp(`${RW}/tasks/`), (c) => {
        const id = c.url.split('/tasks/')[1]!;
        return { json: { id, status: 'SUCCEEDED', output: [id.startsWith('img-') ? 'https://cdn.runway.test/frame.png' : 'https://cdn.runway.test/clip.mp4'] } };
      })
      .on('GET', 'https://cdn.runway.test/frame.png', () => ({ bytes: png }))
      .on('GET', 'https://cdn.runway.test/clip.mp4', () => ({ bytes: mp4 }));
    h = await createTestContext({ env: { LIVE_GENERATION_ENABLED: 'true', RUNWAYML_API_SECRET: 'rw_test_key', ELEVENLABS_API_KEY: 'el_test_key', DEV_FIXTURES_ENABLED: 'false' }, fetch: mock.fetch });
  });
  afterAll(() => h.close());

  it('records the Georgian line first and generates the speaking shot from it', async () => {
    const u = await h.makeUser(undefined, 'user', 50_000);
    const { projectId } = await createMovie(h.ctx, u, { idea: 'Nino greets her grandmother in an old Tbilisi courtyard.', lengthSec: 15, quality: 'economy', language: 'ka', withDialogue: true, withMusic: false, keyframes: false }, 'ls-movie-1');
    await h.drain();
    const list = await h.ctx.db.select().from(shots).where(eq(shots.projectId, projectId));
    const speaking = list.sort((a, b) => a.index - b.index)[0]!;
    await h.ctx.db.update(shots).set({ dialogue: [{ speaker: 'ნინო', line: 'გამარჯობა, ბებია!' }], durationSec: 5 }).where(eq(shots.id, speaking.id));
    for (const s of list.filter((x) => x.id !== speaking.id)) await h.ctx.db.update(shots).set({ dialogue: [] }).where(eq(shots.id, s.id));

    const est = await estimateMovie(h.ctx, u, projectId, { onlyMissing: true });
    expect(est.ok).toBe(true);
    const item = est.shots.find((s) => s.shotId === speaking.id)!;
    expect(item.lipSync).toBe(true);
    // Keyframes are off for this film, but a lip-synced shot still starts from one: providers need a face to animate.
    expect(item.keyframe).toBe('drawn first');
    expect(est.shots.filter((s) => s.shotId !== speaking.id).every((s) => !s.lipSync)).toBe(true);

    const before = mock.calls.length;
    const mj = await generateMovie(h.ctx, u, projectId, { approvedCredits: est.totalCredits, idempotencyKey: 'ls-gen-1' });
    await h.drain(200);
    const calls = mock.calls.slice(before);
    const firstTts = calls.findIndex((c) => c.url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/'));
    const videoCalls = calls.map((c, i) => ({ c, i })).filter(({ c }) => /_to_video$/.test(c.url));
    const frameCall = calls.findIndex((c) => c.url.endsWith('/text_to_image'));
    expect(firstTts).toBeGreaterThanOrEqual(0);
    expect(frameCall).toBeGreaterThanOrEqual(0);
    expect(videoCalls.every(({ i }) => i > firstTts && i > frameCall)).toBe(true); // voice and keyframe first, video after

    const lipCalls = videoCalls.filter(({ c }) => (c.body as { referenceAudio?: unknown }).referenceAudio);
    expect(lipCalls).toHaveLength(1);
    // Never audio as the only reference (Runway rejects that): the speaking shot animates its keyframe.
    expect(lipCalls[0]!.c.url.endsWith('/image_to_video')).toBe(true);
    const lip = lipCalls.map(({ c }) => c.body as { model: string; promptText: string; promptImage?: unknown; referenceAudio?: { type: string; uri: string }[]; audio?: boolean });
    // …as an unpositioned reference image: a first-frame keyframe cannot be combined with audio.
    expect(lip[0]!.promptImage).toEqual([{ uri: expect.stringMatching(/^(data:image|https:)/) }]);
    expect(lip[0]!.referenceAudio![0]!.type).toBe('audio');
    expect(lip[0]!.referenceAudio![0]!.uri.startsWith('data:audio/mpeg;base64,')).toBe(true);
    expect(lip[0]!.promptText).toMatch(/@Audio1/);
    expect(lip[0]!.audio).not.toBe(true); // no generated voice on top of the recording
    expect(['seedance2_5', 'seedance2_mini', 'hailuo3', 'wan3', 'wan3_prime']).toContain(lip[0]!.model);

    const [done] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, mj.id));
    expect(done!.status).toBe('completed');
    expect(done!.chargedCredits).toBeLessThanOrEqual(est.totalCredits);
    // On the timeline the voice starts exactly where the recording put it (shot start + lead-in), clip muted.
    const { timeline } = await getTimeline(h.ctx, u, projectId);
    const idx = timeline.clips.findIndex((c) => c.shotId === speaking.id);
    let start = 0;
    for (let i = 0; i < idx; i++) start += timeline.clips[i]!.outSec - timeline.clips[i]!.inSec - (timeline.clips[i]!.transition && timeline.clips[i]!.transition!.type !== 'cut' ? timeline.clips[i]!.transition!.durationSec : 0);
    const voice = timeline.audio.find((a) => a.kind === 'voice')!;
    expect(voice.startSec).toBeCloseTo(start + VOICE_LEAD_SEC, 2);
    expect(timeline.clips[idx]!.volume).toBe(0);

    // Regenerating the shot reuses the recorded line (no charge, finished at once) — the film must still move on.
    await h.ctx.db.update(shots).set({ status: 'failed', currentAssetId: null }).where(eq(shots.id, speaking.id));
    const again = await estimateMovie(h.ctx, u, projectId, { onlyMissing: true });
    expect(again.shots.find((s) => s.shotId === speaking.id)!.lipSync).toBe(true);
    const mj2 = await generateMovie(h.ctx, u, projectId, { approvedCredits: again.totalCredits, idempotencyKey: 'ls-gen-2' });
    await h.drain(200);
    const [done2] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, mj2.id));
    expect(done2!.status).toBe('completed');
  }, 300_000);

  it('a film still waiting for its voices or keyframes can be cancelled (its parts are cancelled too)', async () => {
    const u = await h.makeUser(undefined, 'user', 1000);
    const [mj] = await h.ctx.db.insert(generationJobs).values({ userId: u.id, kind: 'movie', status: 'generating', phase: 'Recording the voices first so the lips match', request: {}, idempotencyKey: 'cancel-film' }).returning();
    const [part] = await h.ctx.db.insert(generationJobs).values({ userId: u.id, kind: 'audio', status: 'queued', parentJobId: mj!.id, request: {}, idempotencyKey: 'cancel-film-voice' }).returning();
    const out = await cancelGeneration(h.ctx, u, mj!.id);
    expect(out.status).toBe('cancelled');
    const [p] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, part!.id));
    expect(p!.status).toBe('cancelled');
  });
});
