import { QUALITY_MODE_INFO, RESOLUTION_RANK, type AspectRatio, type GenerationMode, type QualityMode, type Resolution } from '@framecraft/shared';
import type { CatalogVideoModel, PriceRow, PricingConfidence } from '../catalog/types';
import { quoteCredits, type PricingRules, DEFAULT_PRICING_RULES } from '../pricing/pricing';
import type { PromptAnalysis } from './analyze';

/** Runtime view of a catalog model (DB state merged over the static catalog). */
export type RoutableModel = CatalogVideoModel & {
  enabled: boolean;
  providerEnabled: boolean;
  /** Credentials for the provider are present. */
  configured: boolean;
  /** Mean of real evaluations, when enough exist. */
  measuredTier?: number;
  /** Historical success rate (0–1). */
  reliability: number;
};

export type RoutingConfig = {
  tierThresholds: Record<QualityMode, number>;
  /** Raise the quality bar one tier for complex shots in Economy/Balanced. */
  complexityBump: boolean;
  allowSegmentStitching: boolean;
  maxSegments: number;
  /** Quality penalty applied to stitched plans that contain people (continuity risk). */
  stitchingPenalty: number;
  /** A stitched plan only beats one continuous clip when it saves at least this fraction. */
  minStitchSavings: number;
};

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  tierThresholds: { economy: 2, balanced: 3, high: 4, cinematic: 5 },
  complexityBump: true,
  allowSegmentStitching: true,
  maxSegments: 4,
  stitchingPenalty: 0.5,
  minStitchSavings: 0.4,
};

export type RoutingRequest = {
  mode: GenerationMode;
  aspectRatio: AspectRatio;
  durationSec: number;
  quality: QualityMode;
  minResolution?: Resolution;
  nativeAudio: boolean;
  referenceCount: number;
  modelKey?: string;
  maxCredits?: number;
  renderPass: 'draft' | 'final';
  analysis: PromptAnalysis;
};

export type SegmentPlan = { durationSec: number; billedDurationSec: number };

export type Candidate = {
  model: RoutableModel;
  resolution: Resolution;
  /** Aspect requested from the model; differs from target when we crop (e.g. 4:5 from 9:16). */
  generationAspect: AspectRatio;
  cropToTarget: boolean;
  audio: boolean;
  segments: SegmentPlan[];
  providerCostUsd: number;
  expectedCostUsd: number;
  credits: number;
  effectiveTier: number;
  qualitySource: 'measured' | 'provisional';
  pricingConfidence: PricingConfidence;
  notes: string[];
};

export type RoutingDecision = {
  ok: boolean;
  chosen?: Candidate;
  requiredTier: number;
  alternatives: Candidate[];
  rejected: { modelKey: string; modelName: string; reasons: string[] }[];
  explanation: string[];
  warnings: string[];
  blockers: string[];
  requiresConfiguration: boolean;
};

const ROUTABLE_STATUSES = new Set(['active', 'preview']);

function priceFor(model: CatalogVideoModel, resolution: Resolution, audio: boolean): PriceRow | undefined {
  return (
    model.pricing.find((p) => p.resolution === resolution && p.audio === audio) ??
    model.pricing.find((p) => p.resolution === resolution && p.audio === 'any')
  );
}

function allowedDurations(model: CatalogVideoModel, resolution: Resolution): number[] | undefined {
  return model.capabilities.durationsByResolution?.[resolution] ?? model.capabilities.durations.allowed;
}

/** Plan clip segments covering the requested duration on this model. */
export function planSegments(
  model: CatalogVideoModel,
  resolution: Resolution,
  durationSec: number,
  cfg: RoutingConfig,
): { segments: SegmentPlan[]; reason?: string } {
  const { min, max } = model.capabilities.durations;
  const allowed = allowedDurations(model, resolution);
  const maxLen = allowed ? Math.max(...allowed) : max;

  const fit = (target: number): number | undefined => {
    if (allowed) return allowed.filter((d) => d >= target).sort((a, b) => a - b)[0] ?? undefined;
    if (target > max) return undefined;
    return Math.max(min, Math.ceil(target));
  };

  const single = fit(durationSec);
  if (single !== undefined) return { segments: [{ durationSec, billedDurationSec: single }] };

  if (!cfg.allowSegmentStitching) return { segments: [], reason: `max ${maxLen}s per clip` };
  const n = Math.ceil(durationSec / maxLen);
  if (n > cfg.maxSegments) return { segments: [], reason: `would need ${n} clips (max ${cfg.maxSegments})` };
  const each = durationSec / n;
  const billed = fit(each);
  if (billed === undefined) return { segments: [], reason: `cannot split ${durationSec}s into allowed lengths` };
  const segments: SegmentPlan[] = [];
  let remaining = durationSec;
  for (let i = 0; i < n; i++) {
    const d = i === n - 1 ? Math.round(remaining * 100) / 100 : Math.round(each * 100) / 100;
    remaining -= d;
    segments.push({ durationSec: d, billedDurationSec: billed });
  }
  return { segments };
}

