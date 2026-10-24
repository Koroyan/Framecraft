import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestContext, type TestHarness } from './helpers/context';
import { modelPricing } from '../src/db/schema';
import { syncCatalog, updateModelPrice, invalidateRegistryCache, loadRoutableModels } from '../src/services/registry';

describe('catalog price sync', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createTestContext();
  });
  afterAll(() => h.close());

  const row = async (modelKey: string, resolution: string, audio: boolean) =>
    (await h.ctx.db.select().from(modelPricing).where(and(eq(modelPricing.modelKey, modelKey), eq(modelPricing.resolution, resolution), eq(modelPricing.audio, audio))))[0];

  it('catalog corrections reach existing databases', async () => {
    // Simulate an old catalog price that has since been corrected.
    await h.ctx.db.update(modelPricing).set({ usdPerSecond: 0.14, source: 'catalog:any-audio' }).where(and(eq(modelPricing.modelKey, 'fal:kling-v3-standard-i2v'), eq(modelPricing.audio, false)));
    await syncCatalog(h.ctx.db);
    expect((await row('fal:kling-v3-standard-i2v', '720p', false))!.usdPerSecond).toBeCloseTo(0.084);
    expect((await row('fal:kling-v3-standard-i2v', '720p', true))!.usdPerSecond).toBeCloseTo(0.126);
  });

  it('admin price edits are never overwritten by a sync', async () => {
    await updateModelPrice(h.ctx.db, 'ltx:ltx-2-3-fast', { resolution: '720p', audio: 'any', usdPerSecond: 0.05, confidence: 'verified' });
    await syncCatalog(h.ctx.db);
    const r = await row('ltx:ltx-2-3-fast', '720p', false);
    expect(r!.usdPerSecond).toBeCloseTo(0.05);
    expect(r!.source).toBe('admin:any-audio');
    invalidateRegistryCache();
    const ltx = (await loadRoutableModels(h.ctx.db, new Set())).find((m) => m.key === 'ltx:ltx-2-3-fast')!;
    expect(ltx.pricing.find((p) => p.resolution === '720p')).toMatchObject({ audio: 'any', usdPerSecond: 0.05 });
  });
});
