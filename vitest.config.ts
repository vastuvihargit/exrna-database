import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    /**
     * `tests/d1/**` is excluded here and run by `vitest.d1.config.ts` as a separate process.
     *
     * Not for tidiness — for contention. The D1 suite shells out to wrangler ~30 times and
     * each call leaves a workerd process winding down. The database suites start a real
     * `mongod` per file through mongodb-memory-server, and with `fileParallelism: false` the
     * next file begins while those workerd processes are still exiting. That was enough to
     * push `startTestDb()` past its 180 s hook timeout on a loaded machine — a failure with
     * nothing wrong in either suite.
     *
     * `npm test` runs both, in sequence, in separate processes.
     */
    exclude: ['node_modules', '.next', 'tests/e2e/**', 'tests/d1/**'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    /**
     * Test files run one at a time.
     *
     * Every database-backed suite starts its own single-node replica set, and each one
     * costs a mongod process plus ~40 MB of WiredTiger scratch in the temp directory.
     * Run in parallel, six of them coexist — which on a developer machine with a
     * near-full disk makes mongod fail to start with an `fassert()` at startup, and the
     * suites then *skip* rather than fail. Silently skipping the security tests is a far
     * worse outcome than a slower run, so the parallelism goes.
     */
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/server/**/*.ts'],
      exclude: ['src/server/**/index.ts', 'src/server/**/*.d.ts'],
      thresholds: {
        // Security-critical core must stay heavily covered.
        'src/server/storage/**': { statements: 85, branches: 75, functions: 85, lines: 85 },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
