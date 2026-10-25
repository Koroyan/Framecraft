import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Many tests run real FFmpeg renders; too many at once exhausts a desktop machine.
    maxWorkers: 3,
    env: { NODE_ENV: 'test' },
  },
});
