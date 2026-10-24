import { describe, it, expect } from 'vitest';
import { composePrompt, fillTemplate, getTemplate, movieBriefSchema, photoTokensIn, scaleBeats, TEMPLATES, timelineDuration, timelineSchema, videoSpecSchema } from './index';

describe('templates', () => {
  it('ships 19 templates with unique keys and real beats', () => {
    expect(TEMPLATES).toHaveLength(19);
    expect(new Set(TEMPLATES.map((t) => t.key)).size).toBe(19);
    expect(TEMPLATES.every((t) => t.beats.length > 0 && t.promptPattern.includes('{{'))).toBe(true);
  });
  it('fills patterns and cleans empty placeholders', () => {
    expect(fillTemplate('{{product}}. {{benefit}}. Glossy light.', { product: 'Mug', benefit: '' })).toBe('Mug. Glossy light.');
  });
  it('scales beats to the requested total', () => {
    const beats = scaleBeats(getTemplate('product-commercial')!.beats, 30);
    expect(beats.reduce((s, b) => s + b.seconds, 0)).toBe(30);
  });
});

describe('prompt composition', () => {
  it('appends directives once and skips duplicates', () => {
    const p = composePrompt('A car at night', { camera: 'dolly_in', style: 'cinematic' });
    expect(p).toContain('dolly-in');
    expect(p).toContain('film grain');
    expect(composePrompt('A car, slow dolly-in camera move toward the subject', { camera: 'dolly_in' })).not.toMatch(/dolly-in.*dolly-in/);
  });
  it('can leave the camera to a real camera-control API', () => {
    expect(composePrompt('A car', { camera: 'dolly_in' }, { includeCamera: false })).toBe('A car');
  });
});

describe('schemas', () => {
  it('video spec defaults: 9:16, 10s, balanced, automatic', () => {
    const s = videoSpecSchema.parse({ prompt: 'A cat' });
    expect([s.aspectRatio, s.durationSec, s.quality, s.modelKey, s.enhancePrompt]).toEqual(['9:16', 10, 'balanced', undefined, true]);
  });
  it('movie photo references: tokens are validated and unique', () => {
    const ok = movieBriefSchema.parse({ idea: 'A hero photo1 at home photo2', references: [{ token: 'photo1', assetId: '11111111-1111-4111-8111-111111111111' }] });
    expect(ok.references).toHaveLength(1);
    expect(() => movieBriefSchema.parse({ idea: 'A hero photo1 at home', references: [{ token: 'pic1', assetId: '11111111-1111-4111-8111-111111111111' }] })).toThrow();
    const dup = { token: 'photo1', assetId: '11111111-1111-4111-8111-111111111111' };
    expect(() => movieBriefSchema.parse({ idea: 'A hero photo1 at home', references: [dup, dup] })).toThrow();
    expect(photoTokensIn('photo2 and Photo2 and photo12 but not photo13')).toEqual(['photo2', 'photo12']);
  });
  it('timeline duration accounts for transition overlaps', () => {
    const t = timelineSchema.parse({
      clips: [
        { id: 'a', assetId: '11111111-1111-4111-8111-111111111111', inSec: 0, outSec: 4, transition: { type: 'fade', durationSec: 1 } },
        { id: 'b', assetId: '11111111-1111-4111-8111-111111111111', inSec: 1, outSec: 3 },
      ],
    });
    expect(timelineDuration(t)).toBe(5);
  });
});
