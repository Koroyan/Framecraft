import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { layerSchema } from '@framecraft/shared';
import { rasterizeLayer } from '../src/media/raster';

/*
 * Text is drawn literally: a "%" ("-30%", "100% cotton") used to start FFmpeg's text expansion and
 * the whole text came out empty — in the preview and in the export.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-raster-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const text = (content: string) => layerSchema.parse({ id: 'l1', name: 'T', kind: 'text', track: 2, startSec: 0, endSec: 2, x: 0.5, y: 0.7, w: 0.84, text: { content, font: 'black', size: 84, color: '#FFE14D', stroke: { color: '#000000', width: 8 } } });

describe('text layers are drawn literally', () => {
  it('draws texts with % signs and other special characters', async () => {
    const plain = await rasterizeLayer(text('Summer sale -30'), 360, path.join(dir, 'a.png'));
    for (const content of ['Summer sale -30%', '100% cotton', '50%% off: now {only}']) {
      const r = await rasterizeLayer(text(content), 360, path.join(dir, `${content.length}.png`));
      expect(r.width, content).toBeGreaterThan(plain.width * 0.6);
      expect(r.height, content).toBeGreaterThan(16);
    }
  }, 120_000);

  it('draws shape labels with % signs', async () => {
    const layer = layerSchema.parse({ id: 's1', name: 'Price', kind: 'shape', track: 3, startSec: 0, endSec: 2, x: 0.5, y: 0.5, w: 0.3, shape: { type: 'pill', fill: '#FFD23F', aspect: 2.4, label: '-30%', labelColor: '#111111' } });
    const r = await rasterizeLayer(layer, 360, path.join(dir, 'shape.png'));
    expect(r.width).toBeGreaterThan(16);
  }, 60_000);
});
