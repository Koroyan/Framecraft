import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'vitest';
import { measureRender } from '../../src/media/qc';
import { judgeRender } from '../../src/ads/quality';

/* Manual: measure real downloaded renders (run with QC_FILES="a.mp4;b.mp4"). Skipped in CI. */
const files = (process.env.QC_FILES ?? '').split(';').filter((f) => f && fs.existsSync(f));
describe.skipIf(!files.length)('real render QC', () => {
  it('measures', async () => {
    for (const f of files) {
      const t0 = Date.now();
      const m = await measureRender(f);
      const { frames, dir, ...rest } = m;
      const last = m.shots.at(-1)!;
      console.log(path.basename(f), `${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(rest));
      console.log('issues', JSON.stringify(judgeRender(m, null, { modeKey: 'luxury_commercial', cta: null, expectedAspect: '9:16', logoCard: { startSec: last.startSec, endSec: last.endSec } })));
      void frames;
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
