import { describe, expect, it } from 'vitest';
import { applyPlanOp, rippleDelete } from './edit';
import { applyTransform, lostSpans, maskTransformAt, mergeTrack, objectActiveAt, objectColorFunction, objectEditSchema } from './objects';
import { quickPlan } from './quick';
import { prepareFrame, regionAt, selectFrom, smartSelect } from './segment';
import { timelineSchema, type Timeline } from './schemas';
import { hexToRgb, rgbToHsl } from './grade';

// ------------------------------------------------------------------ synthetic frames

/** A frame with a shaded red "jacket" rectangle on a textured beige wall and a grey floor. */
function jacketFrame(w = 200, h = 300, box = { x0: 60, y0: 90, x1: 140, y1: 210 }) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 10;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r: number, g: number, b: number;
      if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) {
        // Folds: brightness varies by 35 % across the jacket, the hue stays red.
        const shade = 0.75 + 0.25 * Math.sin((x - box.x0) / 6) * Math.cos((y - box.y0) / 9);
        [r, g, b] = [205 * shade, 35 * shade, 40 * shade];
      } else if (y > 240) [r, g, b] = [118, 118, 122];
      else [r, g, b] = [214, 196, 168];
      data[i] = r + noise();
      data[i + 1] = g + noise();
      data[i + 2] = b + noise();
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

const iou = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
};

describe('smart select', () => {
  it('selects a shaded coloured object from one click and outlines it', () => {
    const img = jacketFrame();
    const r = smartSelect(img, 100, 150)!;
    expect(r).not.toBeNull();
    const truth = { x0: 60 / 200, y0: 90 / 300, x1: 140 / 200, y1: 210 / 300 };
    expect(iou(r.bounds, truth)).toBeGreaterThan(0.9);
    expect(r.area).toBeGreaterThan(0.13);
    expect(r.area).toBeLessThan(0.19);
    expect(r.polygon.length).toBeGreaterThanOrEqual(4);
    expect(r.polygon.length).toBeLessThanOrEqual(180);
    // The swatch is red.
    const [h, s] = rgbToHsl(...hexToRgb(r.color));
    expect(Math.min(h, 360 - h)).toBeLessThan(15);
    expect(s).toBeGreaterThan(0.4);
  });

  it('selects the wall when the wall is clicked, without leaking into the jacket', () => {
    const img = jacketFrame();
    const r = smartSelect(img, 20, 30)!;
    // Wall = everything above the floor minus the jacket.
    expect(r.area).toBeGreaterThan(0.6);
    expect(r.area).toBeLessThan(0.82);
  });

  it('tightness moves the edge without recomputing', () => {
    const p = prepareFrame(jacketFrame());
    const sel = selectFrom(p, 100, 150);
    const tight = regionAt(p, sel, sel.auto * 0.4);
    const auto = regionAt(p, sel, sel.auto)!;
    expect(tight === null || tight.area <= auto.area).toBe(true);
  });
});

// ------------------------------------------------------------------ object edits

const T = (extra: Partial<Timeline> = {}) =>
  timelineSchema.parse({
    aspectRatio: '9:16',
    clips: [
      { id: 'a', assetId: '00000000-0000-4000-8000-000000000001', inSec: 0, outSec: 4 },
      { id: 'b', assetId: '00000000-0000-4000-8000-000000000002', inSec: 2, outSec: 8 },
    ],
    ...extra,
  });

