import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * The D1 schema-contract suite, run as its own process.
 *
 * Separate from `vitest.config.ts` because the two suites need incompatible infrastructure
 * and interfere when they share one run: this one shells out to wrangler (leaving workerd
 * processes winding down), the database suites start a real `mongod` per file. Interleaved,
 * the second is starved of the resources it needs to boot inside its hook timeout.
 *
 * `npm test` runs both configs in sequence, so "all tests" still means all tests.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/d1/**/*.test.ts'],
    exclude: ['node_modules', '.next'],
    setupFiles: ['tests/setup.ts'],
    /**
     * Generous, because every assertion is a real round trip through a freshly spawned
     * wrangler process — several seconds each, and slower on a cold cache or a loaded
     * machine. The suite fails rather than skips when it cannot reach D1, so a timeout here
     * is a real signal rather than something to tune away.
     */
    testTimeout: 240_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
