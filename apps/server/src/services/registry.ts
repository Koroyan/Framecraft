import { and, eq, gte, sql } from 'drizzle-orm';
import type { PublicModel } from '@framecraft/shared';
import type { Db } from '../db/client';
import { modelEvaluations, modelPricing, modelRegistry, providerJobs, providers } from '../db/schema';
import { VIDEO_MODELS } from '../catalog/video-models';
import { AUDIO_MODELS, IMAGE_MODELS } from '../catalog/media-models';
import type { CatalogVideoModel, PriceRow, ProviderKey } from '../catalog/types';
import type { RoutableModel } from '../routing/router';
import { PROVIDER_INFO } from '../providers/video';
import { getConfig } from './admin-config';

/**
 * Seed providers, models and prices from the static catalog.
 * Inserts what is missing and refreshes catalog-owned facts (capabilities,
 * docs, verification date); admin-owned fields (enabled, quality tier,
 * prices edited in the admin panel) are preserved.
 */
export async function syncCatalog(db: Db): Promise<void> {
  const providerKeys = new Set<string>([...VIDEO_MODELS, ...IMAGE_MODELS, ...AUDIO_MODELS].map((m) => m.provider));
  for (const key of providerKeys) {
    await db
      .insert(providers)
      .values({ key, displayName: PROVIDER_INFO[key]?.displayName ?? key })
      .onConflictDoNothing();
  }
  for (const m of [...VIDEO_MODELS, ...IMAGE_MODELS, ...AUDIO_MODELS]) {
    const { pricing, qualityTier, ...rest } = m as CatalogVideoModel;
    const capabilities = m.kind === 'video' ? { ...m.capabilities, providerOptions: m.providerOptions ?? {}, pricingConfidence: m.pricingConfidence } : { ...rest };
    await db
      .insert(modelRegistry)
      .values({
        key: m.key,
        providerKey: m.provider,
        providerModelId: m.providerModelId,
        displayName: m.displayName,
        family: m.kind === 'video' ? m.family : m.key,
        kind: m.kind,
        status: m.status,
        // Unverified/discontinued models are seeded disabled.
        enabled: m.status === 'active' || m.status === 'preview',
        capabilities: capabilities as Record<string, unknown>,
        qualityTier: qualityTier ?? m.qualityTier,
        docsUrl: m.docsUrl,
        verifiedAt: m.verifiedAt,
        notes: m.notes,
      })
      .onConflictDoUpdate({
        target: modelRegistry.key,
        set: {
          capabilities: capabilities as Record<string, unknown>,
          docsUrl: m.docsUrl,
          verifiedAt: m.verifiedAt,
          notes: m.notes,
          providerModelId: m.providerModelId,
          displayName: m.displayName,
          // Lifecycle downgrades from the catalog always apply; otherwise keep the admin's status.
          status: m.status === 'discontinued' || m.status === 'deprecated' ? m.status : sql`${modelRegistry.status}`,
          enabled: m.status === 'discontinued' ? false : sql`${modelRegistry.enabled}`,
        },
      });
    if (m.kind === 'video') {
      for (const p of pricing) await upsertPrice(db, m.key, p, m.pricingConfidence, false);
    }
  }
}

async function upsertPrice(db: Db, modelKey: string, p: PriceRow, confidence: string, overwrite: boolean) {
  const values = {
    modelKey,
    resolution: p.resolution,
    audio: p.audio === true,
    usdPerSecond: p.usdPerSecond,
    usdPerReference: p.usdPerReference ?? 0,
    minimumUsd: p.minimumUsd ?? 0,
    confidence,
    // 'catalog…' rows follow catalog corrections on every sync; 'admin…' rows are never overwritten by a sync.
    source: `${overwrite ? 'admin' : 'catalog'}${p.audio === 'any' ? ':any-audio' : ''}`,
  };
  await db
    .insert(modelPricing)
    .values(values)
    .onConflictDoUpdate({
      target: [modelPricing.modelKey, modelPricing.resolution, modelPricing.audio],
      set: { ...values, updatedAt: new Date() },
      where: overwrite ? undefined : sql`${modelPricing.source} like 'catalog%'`,
    });
}

export function configuredProviders(env: Record<string, unknown>): Set<ProviderKey> {
  const s = new Set<ProviderKey>();
  if (env.RUNWAYML_API_SECRET) s.add('runway');
  if (env.LTX_API_KEY) s.add('ltx');
  if (env.FAL_KEY) s.add('fal');
  if (env.GEMINI_API_KEY) s.add('google');
  if (env.REPLICATE_API_TOKEN) s.add('replicate');
  if (env.ELEVENLABS_API_KEY) s.add('elevenlabs');
  if (env.ANTHROPIC_API_KEY) s.add('anthropic');
  return s;
}

let routableCache: { at: number; key: string; models: RoutableModel[] } | undefined;