describe('object edits', () => {
  const obj = objectEditSchema.parse({
    id: 'o1',
    name: 'Jacket',
    mask: { polygons: [{ points: [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]] }], track: { points: [{ t: 1, dx: 0, dy: 0 }, { t: 2, dx: 0.1, dy: 0, s: 2 }] } },
    atSec: 1,
    startSec: 1,
    endSec: 2,
    color: '#CC2233',
    effects: [{ type: 'recolor', from: '#CC2233', to: '#2563EB' }],
  });

  it('moves and scales the selection with its track', () => {
    const tr = maskTransformAt(obj.mask, 2);
    expect(tr.cx).toBeCloseTo(0.5);
    expect(applyTransform(tr, 0.6, 0.5)[0]).toBeCloseTo(0.5 + 0.1 * 2 + 0.1); // scaled about the centre, then moved
    const mid = maskTransformAt(obj.mask, 1.5);
    expect(mid.s).toBeCloseTo(1.5);
  });

  it('is active only in its time range', () => {
    expect(objectActiveAt(obj, 0.5)).toBe(false);
    expect(objectActiveAt(obj, 1.5)).toBe(true);
    expect(objectActiveAt({ ...obj, enabled: false }, 1.5)).toBe(false);
  });

  it('recolours the object colour and leaves other colours alone', () => {
    const fn = objectColorFunction(obj.effects)!;
    const red = fn(hexToRgb('#CC2233'));
    const [h] = rgbToHsl(...red);
    expect(h).toBeGreaterThan(200);
    expect(h).toBeLessThan(240);
    const beige = hexToRgb('#D6C4A8');
    const out = fn(beige);
    expect(Math.abs(out[0] - beige[0]) + Math.abs(out[1] - beige[1]) + Math.abs(out[2] - beige[2])).toBeLessThan(0.02);
  });

  it('marks uncertain track frames and merges a correction', () => {
    const m = { ...obj.mask, track: { smoothing: 0.3, points: [{ t: 0, dx: 0, dy: 0, conf: 1 }, { t: 0.5, dx: 0.1, dy: 0, conf: 0.2 }, { t: 0.6, dx: 0.1, dy: 0, conf: 0.3 }, { t: 1, dx: 0.2, dy: 0, conf: 0.9 }] } };
    expect(lostSpans(m)).toEqual([{ start: 0.5, end: 0.6 }]);
    const merged = mergeTrack(m.track, 0.5, { smoothing: 0.3, points: [{ t: 0.5, dx: 0, dy: 0, conf: 1 }, { t: 1, dx: 0.05, dy: 0, conf: 1 }] }, { dx: 0.3, dy: 0.1, s: 1 });
    expect(merged.points.map((p) => p.t)).toEqual([0, 0.5, 1]);
    expect(merged.points[2]!.dx).toBeCloseTo(0.35);
    expect(merged.points[2]!.dy).toBeCloseTo(0.1);
  });

  it('old projects without objects still parse; new ones round-trip', () => {
    expect(T().clips[0]!.objects).toBeUndefined();
    const t = T({ clips: [{ ...T().clips[0]!, objects: [obj] }] });
    expect(timelineSchema.parse(JSON.parse(JSON.stringify(t))).clips[0]!.objects![0]!.effects[0]!.type).toBe('recolor');
  });
});

// ------------------------------------------------------------------ ripple delete + plan ops

describe('ripple delete', () => {
  it('cuts inside one clip and shifts later items left', () => {
    const t = T({ layers: [{ id: 'l1', name: 'Text', kind: 'text', track: 5, startSec: 6, endSec: 7, text: { content: 'Hi' } }] as never, subtitles: [{ id: 's1', startSec: 0.5, endSec: 1.5, text: 'x' }] });
    let n = 0;
    const out = rippleDelete(t, 1, 2, () => `new${n++}`);
    // Clip a (0–4 s) loses 1–2 s: two pieces 0–1 and 2–4.
    expect(out.clips.map((c) => [c.inSec, c.outSec])).toEqual([[0, 1], [2, 4], [2, 8]]);
    expect(out.layers[0]!.startSec).toBeCloseTo(5);
    expect(out.subtitles[0]!.endSec).toBeCloseTo(1);
  });

  it('cuts across a clip boundary', () => {
    const out = rippleDelete(T(), 3, 5, () => 'x');
    // a: 0–4 → 0–3 ; b (timeline 4–10 = source 2–8) loses timeline 4–5 → source 3–8
    expect(out.clips.map((c) => [c.inSec, c.outSec])).toEqual([[0, 3], [3, 8]]);
  });
});

