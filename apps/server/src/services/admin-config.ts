import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { adminConfig } from '../db/schema';
import { DEFAULT_PRICING_RULES, type PricingRules } from '../pricing/pricing';
import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from '../routing/router';

export const pricingRulesSchema = z.object({
  creditValueUsd: z.number().positive().max(10),
  markup: z.number().min(0).max(10),
  minMargin: z.number().min(0).max(0.95),
  processingUsdPerSecond: z.number().min(0).max(1),
  partialPricingBuffer: z.number().min(0).max(2),
  allowUnverifiedPricing: z.boolean(),
  minimumCredits: z.number().int().min(1).max(10000),
});

export const routingConfigSchema = z.object({
  tierThresholds: z.object({ economy: z.number().min(1).max(5), balanced: z.number().min(1).max(5), high: z.number().min(1).max(5), cinematic: z.number().min(1).max(5) }),
  complexityBump: z.boolean(),
  allowSegmentStitching: z.boolean(),
  maxSegments: z.number().int().min(1).max(20),
  stitchingPenalty: z.number().min(0).max(3),
  minStitchSavings: z.number().min(0).max(1),
});

export const spendingConfigSchema = z.object({
  /** Hard cap on credits per single job, across all users. */
  maxCreditsPerJob: z.number().int().positive(),
  /** Global daily provider spend kill-switch (USD). */
  globalDailyProviderBudgetUsd: z.number().min(0),
  /** Movies above this many credits need explicit budget approval (always true for movies). */
  movieApprovalThresholdCredits: z.number().int().min(0),
  /** Max automatic provider retries per segment. */
  maxProviderRetries: z.number().int().min(0).max(5),
  /** Minimum evaluations before measured quality replaces provisional tiers. */
  minEvaluationsForMeasured: z.number().int().min(1).max(1000),
});
export type SpendingConfig = z.infer<typeof spendingConfigSchema>;

export const DEFAULT_SPENDING: SpendingConfig = {
  maxCreditsPerJob: 20_000,
  globalDailyProviderBudgetUsd: 50,
  movieApprovalThresholdCredits: 0,
  maxProviderRetries: 1,
  minEvaluationsForMeasured: 20,
};

/**
 * Dialogue voices per language (ElevenLabs voice ids), cast by character gender.
 * 'default' is used for languages without their own list. Native-speaker voices from the
 * ElevenLabs Voice Library give the most natural accent; premade voices are the fallback.
 */
const voicePool = z.object({ male: z.array(z.string().min(1).max(64)).min(1).max(20), female: z.array(z.string().min(1).max(64)).min(1).max(20), narrator: z.string().min(1).max(64).optional() });
export const voicesConfigSchema = z.record(z.string().max(8), voicePool).refine((v) => Boolean(v.default), 'A default voice list is required');
export type VoicesConfig = z.infer<typeof voicesConfigSchema>;

export const DEFAULT_VOICES_CONFIG: VoicesConfig = {
  // ElevenLabs premade voices: George, Liam / Charlotte, Rachel.
  default: { male: ['JBFqnCBsd6RMkjVDRZzb', 'TX3LPaxmHKxFdv7VOQHJ'], female: ['XB0fDUnXU5powFXDhCwa', '21m00Tcm4TlvDq8ikWAM'] },
};

const DEFINITIONS = {
  pricing: { schema: pricingRulesSchema, default: DEFAULT_PRICING_RULES },
  routing: { schema: routingConfigSchema, default: DEFAULT_ROUTING_CONFIG },
  spending: { schema: spendingConfigSchema, default: DEFAULT_SPENDING },
  voices: { schema: voicesConfigSchema, default: DEFAULT_VOICES_CONFIG },
} as const;

export type ConfigKey = keyof typeof DEFINITIONS;
type ConfigValue<K extends ConfigKey> = K extends 'pricing' ? PricingRules : K extends 'routing' ? RoutingConfig : K extends 'voices' ? VoicesConfig : SpendingConfig;

const cache = new Map<string, { value: unknown; at: number }>();

export async function getConfig<K extends ConfigKey>(db: Db, key: K): Promise<ConfigValue<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.value as ConfigValue<K>;
  const [row] = await db.select().from(adminConfig).where(eq(adminConfig.key, key));
  const def = DEFINITIONS[key];
  const merged = { ...def.default, ...((row?.value as object) ?? {}) };
  const parsed = def.schema.safeParse(merged);
  const value = (parsed.success ? parsed.data : def.default) as ConfigValue<K>;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function setConfig<K extends ConfigKey>(db: Db, key: K, value: unknown, userId?: string): Promise<ConfigValue<K>> {
  const def = DEFINITIONS[key];
  const current = await getConfig(db, key);
  const parsed = def.schema.parse({ ...current, ...(value as object) }) as ConfigValue<K>;
  await db
    .insert(adminConfig)
    .values({ key, value: parsed, updatedBy: userId })
    .onConflictDoUpdate({ target: adminConfig.key, set: { value: parsed, updatedBy: userId, updatedAt: new Date() } });
  cache.delete(key);
  return parsed;
}

export function clearConfigCache() {
  cache.clear();
}