export function invalidateRegistryCache() {
  routableCache = undefined;
}

/** Catalog models merged with DB state: enablement, admin prices, measured quality, reliability. */
export async function loadRoutableModels(db: Db, configured: Set<ProviderKey>): Promise<RoutableModel[]> {
  const cacheKey = [...configured].sort().join(',');
  if (routableCache && routableCache.key === cacheKey && Date.now() - routableCache.at < 10_000) return routableCache.models;

  const [regRows, priceRows, provRows, spending] = await Promise.all([
    db.select().from(modelRegistry).where(eq(modelRegistry.kind, 'video')),
    db.select().from(modelPricing),
    db.select().from(providers),
    getConfig(db, 'spending'),
  ]);
  const evals = await db
    .select({ modelKey: modelEvaluations.modelKey, n: sql<number>`count(*)::int`, mean: sql<number>`avg(${modelEvaluations.overall})::float` })
    .from(modelEvaluations)
    .groupBy(modelEvaluations.modelKey);
  const since = new Date(Date.now() - 30 * 86400_000);
  const reliab = await db
    .select({
      modelKey: providerJobs.modelKey,
      total: sql<number>`count(*)::int`,
      ok: sql<number>`sum(case when ${providerJobs.status} = 'succeeded' then 1 else 0 end)::int`,
    })
    .from(providerJobs)
    .where(and(gte(providerJobs.createdAt, since), sql`${providerJobs.providerKey} <> 'fixture'`))
    .groupBy(providerJobs.modelKey);

  const provEnabled = new Map(provRows.map((p) => [p.key, p.enabled]));
  const evalBy = new Map(evals.map((e) => [e.modelKey, e]));
  const relBy = new Map(reliab.map((r) => [r.modelKey, r]));

  const models: RoutableModel[] = [];
  for (const row of regRows) {
    const base = VIDEO_MODELS.find((m) => m.key === row.key);
    if (!base) continue;
    const prices = priceRows.filter((p) => p.modelKey === row.key);
    const pricing: PriceRow[] = prices.length
      ? prices.map((p) => ({
          resolution: p.resolution as PriceRow['resolution'],
          audio: p.source?.endsWith(':any-audio') ? 'any' : p.audio,
          usdPerSecond: p.usdPerSecond,
          usdPerReference: p.usdPerReference || undefined,
          minimumUsd: p.minimumUsd || undefined,
        }))
      : base.pricing;
    const ev = evalBy.get(row.key);
    const rel = relBy.get(row.key);
    // Bayesian-smoothed reliability: assume 95% with weight 20 until real history accumulates.
    const reliability = rel ? (rel.ok + 0.95 * 20) / (rel.total + 20) : row.reliability;
    const confidences = new Set(prices.map((p) => p.confidence));
    models.push({
      ...base,
      status: row.status as CatalogVideoModel['status'],
      qualityTier: row.qualityTier,
      pricing,
      pricingConfidence: confidences.has('unverified') ? 'unverified' : confidences.has('partial') ? 'partial' : prices.length ? 'verified' : base.pricingConfidence,
      enabled: row.enabled,
      providerEnabled: provEnabled.get(row.providerKey) ?? true,
      configured: configured.has(row.providerKey as ProviderKey),
      measuredTier: ev && ev.n >= spending.minEvaluationsForMeasured ? Math.round(ev.mean * 10) / 10 : undefined,
      reliability,
    });
  }
  routableCache = { at: Date.now(), key: cacheKey, models };
  return models;
}

export function toPublicModel(m: RoutableModel, liveEnabled: boolean): PublicModel {
  const c = m.capabilities;
  const routable = m.enabled && m.providerEnabled && (m.status === 'active' || m.status === 'preview') && m.pricingConfidence !== 'unverified';
  return {
    key: m.key,
    provider: m.provider,
    displayName: m.displayName,
    family: m.family,
    status: m.status,
    enabled: m.enabled,
    configured: m.configured && liveEnabled,
    routable,
    modes: c.modes,
    aspectRatios: c.aspectRatios,
    resolutions: c.resolutions,
    durations: c.durations,
    nativeAudio: c.nativeAudio !== 'none',
    maxReferenceImages: c.maxReferenceImages,
    firstLastFrame: c.modes.includes('first-last-frame'),
    cameraControl: Boolean(c.cameraControl?.length),
    qualityTier: m.measuredTier ?? m.qualityTier,
    qualitySource: m.measuredTier !== undefined ? 'measured' : 'provisional',
    fromUsdPerSecond: Math.min(...m.pricing.map((p) => p.usdPerSecond)),
    notes: m.notes,
    docsUrl: m.docsUrl,
    verifiedAt: m.verifiedAt,
  };
}

export async function updateModelPrice(db: Db, modelKey: string, p: PriceRow & { confidence: string }) {
  await upsertPrice(db, modelKey, p, p.confidence, true);
  invalidateRegistryCache();
}
