import { describe, it, expect } from 'vitest';
import { quoteCredits, reconcileCredits, DEFAULT_PRICING_RULES } from '../src/pricing/pricing';

describe('quoteCredits', () => {
  it('applies markup and keeps the minimum margin', () => {
    const q = quoteCredits(1.0, 10, 'verified');
    // (1.00 + 0.008) * 1.6 / 0.01 = 161.28 -> 162
    expect(q.credits).toBe(162);
    expect(q.marginPct).toBeGreaterThanOrEqual(DEFAULT_PRICING_RULES.minMargin);
  });

  it('enforces the minimum margin even with zero markup', () => {
    const q = quoteCredits(1.0, 10, 'verified', { ...DEFAULT_PRICING_RULES, markup: 0, minMargin: 0.4 });
    expect(q.marginPct).toBeGreaterThanOrEqual(0.4);
  });

  it('adds a buffer for partially confirmed pricing', () => {
    expect(quoteCredits(1, 10, 'partial').credits).toBeGreaterThan(quoteCredits(1, 10, 'verified').credits);
  });

  it('blocks unverified pricing unless an admin allows it', () => {
    expect(quoteCredits(1, 10, 'unverified').blockedReason).toBeDefined();
    expect(quoteCredits(1, 10, 'unverified', { ...DEFAULT_PRICING_RULES, allowUnverifiedPricing: true }).blockedReason).toBeUndefined();
  });

  it('never returns fewer than the minimum credits', () => {
    expect(quoteCredits(0, 0, 'verified').credits).toBe(1);
  });
});

describe('reconcileCredits', () => {
  it('charges the lower actual price and releases the rest', () => {
    const r = reconcileCredits(200, 0.5, 10);
    expect(r.charge).toBeLessThan(200);
    expect(r.charge + r.release).toBe(200);
  });
  it('never charges more than reserved and reports overruns', () => {
    const r = reconcileCredits(50, 5, 10);
    expect(r.charge).toBe(50);
    expect(r.release).toBe(0);
    expect(r.overrunUsd).toBeGreaterThan(0);
  });
  it('charges the reservation when the provider reports no cost', () => {
    expect(reconcileCredits(80, null, 10)).toEqual({ charge: 80, release: 0, overrunUsd: 0 });
  });
});