function requiredTierFor(req: RoutingRequest, cfg: RoutingConfig): number {
  if (req.renderPass === 'draft') return 2;
  let tier = cfg.tierThresholds[req.quality];
  if (cfg.complexityBump && req.analysis.complexity === 'high' && (req.quality === 'economy' || req.quality === 'balanced')) tier += 1;
  return Math.min(5, tier);
}

function targetMinResolution(req: RoutingRequest): Resolution {
  if (req.minResolution) return req.minResolution;
  if (req.renderPass === 'draft') return '480p';
  return QUALITY_MODE_INFO[req.quality].defaultResolution;
}

function evaluateModel(
  model: RoutableModel,
  req: RoutingRequest,
  cfg: RoutingConfig,
  rules: PricingRules,
): { candidate?: Candidate; reasons: string[] } {
  const reasons: string[] = [];
  const c = model.capabilities;
  if (!ROUTABLE_STATUSES.has(model.status)) reasons.push(`status: ${model.status}`);
  if (!model.enabled) reasons.push('disabled by admin');
  if (!model.providerEnabled) reasons.push('provider disabled');
  if (!c.modes.includes(req.mode)) reasons.push(`does not support ${req.mode}`);
  if (req.nativeAudio && c.nativeAudio === 'none') reasons.push('no documented native audio');
  if (req.referenceCount > 0 && req.mode === 'reference-to-video' && req.referenceCount > c.maxReferenceImages)
    reasons.push(`max ${c.maxReferenceImages} reference images`);

  // Aspect ratio
  let generationAspect: AspectRatio = req.aspectRatio;
  let cropToTarget = false;
  const imageDriven = req.mode !== 'text-to-video' && c.aspectFollowsImage;
  if (!imageDriven && !c.aspectRatios.includes(req.aspectRatio)) {
    if (req.aspectRatio === '4:5' && c.aspectRatios.includes('9:16')) {
      generationAspect = '9:16';
      cropToTarget = true;
    } else reasons.push(`no ${req.aspectRatio} output`);
  }

  // Resolution: lowest supported tier that meets the requested minimum (never downgrade).
  const minRes = targetMinResolution(req);
  const resolution = [...c.resolutions].sort((a, b) => RESOLUTION_RANK[a] - RESOLUTION_RANK[b]).find((r) => RESOLUTION_RANK[r] >= RESOLUTION_RANK[minRes]);
  if (!resolution) reasons.push(`max resolution below ${minRes}`);

  if (reasons.length || !resolution) return { reasons };

  const audio = req.nativeAudio || c.nativeAudio === 'always';
  const price = priceFor(model, resolution, audio);
  if (!price) return { reasons: [`no price for ${resolution}${audio ? ' with audio' : ''}`] };

  const plan = planSegments(model, resolution, req.durationSec, cfg);
  if (!plan.segments.length) return { reasons: [plan.reason ?? 'duration not supported'] };

  const refs = req.mode === 'reference-to-video' ? req.referenceCount : req.mode === 'text-to-video' ? 0 : 1;
  let providerCostUsd = 0;
  for (const s of plan.segments) {
    const segCost = price.usdPerSecond * s.billedDurationSec + (price.usdPerReference ?? 0) * refs;
    providerCostUsd += Math.max(segCost, price.minimumUsd ?? 0);
  }
  providerCostUsd = Math.round(providerCostUsd * 10000) / 10000;
  const expectedCostUsd = providerCostUsd / Math.max(0.5, model.reliability);
  const quote = quoteCredits(providerCostUsd, req.durationSec, model.pricingConfidence, rules);
  if (quote.blockedReason) return { reasons: ['pricing unverified'] };

  const baseTier = model.measuredTier ?? model.qualityTier;
  const stitched = plan.segments.length > 1;
  const effectiveTier = stitched && req.analysis.humans ? baseTier - cfg.stitchingPenalty : baseTier;

  const notes: string[] = [];
  if (stitched) notes.push(`${plan.segments.length} clips of ≤${Math.max(...plan.segments.map((s) => s.billedDurationSec))}s stitched with FFmpeg`);
  const billedTotal = plan.segments.reduce((s, p) => s + p.billedDurationSec, 0);
  if (billedTotal > req.durationSec + 0.01) notes.push(`model renders ${billedTotal}s; trimmed to ${req.durationSec}s`);
  if (cropToTarget) notes.push(`generated at 9:16 and cropped to ${req.aspectRatio}`);

  return {
    reasons: [],
    candidate: {
      model,
      resolution,
      generationAspect,
      cropToTarget,
      audio,
      segments: plan.segments,
      providerCostUsd,
      expectedCostUsd,
      credits: quote.credits,
      effectiveTier,
      qualitySource: model.measuredTier !== undefined ? 'measured' : 'provisional',
      pricingConfidence: model.pricingConfidence,
      notes,
    },
  };
}

