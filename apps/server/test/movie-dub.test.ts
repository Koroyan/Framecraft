import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestContext, type TestHarness } from './helpers/context';
import { createMockFetch } from './helpers/mock-fetch';
import { ffmpegPath, generateFixtureClip, run } from '../src/media/ffmpeg';
import { addShot, chooseVoiceTake, createMovie, estimateMovie, generateMovie, getMovie, redubMovie, updateShot } from '../src/movie/movie';
import { dubTrack, guessGender } from '../src/movie/dub';
import { alignmentToWords } from '../src/providers/audio/elevenlabs';
import { getTimeline, saveTimeline } from '../src/editor/editor';
import { characters, generationJobs } from '../src/db/schema';

let mp4: Buffer;
let mp3: Buffer;
beforeAll(async () => {
  const f = path.join(os.tmpdir(), `fc-dub-video-${process.pid}.mp4`);
  await generateFixtureClip(f, { width: 720, height: 1280, durationSec: 6, title: 'Mock provider output' });
  mp4 = fs.readFileSync(f);
  const a = path.join(os.tmpdir(), `fc-dub-voice-${process.pid}.mp3`);
  await run(ffmpegPath(), ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.5', '-c:a', 'libmp3lame', '-b:a', '64k', a]);
  mp3 = fs.readFileSync(a);
}, 60_000);

describe('voice casting', () => {
  it('guesses gender from names and descriptions in English, Georgian and Russian', () => {
    expect(guessGender('Nino, a young woman with dark hair')).toBe('female');
    expect(guessGender('გიორგი, ახალგაზრდა კაცი')).toBe('male');
    expect(guessGender('ნინო — მისი ცოლი')).toBe('female');
    expect(guessGender('Девушка в красном пальто')).toBe('female');
    expect(guessGender('The Detective')).toBeUndefined();
  });

  it('turns ElevenLabs character timings into words', () => {
    const chars = [...'გამარჯობა ნინო'];
    const words = alignmentToWords({ characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1) });
    expect(words.map((w) => w.text)).toEqual(['გამარჯობა', 'ნინო']);
    expect(words[1]!.start).toBeCloseTo(1.0, 5);
  });
});

