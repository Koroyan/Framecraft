import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creates the run's scratch folder (see vitest.config.ts) and removes it, with everything in it, afterwards. */
export default function setup() {
  const dir = path.join(os.tmpdir(), `fc-vitest-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
