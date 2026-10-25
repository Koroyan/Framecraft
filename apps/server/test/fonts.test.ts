import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { fontFile } from '../src/media/raster';

/* Georgian text must never render as empty boxes because a weight lacks Georgian glyphs. */
describe('fonts', () => {
  it('uses a Georgian-capable weight for Georgian text', () => {
    for (const f of ['black', 'mono'] as const) expect(['seguibl.ttf', 'consola.ttf']).not.toContain(path.basename(fontFile(f, 'ქართული ტექსტი')).toLowerCase());
    // Latin text keeps the requested weight.
    expect(fontFile('black', 'Title')).toBe(fontFile('black'));
  });
});
