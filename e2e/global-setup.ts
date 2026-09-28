/**
 * Prepares a clean, real backend for the browser suite. Nothing is mocked.
 *
 *   1. Drops and re-seeds the `biotech_drive_e2e` MongoDB database with the seed script the
 *      deployment uses (an administrator and three employees in different departments/roles).
 *   2. For the D1 backend: creates a fresh local D1, applies the real migrations, then loads the
 *      seeded MongoDB into it with the real migration tool — and verifies the load. So every run
 *      is also a small end-to-end rehearsal of `migrate:d1` + `migrate:verify`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import mongoose from 'mongoose';
import {
  E2E_BACKEND,
  E2E_D1_DIR,
  E2E_MONGODB_URI,
  E2E_PASSWORD,
  E2E_STATE_DIR,
  USERS,
  baseEnv,
} from './env';

function run(label: string, command: string, args: string[]): void {
  const started = Date.now();
  const result = spawnSync(command, args, {
    env: { ...process.env, ...baseEnv(), CI: 'true' },
    shell: process.platform === 'win32',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (result.status !== 0) {
    throw new Error(
      `[e2e setup] ${label} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  console.log(`[e2e setup] ${label} ok (${seconds}s)`);
}

export default async function globalSetup(): Promise<void> {
  // Iteration aid: keep the seeded backend from the previous run. The specs name everything they
  // create with a per-run suffix, so they run correctly on a database that already holds data.
  if (process.env.E2E_REUSE_STATE === '1' && fs.existsSync(E2E_STATE_DIR)) {
    console.log('[e2e setup] reusing the existing backend (E2E_REUSE_STATE=1)');
    return;
  }

  fs.rmSync(E2E_STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(E2E_STATE_DIR, { recursive: true });

  // The same provisioning step a host runs once (`npm run storage:init`): the upload path
  // checks free space on the storage root, and a root that does not exist is an error.
  run('initialize local storage', 'npx', ['tsx', 'scripts/init-storage.ts']);

  await mongoose.connect(E2E_MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  run('seed MongoDB', 'npx', [
    'tsx', 'scripts/seed.ts',
    '--admin-email', USERS.admin.email,
    '--admin-password', E2E_PASSWORD,
    '--admin-name', `"${USERS.admin.name}"`,
    '--demo',
    '--demo-password', E2E_PASSWORD,
  ]);

  if (E2E_BACKEND === 'd1') {
    run('apply D1 migrations', 'npx', [
      'wrangler', 'd1', 'migrations', 'apply', 'biotech-drive-dev',
      '--env', 'development', '--local', '--persist-to', E2E_D1_DIR,
    ]);
    run('migrate MongoDB to D1', 'npx', [
      'tsx', 'scripts/migrate-to-d1.ts',
      '--env', 'development', '--write', '--persist-to', E2E_D1_DIR,
      '--run-id', 'e2e', '--report', `${E2E_STATE_DIR}/migration-report.json`,
    ]);
    run('verify the migration', 'npx', [
      'tsx', 'scripts/verify-d1-migration.ts',
      '--env', 'development', '--persist-to', E2E_D1_DIR,
      '--report', `${E2E_STATE_DIR}/verify-report.json`,
    ]);
  }
}
