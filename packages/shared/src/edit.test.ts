import { describe, expect, it } from 'vitest';
import { applyPlanOp, cameraAt, cameraPreset, clipDuration, describeMaskRegion, editMaskSchema, gradeOf, gradePixel, insertShot, moveNodeAfter, removeNode, sequenceOf, swapShotVersion, timelineDuration, timelineSchema, type Timeline } from './index';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const S1 = '10000000-0000-4000-8000-000000000001';
const S2 = '10000000-0000-4000-8000-000000000002';
const S3 = '10000000-0000-4000-8000-000000000003';

const film = (): Timeline =>
  timelineSchema.parse({
    clips: [
      { id: 'c1', assetId: A, shotId: S1, inSec: 0, outSec: 4 },
      { id: 'c2a', assetId: B, shotId: S2, inSec: 0, outSec: 2 },
      { id: 'c2b', assetId: B, shotId: S2, inSec: 2, outSec: 5 },
      { id: 'c3', assetId: C, shotId: S3, inSec: 0, outSec: 6 },
    ],
  });

describe('story graph ⇄ timeline sequence', () => {
  it('groups a split shot into one node and reorders whole shots', () => {
    const t = film();
    expect(sequenceOf(t).map((n) => n.key)).toEqual([S1, S2, S3]);
    const moved = moveNodeAfter(t, S1, S3);
    expect(moved.clips.map((c) => c.id)).toEqual(['c2a', 'c2b', 'c3', 'c1']);
    expect(moveNodeAfter(t, S3, null).clips[0]!.id).toBe('c3');
    expect(moveNodeAfter(t, S2, S2)).toBe(t); // no self-links
  });

  it('removes and re-inserts a shot without touching the others', () => {
    const t = removeNode(film(), S2);
    expect(t.clips.map((c) => c.id)).toEqual(['c1', 'c3']);
    const back = insertShot(t, { shotId: S2, assetId: B, durationSec: 5 }, S1, 'new');
    expect(sequenceOf(back).map((n) => n.key)).toEqual([S1, S2, S3]);
    expect(back.clips[0]).toEqual(t.clips[0]);
  });

  it('switching a shot version only changes that shot', () => {
    const t = film();
    const V = '20000000-0000-4000-8000-000000000001';
    const D = '00000000-0000-4000-8000-00000000000d';
    const next = swapShotVersion(t, S3, { assetId: D, versionId: V, durationSec: 8, previousDurationSec: 6 });
    expect(next.clips.find((c) => c.id === 'c3')).toMatchObject({ assetId: D, versionId: V, inSec: 0, outSec: 8 });
    expect(next.clips.filter((c) => c.shotId !== S3)).toEqual(t.clips.filter((c) => c.shotId !== S3));
    // A trimmed clip keeps its trim when it still fits.
    const short = swapShotVersion(t, S2, { assetId: D, durationSec: 3, previousDurationSec: 5 });
    expect(short.clips.filter((c) => c.shotId === S2).map((c) => [c.inSec, c.outSec])).toEqual([[0, 2], [2, 3]]);
  });
});

describe('clip timing', () => {
  it('speed and freeze frames change the timeline length', () => {
    expect(clipDuration({ inSec: 0, outSec: 4, speed: 2 })).toBe(2);
    expect(clipDuration({ inSec: 1, outSec: 4, freezeSec: 1.5 })).toBe(1.5);
    const t = film();
    t.clips[0]!.speed = 0.5;
    expect(timelineDuration(t)).toBe(8 + 5 + 6);
  });
});

describe('colour grade', () => {
  it('neutral settings leave pixels unchanged', () => {
    const g = gradeOf({});
    expect(gradePixel(g, [0.2, 0.5, 0.8]).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.2, 0.5, 0.8]);
  });
  it('saturation −1 makes grey; warm temperature adds red, removes blue', () => {
    const [r, g, b] = gradePixel(gradeOf({ saturation: -1 }), [0.9, 0.2, 0.1]);
    expect(Math.abs(r - g)).toBeLessThan(1e-3);
    expect(Math.abs(g - b)).toBeLessThan(1e-3);
    const warm = gradePixel(gradeOf({ temperature: 1 }), [0.5, 0.5, 0.5]);
    expect(warm[0]).toBeGreaterThan(0.5);
    expect(warm[2]).toBeLessThan(0.5);
  });
});

describe('2D camera', () => {
  it('interpolates keyframes and keeps the window inside the frame', () => {
    const cam = { keyframes: [{ t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0 }, { t: 4, x: 0.9, y: 0.5, scale: 2, rotation: 0 }], easing: 'linear' as const };
    const mid = cameraAt(cam, 2);
    expect(mid.scale).toBeCloseTo(1.5);
    expect(mid.x).toBeLessThanOrEqual(1 - 0.5 / mid.scale + 1e-9);
    expect(cameraAt(cam, 10)).toMatchObject({ x: 0.75, scale: 2 }); // clamped: half-window 0.25
  });
  it('presets cover the clip duration', () => {
    for (const p of ['push_in', 'pan_left', 'handheld', 'zoom_to'] as const) {
      const c = cameraPreset(p, 5, 0.7, { x: 0.3, y: 0.3 });
      expect(c.keyframes[0]!.t).toBe(0);
      expect(c.keyframes.at(-1)!.t).toBe(5);
    }
    expect(cameraAt(cameraPreset('push_in', 5, 1), 5).scale).toBeCloseTo(1.45);
  });
});

describe('AI assistant plan operations', () => {
  it('applies deterministic operations to the right shot only', () => {
    const t = film();
    const id = () => 'x';
    const trimmed = applyPlanOp(t, { op: 'trim', shot: 3, durationSec: 3 }, id);
    expect(trimmed.clips.find((c) => c.id === 'c3')!.outSec).toBe(3);
    expect(trimmed.clips.filter((c) => c.id !== 'c3')).toEqual(t.clips.filter((c) => c.id !== 'c3'));
    const fade = applyPlanOp(t, { op: 'transition', shot: 2, type: 'dissolve', durationSec: 0.8 }, id);
    expect(fade.clips.find((c) => c.id === 'c2b')!.transition).toEqual({ type: 'dissolve', durationSec: 0.8 });
    expect(fade.clips.find((c) => c.id === 'c2a')!.transition).toBeUndefined();
    const graded = applyPlanOp(applyPlanOp(t, { op: 'color', shot: 1, adjust: { contrast: 0.2 } }, id), { op: 'match_color', shot: 3, fromShot: 1 }, id);
    expect(graded.clips.find((c) => c.id === 'c3')!.adjust?.contrast).toBe(0.2);
    expect(applyPlanOp(t, { op: 'ai_edit', shot: 1, mode: 'fix', instruction: 'fix the hand' }, id)).toBe(t);
  });
});

describe('masks', () => {
  it('describes where the selection is for the model prompt', () => {
    const m = editMaskSchema.parse({ rects: [{ x: 0.7, y: 0.7, w: 0.15, h: 0.15 }] });
    expect(describeMaskRegion(m)).toBe('a small area in the bottom-right of the frame');
    expect(describeMaskRegion(editMaskSchema.parse({}))).toBeNull();
  });
});
