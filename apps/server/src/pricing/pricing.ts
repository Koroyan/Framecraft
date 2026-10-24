import type { PricingConfidence } from '../catalog/types';

/** Admin-configurable pricing rules (stored in admin_config.pricing). */
export type PricingRules = {
  /** Retail value of one credit in USD. */
  creditValueUsd: number;
  /** Markup applied to provider + processing cost. 0.6 = +60%. */
  markup: number;
  /** Minimum gross margin per job. 0.35 = 35%. */
  minMargin: number;
  /** Estimated platform processing cost per output second (FFmpeg, storage, egress). */
  processingUsdPerSecond: number;
  /** Extra buffer when provider pricing is only partially confirmed. */
  partialPricingBuffer: number;
  /** Unverified pricing is never charged automatically unless explicitly allowed. */
  allowUnverifiedPricing: boolean;
  minimumCredits: number;
};

export const DEFAULT_PRICING_RULES: PricingRules = {
  creditValueUsd: 0.01,
  markup: 0.6,
  minMargin: 0.35,
  processingUsdPerSecond: 0.0008,
  partialPricingBuffer: 0.15,
  allowUnverifiedPricing: false,
  minimumCredits: 1,
};

export type CreditQuote = {
  credits: number;
  providerCostUsd: number;
  processingCostUsd: number;
  revenueUsd: number;
  marginPct: number;
  confidence: PricingConfidence;
  blockedReason?: string;
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Convert an estimated provider cost into customer credits.
 *
 * credits = ceil((provider + processing) × buffer × (1 + markup) / creditValue),
 * then raised if needed so the job keeps at least `minMargin` gross margin.
 */
export function quoteCredits(
  providerCostUsd: number,
  outputSeconds: number,
  confidence: PricingConfidence,
  rules: PricingRules = DEFAULT_PRICING_RULES,
): CreditQuote {
  const processingCostUsd = round4(outputSeconds * rules.processingUsdPerSecond);
  const buffer = confidence === 'partial' ? 1 + rules.partialPricingBuffer : confidence === 'unverified' ? 1 + rules.partialPricingBuffer * 2 : 1;
  const costBasis = (providerCostUsd + processingCostUsd) * buffer;
  let credits = Math.ceil(round4((costBasis * (1 + rules.markup)) / rules.creditValueUsd));

  // Enforce minimum margin against the *unbuffered* real cost estimate.
  const realCost = providerCostUsd + processingCostUsd;
  const minCreditsForMargin = rules.minMargin < 1 ? Math.ceil(round4(realCost / ((1 - rules.minMargin) * rules.creditValueUsd))) : credits;
  credits = Math.max(credits, minCreditsForMargin, rules.minimumCredits);

  const revenueUsd = round4(credits * rules.creditValueUsd);
  const marginPct = revenueUsd > 0 ? round4((revenueUsd - realCost) / revenueUsd) : 0;
  const quote: CreditQuote = { credits, providerCostUsd: round4(providerCostUsd), processingCostUsd, revenueUsd, marginPct, confidence };
  if (confidence === 'unverified' && !rules.allowUnverifiedPricing) {
    quote.blockedReason = 'Provider pricing for this model is unverified; an administrator must verify it before customers can be charged.';
  }
  return quote;
}

/**
 * Credits actually charged after the provider reports its real cost.
 * Customers are never charged more than they authorised (the reservation);
 * if the real cost is lower they pay the lower recomputed price.
 */
export function reconcileCredits(
  reservedCredits: number,
  actualProviderCostUsd: number | null,
  outputSeconds: number,
  rules: PricingRules = DEFAULT_PRICING_RULES,
): { charge: number; release: number; overrunUsd: number } {
  if (actualProviderCostUsd == null) return { charge: reservedCredits, release: 0, overrunUsd: 0 };
  const recomputed = quoteCredits(actualProviderCostUsd, outputSeconds, 'verified', rules).credits;
  const charge = Math.min(reservedCredits, recomputed);
  const authorisedUsd = reservedCredits * rules.creditValueUsd;
  const overrunUsd = recomputed > reservedCredits ? round4(recomputed * rules.creditValueUsd - authorisedUsd) : 0;
  return { charge, release: reservedCredits - charge, overrunUsd };
}

export function creditsToUsd(credits: number, rules: PricingRules = DEFAULT_PRICING_RULES): number {
  return round4(credits * rules.creditValueUsd);
}
