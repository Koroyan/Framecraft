import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests (and the FFmpeg work they start) write scratch files to the temp folder. Pointing the whole run
// at one folder lets test/helpers/temp-dir.ts remove all of it at the end, so runs do not fill the disk.
const scratch = path.join(os.tmpdir(), `fc-vitest-${process.pid}`);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Many tests run real FFmpeg renders; too many at once exhausts a desktop machine.
    maxWorkers: 3,
    globalSetup: ['test/helpers/temp-dir.ts'],
    env: { NODE_ENV: 'test', TEMP: scratch, TMP: scratch, TMPDIR: scratch },
  },
});
