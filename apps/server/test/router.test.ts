import { describe, it, expect } from 'vitest';
import { VIDEO_MODELS } from '../src/catalog/video-models';
import { routeVideo, planSegments, DEFAULT_ROUTING_CONFIG, type RoutableModel, type RoutingRequest } from '../src/routing/router';
import { analyzePrompt } from '../src/routing/analyze';

const all = (configured: (p: string) => boolean = () => true): RoutableModel[] =>
  VIDEO_MODELS.map((m) => ({ ...m, enabled: true, providerEnabled: true, configured: configured(m.provider), reliability: 0.95 }));

const req = (over: Partial<RoutingRequest> = {}): RoutingRequest => ({
  mode: 'text-to-video',
  aspectRatio: '9:16',
  durationSec: 10,
  quality: 'balanced',
  nativeAudio: false,
  referenceCount: 0,
  renderPass: 'final',
  analysis: analyzePrompt('A calm ocean at sunset'),
  ...over,
});

describe('routeVideo', () => {
  it('picks the cheapest model that meets the quality bar', () => {
    const d = routeVideo(req(), all());
    expect(d.ok).toBe(true);
    const chosen = d.chosen!;
    expect(chosen.effectiveTier).toBeGreaterThanOrEqual(3);
    // No other qualifying candidate is cheaper.
    for (const alt of d.alternatives.filter((a) => a.effectiveTier >= 3)) {
      expect(alt.expectedCostUsd).toBeGreaterThanOrEqual(chosen.expectedCostUsd);
    }
  });

  it('never routes to unverified, deprecated or discontinued models', () => {
    for (const quality of ['economy', 'balanced', 'high', 'cinematic'] as const) {
      const d = routeVideo(req({ quality }), all());
      expect(['active', 'preview']).toContain(d.chosen?.model.status);
    }
    const rejectedKeys = routeVideo(req(), all()).rejected.map((r) => r.modelKey);
    expect(rejectedKeys).toContain('google:veo-3.1-generate-preview');
    expect(rejectedKeys).toContain('fal:minimax-h3-max-turbo');
  });

  it('requires documented native audio when audio is requested', () => {
    const d = routeVideo(req({ nativeAudio: true }), all());
    expect(d.ok).toBe(true);
    expect(d.chosen!.model.capabilities.nativeAudio).not.toBe('none');
    expect(d.chosen!.audio).toBe(true);
  });

  it('never downgrades the requested resolution', () => {
    const d = routeVideo(req({ minResolution: '1080p', quality: 'economy' }), all());
    expect(d.ok).toBe(true);
    expect(['1080p', '1440p', '4k']).toContain(d.chosen!.resolution);
  });

  it('raises the bar for complex human action scenes in balanced mode', () => {
    const analysis = analyzePrompt('Two detectives chase a thief running across rooftops, tracking shot, he shouts "stop!"');
    expect(analysis.complexity).toBe('high');
    const d = routeVideo(req({ analysis }), all());
    expect(d.requiredTier).toBe(4);
    expect(d.chosen!.effectiveTier).toBeGreaterThanOrEqual(4);
  });

  it('cinematic mode selects a tier-5 model', () => {
    const d = routeVideo(req({ quality: 'cinematic' }), all());
    expect(d.chosen!.effectiveTier).toBe(5);
  });

  it('respects the user budget and offers alternatives instead of overspending', () => {
    const d = routeVideo(req({ quality: 'cinematic', maxCredits: 5 }), all());
    expect(d.ok).toBe(false);
    expect(d.blockers.join(' ')).toMatch(/limit/);
  });

  it('stitches segments when no single clip covers the duration', () => {
    const d = routeVideo(req({ durationSec: 40, quality: 'cinematic' }), all());
    expect(d.ok).toBe(true);
    expect(d.chosen!.segments.length).toBeGreaterThan(1);
    const total = d.chosen!.segments.reduce((s, x) => s + x.durationSec, 0);
    expect(total).toBeCloseTo(40, 1);
  });

  it('uses the image-to-video mode only on capable models', () => {
    const d = routeVideo(req({ mode: 'image-to-video' }), all());
    expect(d.chosen!.model.capabilities.modes).toContain('image-to-video');
  });

  it('crops 4:5 from 9:16 when no model renders 4:5 natively', () => {
    const d = routeVideo(req({ aspectRatio: '4:5' }), all());
    expect(d.ok).toBe(true);
    expect(d.chosen!.cropToTarget).toBe(true);
    expect(d.chosen!.generationAspect).toBe('9:16');
  });

  it('prefers configured providers and flags missing configuration otherwise', () => {
    const onlyLtx = routeVideo(req(), all((p) => p === 'ltx'));
    expect(onlyLtx.chosen!.model.provider).toBe('ltx');
    expect(onlyLtx.requiresConfiguration).toBe(false);
    const none = routeVideo(req(), all(() => false));
    expect(none.ok).toBe(true);
    expect(none.requiresConfiguration).toBe(true);
  });

  it('picks the cheaper provider for the same model family (fal vs Runway Kling)', () => {
    const both = all((p) => p === 'runway' || p === 'fal');
    const d = routeVideo(req({ modelKey: undefined, quality: 'high', minResolution: '1080p', analysis: analyzePrompt('A person walking in Tokyo') }), both);
    expect(d.chosen!.model.family).toBe('kling-3.0-pro');
    expect(d.chosen!.model.provider).toBe('fal');
    expect(d.alternatives.some((a) => a.model.key === 'runway:kling3.0_pro')).toBe(true);
  });

  it('honours manual model selection and reports incompatibility', () => {
    const ok = routeVideo(req({ modelKey: 'runway:kling3.0_pro' }), all());
    expect(ok.chosen!.model.key).toBe('runway:kling3.0_pro');
    const bad = routeVideo(req({ modelKey: 'runway:gen4_turbo' }), all());
    expect(bad.ok).toBe(false);
    expect(bad.blockers[0]).toMatch(/text-to-video/);
  });

  it('draft pass routes to a cheap low-resolution model', () => {
    const final = routeVideo(req(), all());
    const draft = routeVideo(req({ renderPass: 'draft' }), all());
    expect(draft.chosen!.providerCostUsd).toBeLessThanOrEqual(final.chosen!.providerCostUsd);
  });
});

describe('planSegments', () => {
  const veo = VIDEO_MODELS.find((m) => m.key === 'runway:veo3.1')!;
  it('rounds up to the nearest allowed duration', () => {
    expect(planSegments(veo, '720p', 5, DEFAULT_ROUTING_CONFIG).segments).toEqual([{ durationSec: 5, billedDurationSec: 6 }]);
  });
  it('splits long requests evenly', () => {
    const p = planSegments(veo, '720p', 15, DEFAULT_ROUTING_CONFIG);
    expect(p.segments).toHaveLength(2);
    expect(p.segments.every((s) => s.billedDurationSec === 8)).toBe(true);
  });
  it('refuses when segments exceed the configured maximum', () => {
    const p = planSegments(veo, '720p', 60, DEFAULT_ROUTING_CONFIG);
    expect(p.segments).toHaveLength(0);
  });
});
