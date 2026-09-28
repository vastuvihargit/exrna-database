/**
 * Starts the E2E dev server by hand, with exactly the environment Playwright gives it — for
 * reading server logs while writing a spec. `npx tsx e2e/dev-server.ts`
 */
import { spawn } from 'node:child_process';
import { E2E_PORT, serverEnv } from './env';

spawn('npx', ['next', 'dev', '--turbopack', '-p', String(E2E_PORT)], {
  env: { ...process.env, ...serverEnv(), LOG_LEVEL: 'info' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