describe('instant assistant', () => {
  const ctx = { clipId: 'a', clipIndex: 0, playhead: 1 };
  it('understands common requests in English, Georgian and Russian', () => {
    expect(quickPlan('Make the music quieter', ctx)!.ops).toEqual([{ op: 'volume', target: 'music', factor: 0.6 }]);
    expect(quickPlan('მუსიკა ჩუმად გახადე', ctx)!.ops[0]).toMatchObject({ op: 'volume', target: 'music' });
    expect(quickPlan('музыку потише', ctx)!.ops[0]).toMatchObject({ op: 'volume', target: 'music', factor: 0.6 });
    expect(quickPlan('Make this video look more cinematic', ctx)!.ops).toEqual([{ op: 'look', clipIds: [], key: 'cinematic' }]);
    expect(quickPlan('Make it look cinematic', ctx)!.ops).toEqual([{ op: 'look', clipIds: [], key: 'cinematic' }]);
    expect(quickPlan('make this clip black and white', ctx)!.ops).toEqual([{ op: 'look', clipIds: ['a'], key: 'bw' }]);
    expect(quickPlan('Make the whole advertisement feel more premium', ctx)!.ops).toEqual([{ op: 'look', clipIds: [], key: 'luxury' }]);
  });

  it('applies "this" to the selected object', () => {
    const o = { ...ctx, objectId: 'o1' };
    expect(quickPlan('Make this darker', o)!.ops).toEqual([{ op: 'object_adjust', clipId: 'a', objectId: 'o1', delta: { exposure: -0.3 } }]);
    expect(quickPlan('change it to blue', o)!.ops).toEqual([{ op: 'object_recolor', clipId: 'a', objectId: 'o1', to: '#2563EB' }]);
    expect(quickPlan('გახადე ლურჯად', o)!.ops[0]).toMatchObject({ op: 'object_recolor', to: '#2563EB' });
    expect(quickPlan('reduce the brightness', o)!.ops.some((x) => x.op === 'object_recolor')).toBe(false);
  });

  it('cuts the selected part, or asks for a selection', () => {
    expect(quickPlan('Cut out this boring part', { ...ctx, range: { start: 2, end: 3.5 } })!.ops).toEqual([{ op: 'cut_range', startSec: 2, endSec: 3.5 }]);
    const ask = quickPlan('Cut out this boring part', ctx)!;
    expect(ask.ops).toEqual([]);
    expect(ask.reply).toMatch(/Select the part/);
  });

  it('leaves real thinking to the AI planner', () => {
    expect(quickPlan('Remove the object behind the person', ctx)).toBeNull();
    expect(quickPlan('Make the first 3 seconds more exciting', ctx)).toBeNull();
    expect(quickPlan('Can you fix the hand in this selected section?', ctx)).toBeNull();
  });

  it('plan ops change the timeline as described', () => {
    let t = T({ audio: [{ id: 'm', assetId: '00000000-0000-4000-8000-000000000003', kind: 'music', startSec: 0, outSec: 10, volume: 0.8 }] as never });
    t = applyPlanOp(t, { op: 'volume', target: 'music', factor: 0.5 }, () => 'n');
    expect(t.audio[0]!.volume).toBeCloseTo(0.4);
    t = applyPlanOp(t, { op: 'clip_adjust', clipIds: ['a'], delta: { exposure: 0.3 } }, () => 'n');
    expect(t.clips[0]!.adjust!.exposure).toBeCloseTo(0.3);
    expect(t.clips[1]!.adjust).toBeUndefined();
    t = applyPlanOp(t, { op: 'look', clipIds: [], key: 'bw' }, () => 'n');
    expect(t.clips.every((c) => c.adjust!.saturation === -1)).toBe(true);
    t = applyPlanOp(t, { op: 'title', text: 'გამარჯობა', startSec: 1, endSec: 4, position: 'top' }, () => 'n');
    expect(t.layers.at(-1)!.text!.content).toBe('გამარჯობა');
  });
});

describe('create intent', () => {
  it('suggests the right flow, format and length', async () => {
    const { guessIntent } = await import('./intent');
    expect(guessIntent('Make a cinematic 20-second ad for my product')).toMatchObject({ flow: 'ad', aspect: '9:16', durationSec: 20, style: 'cinematic' });
    expect(guessIntent('a short film about a lighthouse keeper, youtube')).toMatchObject({ flow: 'film', aspect: '16:9' });
    expect(guessIntent('animate this photo of my grandmother')).toMatchObject({ flow: 'animate' });
    expect(guessIntent('edit my video from the wedding')).toMatchObject({ flow: 'edit' });
    expect(guessIntent('რეკლამა ჩემი სანთლებისთვის 30 წამი')).toMatchObject({ flow: 'ad', durationSec: 30 });
    expect(guessIntent('golden retriever surfing at sunset')).toMatchObject({ flow: 'ai', aspect: '9:16' });
  });
});

describe('several selected clips', () => {
  it('"these" clips take the place of the single clip', () => {
    const r = quickPlan('make them warmer', { clipId: 'a', clipIndex: 0, clipIds: ['a', 'b'] })!;
    expect(r.ops).toEqual([{ op: 'clip_adjust', clipIds: ['a', 'b'], delta: { temperature: 0.2 } }]);
    expect(quickPlan('black and white', { clipId: 'a', clipIds: ['a', 'b'] })!.ops).toEqual([{ op: 'look', clipIds: ['a', 'b'], key: 'bw' }]);
  });
});
