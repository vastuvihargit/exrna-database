import { defineConfig } from '@playwright/test';
import { E2E_BACKEND, E2E_BASE_URL, E2E_PORT, serverEnv } from './e2e/env';

/**
 * Browser E2E suite. `npm run test:e2e` (D1 backend) or `E2E_BACKEND=mongo npm run test:e2e`.
 *
 * Serial and single-worker on purpose: the specs are one working day in order — each step
 * builds on the state the previous one left, the same way a real session does.
 *
 * Uses the installed Google Chrome (`channel: 'chrome'`) rather than a downloaded browser.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: E2E_BASE_URL,
    channel: 'chrome',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
  },
  webServer: {
    // Turbopack rather than webpack: the suite visits most routes in one process, and webpack's
    // dev compiler held 3.5 GB and was still growing when it drove an 8 GB machine into paging
    // (a single route took 697 s to compile). The application's webpack hooks in next.config.ts
    // apply to production and Cloudflare builds only, so dev behaves the same under either.
    command: `npx next dev --turbopack -p ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/api/health`,
    env: serverEnv(),
    // `E2E_REUSE_SERVER=1` attaches to a server started by `npx tsx e2e/dev-server.ts`.
    reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  metadata: { backend: E2E_BACKEND },
});
