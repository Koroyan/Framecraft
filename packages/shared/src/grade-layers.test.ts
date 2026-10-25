import { describe, expect, it } from 'vitest';
import { applyReplace, buildLut, curveFn, evalExpr, gradeFunction, hexToRgb, layerExpressions, layerSchema, layerStateAt, lutToCube, parseCube, revealUnits, rgbToHsl, sampleLut } from './index';

const close = (a: number[], b: number[], eps = 0.01) => a.every((v, i) => Math.abs(v - b[i]!) < eps);

describe('colour grade → LUT', () => {
  it('a neutral grade is the identity, and the baked LUT matches the function', () => {
    const id = gradeFunction({});
    expect(close(id([0.2, 0.5, 0.8]), [0.2, 0.5, 0.8], 1e-6)).toBe(true);
    const fn = gradeFunction({ contrast: 0.3, saturation: 0.2, temperature: 0.4, curves: { master: [[0, 0], [0.5, 0.6], [1, 1]] }, lift: { r: 0.1, g: 0, b: -0.1 } });
    const lut = buildLut(fn, 33);
    for (const px of [[0.1, 0.2, 0.3], [0.9, 0.4, 0.1], [0.5, 0.5, 0.5]] as [number, number, number][]) expect(close(sampleLut(lut, px), fn(px), 0.02)).toBe(true);
  });

  it('.cube files round-trip', () => {
    const lut = buildLut(gradeFunction({ exposure: 0.5 }), 9);
    const back = parseCube(lutToCube(lut));
    expect(back.size).toBe(9);
    expect(Math.max(...Array.from(back.data).map((v, i) => Math.abs(v - lut.data[i]!)))).toBeLessThan(1e-5);
    expect(() => parseCube('LUT_1D_SIZE 4\n0 0 0')).toThrow(/1D/);
  });

  it('colour replace turns the picked red into blue and leaves other colours alone', () => {
    const rep = { id: 'r', from: '#C8202A', range: 0.25, softness: 0.5, to: '#2050D0', keepLightness: true, strength: 1 };
    const red = applyReplace(rep, hexToRgb('#B81C24'));
    expect(rgbToHsl(...red)[0]).toBeGreaterThan(200);
    expect(rgbToHsl(...red)[0]).toBeLessThan(240);
    const green: [number, number, number] = [0.1, 0.7, 0.2];
    expect(applyReplace(rep, green)).toEqual(green);
    const grey: [number, number, number] = [0.5, 0.5, 0.5];
    expect(applyReplace(rep, grey)).toEqual(grey);
    // Through the grade function (no mask → part of the LUT).
    const fn = gradeFunction({ replace: [rep] });
    expect(rgbToHsl(...fn(hexToRgb('#B81C24')))[0]).toBeGreaterThan(200);
  });

  it('curves are monotone and pass through their points', () => {
    const c = curveFn([[0, 0], [0.3, 0.5], [1, 1]])!;
    expect(c(0.3)).toBeCloseTo(0.5);
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.05) {
      expect(c(x)).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = c(x);
    }
  });
});

describe('layer animation: preview and FFmpeg expressions agree', () => {
  const layer = layerSchema.parse({
    id: 'l',
    kind: 'text',
    startSec: 1,
    endSec: 5,
    x: 0.3,
    y: 0.7,
    text: { content: 'გამარჯობა მსოფლიო', size: 64 },
    keyframes: [{ t: 0, x: 0.3, y: 0.7, scale: 1 }, { t: 3, x: 0.7, y: 0.4, scale: 1.5 }],
    animIn: { type: 'pop', durationSec: 0.5 },
    animOut: { type: 'slide_down', durationSec: 0.4 },
    follow: { points: [{ t: 1, dx: 0, dy: 0 }, { t: 5, dx: 0.1, dy: -0.05 }] },
  });
  it('x, y and scale match at every moment', () => {
    const ex = layerExpressions(layer);
    for (const t of [1, 1.2, 1.45, 2.5, 3.9, 4.8, 5]) {
      const st = layerStateAt(layer, t);
      expect(evalExpr(ex.x, t)).toBeCloseTo(st.x, 4);
      expect(evalExpr(ex.y, t)).toBeCloseTo(st.y, 4);
      expect(evalExpr(ex.scale, t)).toBeCloseTo(st.scale, 4);
    }
    expect(layerStateAt(layer, 0.5).visible).toBe(false);
  });
  it('typewriter reveals Georgian text in steps', () => {
    const tw = layerSchema.parse({ ...layer, animIn: { type: 'typewriter', durationSec: 2 }, keyframes: [] });
    const units = revealUnits(tw)!;
    expect(units.at(-1)).toBe('გამარჯობა მსოფლიო');
    expect(layerStateAt(tw, 1).row).toBe(0);
    expect(layerStateAt(tw, 3.5).row).toBe(units.length - 1);
    const ex = layerExpressions(tw);
    for (const t of [1.1, 1.7, 2.4]) expect(evalExpr(ex.row, t)).toBe(layerStateAt(tw, t).row);
  });
});
