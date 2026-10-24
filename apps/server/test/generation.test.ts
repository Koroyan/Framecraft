import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestHarness } from './helpers/context';
import { createMockFetch } from './helpers/mock-fetch';
import { generateFixtureClip } from '../src/media/ffmpeg';
import { createGeneration, cancelGeneration, getOwnedJob, estimateGeneration } from '../src/generation/service';
import { getWallet, reserveCredits, addCredits } from '../src/billing/wallet';
import { assets, creditTransactions, generationJobs, providerJobs, userSettings } from '../src/db/schema';
import { AppError } from '../src/lib/errors';
import { setConfig } from '../src/services/admin-config';

let mp4: Buffer;
beforeAll(async () => {
  const f = path.join(os.tmpdir(), `fc-mock-output-${process.pid}.mp4`);
  await generateFixtureClip(f, { width: 720, height: 1280, durationSec: 6, title: 'Mock provider output' });
  mp4 = fs.readFileSync(f);
}, 60_000);

const spec = { prompt: 'A calm ocean at sunset, gentle waves', aspectRatio: '9:16' as const, durationSec: 6, quality: 'economy' as const, enhancePrompt: false };

describe('development mode without credentials (fixtures)', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createTestContext();
  });
  afterAll(() => h.close());

  it('runs the whole pipeline with a clearly labelled fixture and charges nothing', async () => {
    const u = await h.makeUser();
    const est = await estimateGeneration(h.ctx, u, spec);
    expect(est.ok).toBe(true);
    expect(est.liveGenerationAvailable).toBe(false);
    const { job } = await createGeneration(h.ctx, u, { spec, idempotencyKey: 'fixture-key-1', confirmEstimate: false });
    expect(job.isFixture).toBe(true);
    expect(job.estimatedCredits).toBe(0);
    await h.drain();
    const done = await getOwnedJob(h.ctx, u, job.id);
    expect(done.status).toBe('completed');
    expect(done.phase).toMatch(/not AI generated/);
    const [out] = await h.ctx.db.select().from(assets).where(eq(assets.id, done.outputAssetId!));
    expect(out!.isFixture).toBe(true);
    expect((out!.source as { aiGenerated: boolean }).aiGenerated).toBe(false);
    expect(out!.thumbnailAssetId).toBeTruthy();
    expect((await getWallet(h.ctx.db, u.id)).balance).toBe(300);
  }, 120_000);

  it('rejects other users from reading a job', async () => {
    const a = await h.makeUser();
    const b = await h.makeUser();
    const { job } = await createGeneration(h.ctx, a, { spec, idempotencyKey: 'own-1', confirmEstimate: false });
    await expect(getOwnedJob(h.ctx, b, job.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('live generation against a mocked provider transport', () => {
  let h: TestHarness;
  const mock = createMockFetch();
  let ltxStatus: 'completed' | 'failed' | 'policy' = 'completed';
  beforeAll(async () => {
    mock
      .on('POST', 'https://api.ltx.io/v2/text-to-video', () => ({ status: 202, json: { id: `ltx-${Math.random().toString(36).slice(2)}` } }))
      .on('GET', /https:\/\/api\.ltx\.io\/v2\/text-to-video\//, () =>
        ltxStatus === 'completed'
          ? { json: { status: 'completed', result: { video_url: 'https://cdn.ltx.test/out.mp4' } } }
          : ltxStatus === 'policy'
            ? { json: { status: 'failed', error: { message: 'Rejected by safety filter', type: 'safety' } } }
            : { json: { status: 'failed', error: { message: 'model crashed', type: 'internal' } } },
      )
      .on('GET', 'https://cdn.ltx.test/out.mp4', () => ({ bytes: mp4 }));
    h = await createTestContext({ env: { LIVE_GENERATION_ENABLED: 'true', LTX_API_KEY: 'ltx_test_key', DEV_FIXTURES_ENABLED: 'false' }, fetch: mock.fetch });
  });
  afterAll(() => h.close());

  it('requires explicit confirmation before paid work', async () => {
    const u = await h.makeUser();
    await expect(createGeneration(h.ctx, u, { spec, idempotencyKey: 'confirm-1', confirmEstimate: false })).rejects.toMatchObject({ code: 'confirmation_required' });
    expect((await getWallet(h.ctx.db, u.id)).reserved).toBe(0);
  });

  it('reserves, generates, validates, stores and settles credits', async () => {
    ltxStatus = 'completed';
    const u = await h.makeUser();
    const { job, estimate } = await createGeneration(h.ctx, u, { spec, idempotencyKey: 'live-1', confirmEstimate: true });
    expect(job.isFixture).toBe(false);
    expect(job.providerKey).toBe('ltx');
    expect(estimate.credits).toBeGreaterThan(0);
    expect((await getWallet(h.ctx.db, u.id)).reserved).toBe(estimate.credits);

    await h.drain();
    const done = await getOwnedJob(h.ctx, u, job.id);
    expect(done.status).toBe('completed');
    expect(done.chargedCredits).toBe(estimate.credits);
    const w = await getWallet(h.ctx.db, u.id);
    expect(w.reserved).toBe(0);
    expect(w.balance).toBe(300 - estimate.credits);
    const pj = await h.ctx.db.select().from(providerJobs).where(eq(providerJobs.generationJobId, job.id));
    expect(pj).toHaveLength(1);
    expect(pj[0]!.status).toBe('succeeded');
    expect(pj[0]!.costSource).toBe('price_table');
    expect(pj[0]!.requestPayload).toMatchObject({ model: 'ltx-2-3-fast', resolution: '720x1280', duration: 6 });
    const ledger = await h.ctx.db.select().from(creditTransactions).where(eq(creditTransactions.jobId, job.id));
    expect(ledger.map((l) => l.type).sort()).toEqual(['capture', 'reserve']);
  }, 120_000);

  it('is idempotent: the same key never creates or charges twice', async () => {
    const u = await h.makeUser();
    const a = await createGeneration(h.ctx, u, { spec, idempotencyKey: 'idem-1', confirmEstimate: true });
    const b = await createGeneration(h.ctx, u, { spec, idempotencyKey: 'idem-1', confirmEstimate: true });
    expect(b.job.id).toBe(a.job.id);
    expect(b.created).toBe(false);
    expect((await getWallet(h.ctx.db, u.id)).reserved).toBe(a.estimate.credits);
    await cancelGeneration(h.ctx, u, a.job.id);
  });

  it('blocks paid work without enough credits and creates nothing', async () => {
    const u = await h.makeUser(undefined, 'user', 0);
    await expect(createGeneration(h.ctx, u, { spec, idempotencyKey: 'poor-1', confirmEstimate: true })).rejects.toMatchObject({ code: 'insufficient_credits', status: 402 });
    const jobs = await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.userId, u.id));
    expect(jobs).toHaveLength(0);
  });

  it('never over-reserves under concurrent requests', async () => {
    const u = await h.makeUser(undefined, 'user', 100);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => reserveCredits(h.ctx.db, { userId: u.id, amount: 30, description: 'race', idempotencyKey: `race-${u.id}-${i}` })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const w = await getWallet(h.ctx.db, u.id);
    expect(w.reserved).toBe(90);
    expect(w.available).toBe(10);
  });

  it('returns credits when the provider fails', async () => {
    ltxStatus = 'failed';
    const u = await h.makeUser();
    const { job } = await createGeneration(h.ctx, u, { spec, idempotencyKey: 'fail-1', confirmEstimate: true });
    await h.drain();
    const done = await getOwnedJob(h.ctx, u, job.id);
    expect(done.status).toBe('failed');
    expect(done.chargedCredits).toBe(0);
    // The internal error is retryable: one automatic retry (2 provider attempts), then stop.
    const pj = await h.ctx.db.select().from(providerJobs).where(eq(providerJobs.generationJobId, job.id));
    expect(pj).toHaveLength(2);
    const w = await getWallet(h.ctx.db, u.id);
    expect(w.balance).toBe(300);
    expect(w.reserved).toBe(0);
  }, 120_000);

  it('cancels a queued job and releases the reservation', async () => {
    const u = await h.makeUser();
    const { job } = await createGeneration(h.ctx, u, { spec, idempotencyKey: 'cancel-1', confirmEstimate: true });
    const c = await cancelGeneration(h.ctx, u, job.id);
    expect(c.status).toBe('cancelled');
    expect((await getWallet(h.ctx.db, u.id)).reserved).toBe(0);
    await h.drain();
    expect((await getOwnedJob(h.ctx, u, job.id)).status).toBe('cancelled');
  });

  it('blocks a plan-restricted quality mode with a clear message', async () => {
    const u = await h.makeUser();
    await expect(createGeneration(h.ctx, u, { spec: { ...spec, quality: 'cinematic' }, idempotencyKey: 'plan-1', confirmEstimate: true })).rejects.toBeInstanceOf(AppError);
  });

  it('the daily kill-switch counts jobs still in flight, not only finished ones', async () => {
    const u = await h.makeUser();
    await addCredits(h.ctx.db, { userId: u.id, amount: 5000, type: 'adjustment', description: 'test', idempotencyKey: `ks-${u.id}` });
    const cap = 1;
    await setConfig(h.ctx.db, 'spending', { globalDailyProviderBudgetUsd: cap });
    // Fill the cap with queued (not yet finished) live jobs.
    const spec10 = { ...spec, durationSec: 10 };
    const created: string[] = [];
    let blocked = false;
    for (let i = 0; i < 400 && !blocked; i++) {
      try {
        created.push((await createGeneration(h.ctx, u, { spec: spec10, idempotencyKey: `ks-job-${i}`, confirmEstimate: true, skipConcurrency: true })).job.id);
      } catch (e) {
        expect((e as AppError).code).toBe('capacity_paused');
        blocked = true;
      }
    }
    expect(blocked).toBe(true);
    const inFlightUsd = (await h.ctx.db.select().from(generationJobs).where(eq(generationJobs.userId, u.id))).reduce((s, j) => s + j.estimatedCostUsd, 0);
    expect(inFlightUsd).toBeLessThanOrEqual(cap + 1e-9);
    for (const id of created) await cancelGeneration(h.ctx, u, id);
    await setConfig(h.ctx.db, 'spending', { globalDailyProviderBudgetUsd: 50 });
  });

  it('respects the per-job spending limit', async () => {
    const u = await h.makeUser();
    await addCredits(h.ctx.db, { userId: u.id, amount: 1000, type: 'adjustment', description: 'test', idempotencyKey: `extra-${u.id}` });
    await h.ctx.db.update(userSettings).set({ perJobSpendLimit: 1 }).where(eq(userSettings.userId, u.id));
    await expect(createGeneration(h.ctx, u, { spec, idempotencyKey: 'limit-1', confirmEstimate: true })).rejects.toMatchObject({ code: 'spend_limit' });
  });
});