const byCost = (a: Candidate, b: Candidate) =>
  a.expectedCostUsd - b.expectedCostUsd ||
  b.effectiveTier - a.effectiveTier ||
  b.model.reliability - a.model.reliability ||
  Number(b.model.configured) - Number(a.model.configured);

/**
 * Choose the least expensive generation strategy that satisfies every hard
 * requirement and the quality bar. Never silently downgrades: if nothing
 * qualifies, returns ok=false with blockers and cheaper/lower options.
 */
export function routeVideo(
  req: RoutingRequest,
  models: RoutableModel[],
  cfg: RoutingConfig = DEFAULT_ROUTING_CONFIG,
  rules: PricingRules = DEFAULT_PRICING_RULES,
): RoutingDecision {
  const requiredTier = requiredTierFor(req, cfg);
  const minRes = targetMinResolution(req);
  const explanation: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const rejected: RoutingDecision['rejected'] = [];
  const eligible: Candidate[] = [];

  explanation.push(
    `Needs ${req.mode.replace(/-/g, ' ')} · ${req.aspectRatio} · ${req.durationSec}s · ≥${minRes}${req.nativeAudio ? ' · native audio' : ''}${
      req.referenceCount ? ` · ${req.referenceCount} reference image(s)` : ''
    }`,
  );
  if (req.analysis.signals.length) explanation.push(`Detected: ${req.analysis.signals.join(', ')} (complexity ${req.analysis.complexity})`);

  const pool = req.modelKey ? models.filter((m) => m.key === req.modelKey) : models;
  if (req.modelKey && !pool.length) {
    return { ok: false, requiredTier, alternatives: [], rejected: [], explanation, warnings, blockers: [`Unknown model ${req.modelKey}`], requiresConfiguration: false };
  }

  for (const m of pool) {
    const r = evaluateModel(m, req, cfg, rules);
    if (r.candidate) eligible.push(r.candidate);
    else rejected.push({ modelKey: m.key, modelName: m.displayName, reasons: r.reasons });
  }

  if (req.modelKey) {
    const chosen = eligible[0];
    if (!chosen) {
      blockers.push(`${pool[0]!.displayName} cannot fulfil this request: ${rejected[0]?.reasons.join('; ')}`);
      return { ok: false, requiredTier, alternatives: [], rejected, explanation, warnings, blockers, requiresConfiguration: false };
    }
    explanation.push(`Manual selection: ${chosen.model.displayName} at ${chosen.resolution}`);
    if (chosen.effectiveTier < requiredTier) warnings.push(`Selected model is below the usual ${req.quality} quality bar (tier ${chosen.effectiveTier} < ${requiredTier}).`);
    if (req.maxCredits && chosen.credits > req.maxCredits) {
      blockers.push(`Estimated ${chosen.credits} credits exceeds your limit of ${req.maxCredits}.`);
      return { ok: false, chosen, requiredTier, alternatives: [], rejected, explanation, warnings, blockers, requiresConfiguration: !chosen.model.configured };
    }
    return { ok: true, chosen, requiredTier, alternatives: [], rejected, explanation, warnings: [...warnings, ...chosen.notes], blockers, requiresConfiguration: !chosen.model.configured };
  }

  explanation.push(`Quality target: tier ≥ ${requiredTier} (${req.renderPass === 'draft' ? 'draft preview' : QUALITY_MODE_INFO[req.quality].label}${
    requiredTier > cfg.tierThresholds[req.quality] && req.renderPass !== 'draft' ? ', raised for a complex shot' : ''
  })`);

  const qualifying = eligible.filter((c) => c.effectiveTier >= requiredTier);
  // Live generation only uses providers with credentials; estimates fall back to the full catalog.
  const configured = qualifying.filter((c) => c.model.configured);
  const pickFrom = configured.length ? configured : qualifying;
  const requiresConfiguration = !configured.length && qualifying.length > 0;
  pickFrom.sort(byCost);

  let chosen = pickFrom[0];
  if (chosen && chosen.segments.length > 1) {
    const single = pickFrom.find((c) => c.segments.length === 1);
    if (single && chosen.expectedCostUsd > single.expectedCostUsd * (1 - cfg.minStitchSavings)) {
      explanation.push('Preferred one continuous clip over stitched segments (the saving was too small to justify a seam).');
      pickFrom.splice(pickFrom.indexOf(single), 1);
      pickFrom.unshift(single);
      chosen = single;
    }
  }
  if (chosen && req.maxCredits && chosen.credits > req.maxCredits) {
    blockers.push(`The cheapest model meeting ${QUALITY_MODE_INFO[req.quality].label} quality needs ${chosen.credits} credits, above your limit of ${req.maxCredits}.`);
    const affordable = eligible.filter((c) => c.credits <= req.maxCredits!).sort((a, b) => b.effectiveTier - a.effectiveTier || a.credits - b.credits);
    return {
      ok: false,
      chosen,
      requiredTier,
      alternatives: affordable.slice(0, 3),
      rejected,
      explanation,
      warnings,
      blockers,
      requiresConfiguration,
    };
  }

  if (!chosen) {
    const best = [...eligible].sort((a, b) => b.effectiveTier - a.effectiveTier || a.expectedCostUsd - b.expectedCostUsd);
    if (best.length) {
      blockers.push(
        `No available model meets the ${QUALITY_MODE_INFO[req.quality].label} quality bar for this request. The best eligible option is tier ${best[0]!.effectiveTier}.`,
      );
    } else {
      blockers.push('No available model supports this combination of settings.');
      const common = summarizeRejections(rejected);
      if (common) blockers.push(common);
    }
    return { ok: false, requiredTier, alternatives: best.slice(0, 3), rejected, explanation, warnings, blockers, requiresConfiguration: false };
  }

  explanation.push(
    `Chose ${chosen.model.displayName} at ${chosen.resolution}: the lowest-cost option meeting the target ($${chosen.providerCostUsd.toFixed(2)} provider cost, tier ${chosen.effectiveTier} ${chosen.qualitySource}).`,
  );
  const alternatives = pickFrom.slice(1, 4);
  const cheaperLower = eligible.filter((c) => c.effectiveTier < requiredTier && c.expectedCostUsd < chosen!.expectedCostUsd).sort(byCost)[0];
  if (cheaperLower) alternatives.push(cheaperLower);
  if (chosen.qualitySource === 'provisional') warnings.push('Quality tiers are provisional until enough real evaluations are recorded.');
  if (chosen.pricingConfidence !== 'verified') warnings.push('Provider pricing for this model is partially confirmed; a safety buffer is included in the estimate.');
  warnings.push(...chosen.notes);
  if (requiresConfiguration) warnings.push(`${chosen.model.provider} API credentials are not configured yet — live generation is unavailable for this model.`);

  return { ok: true, chosen, requiredTier, alternatives, rejected, explanation, warnings, blockers, requiresConfiguration };
}

function summarizeRejections(rejected: RoutingDecision['rejected']): string | undefined {
  const counts = new Map<string, number>();
  for (const r of rejected) for (const reason of r.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r]) => r);
  return top.length ? `Most common limits: ${top.join('; ')}.` : undefined;
}

export function inferMode(spec: { imageAssetId?: string; endImageAssetId?: string; referenceAssetIds?: string[] }): GenerationMode {
  if (spec.imageAssetId && spec.endImageAssetId) return 'first-last-frame';
  if (spec.imageAssetId) return 'image-to-video';
  if (spec.referenceAssetIds?.length) return 'reference-to-video';
  return 'text-to-video';
}