describe('Georgian dialogue is dubbed with ElevenLabs (integration)', () => {
  let h: TestHarness;
  const mock = createMockFetch();
  let busyOnce = false;
  let ttsOk = 0;
  beforeAll(async () => {
    mock
      .on('POST', 'https://api.ltx.io/v2/text-to-video', () => ({ status: 202, json: { id: `ltx-${Math.random().toString(36).slice(2)}` } }))
      .on('POST', 'https://api.ltx.io/v2/image-to-video', () => ({ status: 202, json: { id: `ltx-${Math.random().toString(36).slice(2)}` } }))
      .on('GET', /https:\/\/api\.ltx\.io\/v2\/(text|image)-to-video\//, () => ({ json: { status: 'completed', result: { video_url: 'https://cdn.ltx.test/out.mp4' } } }))
      .on('GET', 'https://cdn.ltx.test/out.mp4', () => ({ bytes: mp4 }))
      .on('POST', 'https://api.elevenlabs.io/v1/music', () => ({ bytes: mp3 }))
      .on('POST', 'https://api.elevenlabs.io/v1/sound-generation', () => ({ bytes: mp3 }))
      .on('POST', 'https://api.elevenlabs.io/v1/text-to-speech/', (call) => {
        // The first request hits the account's concurrency limit; the job must wait and retry.
        if (!busyOnce) {
          busyOnce = true;
          return { status: 429, json: { detail: { status: 'too_many_concurrent_requests' } } };
        }
        ttsOk++;
        // Character timings: 0.2 s of lead-in, then 0.05 s per character.
        const chars = [...(call.body as { text: string }).text];
        return { json: { audio_base64: mp3.toString('base64'), alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => 0.2 + i * 0.05), character_end_times_seconds: chars.map((_, i) => 0.25 + i * 0.05) } } };
      });
    h = await createTestContext({ env: { LIVE_GENERATION_ENABLED: 'true', LTX_API_KEY: 'ltx_test_key', ELEVENLABS_API_KEY: 'el_test_key', DEV_FIXTURES_ENABLED: 'false' }, fetch: mock.fetch });
  });
  afterAll(() => h.close());

  it('keeps speech out of the video, voices each line per character, and re-voices for free', async () => {
    const u = await h.makeUser(undefined, 'user', 20_000);
    const { projectId } = await createMovie(h.ctx, u, { idea: 'ნინო და გიორგი ძველ თბილისში', lengthSec: 15, language: 'ka', withDialogue: true, quality: 'economy' }, 'dub-movie-1');
    await h.drain();
    const movie = await getMovie(h.ctx, u, projectId);
    const shot = movie.scenes[0]!.shots[0]!;
    const [nino] = await h.ctx.db.insert(characters).values({ userId: u.id, projectId, name: 'ნინო', description: 'ახალგაზრდა ქალი' }).returning();
    const lines = [
      { characterId: nino!.id, speaker: 'ნინო', line: 'გამარჯობა, როგორ ხარ?' },
      { speaker: movie.characters[0]!.name, line: 'კარგად, შენ?' },
    ];
    await updateShot(h.ctx, u, shot.id, { dialogue: lines });

    const est = await estimateMovie(h.ctx, u, projectId, { onlyMissing: true });
    expect(est.dialogue).toMatchObject({ lines: 2, language: 'ka', available: true });
    expect(est.soundtrack).toMatchObject({ music: true, available: true });
    expect(est.totalCredits).toBe(est.shots.reduce((s, x) => s + x.credits, 0) + est.dialogue!.credits + est.soundtrack!.credits);

    const mj = await generateMovie(h.ctx, u, projectId, { approvedCredits: est.totalCredits, idempotencyKey: 'dub-gen-1' });
    await h.drain(120);

    // The video model was asked for ambience only — the Georgian line never reaches it.
    const videoCalls = mock.calls.filter((c) => c.url.startsWith('https://api.ltx.io/v2/') && c.method === 'POST');
    const prompts = videoCalls.map((c) => (c.body as { prompt: string }).prompt).join('\n');
    expect(prompts).not.toContain('გამარჯობა');
    expect(prompts).toContain('no speech');

    // Each line voiced in Georgian with the character's own voice.
    const tts = mock.calls.filter((c) => c.url.includes('/v1/text-to-speech/') && c.url.includes('/with-timestamps'));
    expect(tts).toHaveLength(3); // one 429, retried
    expect(ttsOk).toBe(2);
    expect(tts.every((c) => (c.body as { language_code: string }).language_code === 'ka')).toBe(true);
    const voiceOf = (c: (typeof tts)[number]) => c.url.split('/v1/text-to-speech/')[1]!.split(/[/?]/)[0];
    const [cast] = await h.ctx.db.select().from(characters).where(eq(characters.id, nino!.id));
    const ninoVoice = (cast!.voice as { voiceId: string }).voiceId;
    expect(cast!.voice).toMatchObject({ gender: 'female', voiceLanguage: 'ka' });
    expect(tts.map(voiceOf)).toContain(ninoVoice);
    expect(new Set(tts.map(voiceOf)).size).toBe(2);

    const [done] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, mj.id));
    expect(done!.status).toBe('completed');
    const tl = (await getTimeline(h.ctx, u, projectId)).timeline;
    expect(tl.audio.filter((a) => a.kind === 'voice')).toHaveLength(2);
    // Subtitles follow the recorded words: the cue starts when the first word is spoken.
    const voice0 = tl.audio.find((a) => a.kind === 'voice')!;
    const cue0 = tl.subtitles.find((s) => s.text === 'გამარჯობა, როგორ ხარ?')!;
    expect(cue0.startSec).toBeCloseTo(voice0.startSec + 0.2, 2);
    expect(tl.subtitles.every((c, i, all) => i === 0 || c.startSec >= all[i - 1]!.endSec)).toBe(true);
    expect(tl.clips.find((c) => c.shotId === shot.id)!.volume).toBe(0);
    // A score under the whole film, kept low because there is dialogue.
    const score = tl.audio.find((a) => a.id === 'auto-music')!;
    expect(score).toMatchObject({ kind: 'music', startSec: 0, volume: 0.18 });
    expect(mock.calls.some((c) => c.url.startsWith('https://api.elevenlabs.io/v1/music'))).toBe(true);

    // Re-voicing reuses the identical recordings (no new provider calls) and re-renders.
    const redub = await redubMovie(h.ctx, u, projectId, { approvedCredits: est.dialogue!.credits, idempotencyKey: 'dub-redub-1' });
    await h.drain(120);
    expect(ttsOk).toBe(2);
    const [re] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, redub.id));
    expect(re!.status).toBe('completed');
    const reused = await h.ctx.db.select().from(generationJobs).where(and(eq(generationJobs.parentJobId, redub.id), eq(generationJobs.kind, 'audio')));
    expect(reused.every((j) => j.chargedCredits === 0)).toBe(true);

    // Per-shot re-voice records a new take of just that shot; the user's own edits survive the re-render.
    const before = (await getTimeline(h.ctx, u, projectId)).timeline;
    await saveTimeline(h.ctx, u, projectId, { ...before, texts: [{ id: 't1', text: 'PIJILO', startSec: 0, endSec: 2 }] });
    const shotRedub = await redubMovie(h.ctx, u, projectId, { approvedCredits: est.dialogue!.credits, idempotencyKey: 'dub-shot-1', shotIds: [shot.id] });
    await h.drain(120);
    expect(ttsOk).toBe(4);
    const [sr] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, shotRedub.id));
    expect(sr!.status).toBe('completed');
    const after = (await getTimeline(h.ctx, u, projectId)).timeline;
    expect(after.texts.map((t) => t.text)).toEqual(['PIJILO']);
    const voiceIds = (t: typeof after) => t.audio.filter((a) => a.kind === 'voice').map((a) => a.assetId);
    expect(voiceIds(after)).toHaveLength(2);
    expect(voiceIds(after)).not.toEqual(voiceIds(before));

    // Earlier takes are kept: switching back puts exactly that take on the timeline (never two at once).
    const track = await dubTrack(h.ctx.db, projectId);
    const takes0 = track.takes.get(`${shot.id}:0`)!;
    expect(takes0.length).toBeGreaterThanOrEqual(2);
    expect(takes0.at(-1)!.current).toBe(true);
    await chooseVoiceTake(h.ctx, u, projectId, { shotId: shot.id, index: 0, assetId: takes0[0]!.assetId });
    const switched = (await getTimeline(h.ctx, u, projectId)).timeline;
    expect(voiceIds(switched)).toHaveLength(2);
    expect(voiceIds(switched)).toContain(takes0[0]!.assetId);
    expect(voiceIds(switched)).not.toContain(takes0.at(-1)!.assetId);
    await chooseVoiceTake(h.ctx, u, projectId, { shotId: shot.id, index: 0, assetId: null });
    expect(voiceIds((await getTimeline(h.ctx, u, projectId)).timeline)).toContain(takes0.at(-1)!.assetId);

    // An unfinished film (a new shot without a clip): a shot's take is recorded and put on the
    // timeline, without rendering the film.
    await addShot(h.ctx, u, shot.sceneId, { description: 'Extra', prompt: 'Extra shot' });
    const renders = async () => (await h.ctx.db.select().from(generationJobs).where(and(eq(generationJobs.projectId, projectId), eq(generationJobs.kind, 'render')))).length;
    const rendersBefore = await renders();
    const partial = await redubMovie(h.ctx, u, projectId, { approvedCredits: est.dialogue!.credits, idempotencyKey: 'dub-shot-2', shotIds: [shot.id] });
    await h.drain(120);
    const [pr] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, partial.id));
    expect(pr!.status).toBe('completed');
    expect(await renders()).toBe(rendersBefore);
    const latestTl = (await getTimeline(h.ctx, u, projectId)).timeline;
    expect(voiceIds(latestTl)).not.toEqual(voiceIds(after));
    await expect(redubMovie(h.ctx, u, projectId, { approvedCredits: 1000, idempotencyKey: 'dub-all-2' })).rejects.toThrow(/every shot/);
  }, 300_000);
});
