import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // DB-backed integration tests share one database; run files serially so
    // the per-test truncation does not race between workers.
    fileParallelism: false,
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/tests/setup.ts']
  }
});
