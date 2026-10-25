import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestHarness } from './helpers/context';
import { createMockFetch } from './helpers/mock-fetch';
import { ffmpeg } from '../src/media/ffmpeg';
import { createAudioJob } from '../src/audio/audio';
import { generationJobs } from '../src/db/schema';

/* Re-assembling an ad must not pay for the same music twice (mocked ElevenLabs, no paid calls). */

describe('music reuse', () => {
  let h: TestHarness;
  const mock = createMockFetch();
  let musicCalls = 0;
  beforeAll(async () => {
    const f = path.join(os.tmpdir(), `fc-music-${process.pid}.mp3`);
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', f]);
    const mp3 = fs.readFileSync(f);
    mock.on('POST', 'https://api.elevenlabs.io/v1/music', () => {
      musicCalls++;
      return { bytes: mp3 };
    });
    h = await createTestContext({ env: { LIVE_GENERATION_ENABLED: 'true', ELEVENLABS_API_KEY: 'el_test_key' }, fetch: mock.fetch });
  });
  afterAll(() => h.close());

  it('the same music brief is composed once; a changed brief or "fresh" composes again', async () => {
    const u = await h.makeUser(undefined, 'user', 1000);
    const first = await createAudioJob(h.ctx, u, { kind: 'music', prompt: 'warm cinematic piano', durationSec: 15, idempotencyKey: 'm1' });
    await h.drain();
    const [done] = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.id, first.job.id));
    expect(done!.chargedCredits).toBeGreaterThan(0);
    const again = await createAudioJob(h.ctx, u, { kind: 'music', prompt: 'warm cinematic piano', durationSec: 15, idempotencyKey: 'm2' });
    expect(again.reused).toBe(true);
    expect(again.job).toMatchObject({ status: 'completed', chargedCredits: 0, outputAssetId: done!.outputAssetId });
    expect(musicCalls).toBe(1);
    await createAudioJob(h.ctx, u, { kind: 'music', prompt: 'upbeat social beat', durationSec: 15, idempotencyKey: 'm3' });
    await createAudioJob(h.ctx, u, { kind: 'music', prompt: 'warm cinematic piano', durationSec: 15, idempotencyKey: 'm4', fresh: true });
    await h.drain();
    expect(musicCalls).toBe(3);
  });
});
