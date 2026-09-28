/**
 * The shared application schema (`env.ts`) on a Worker.
 *
 * Application code reads `getEnv()` in both runtimes. On a Worker the Node-only settings —
 * `MONGODB_URI` and the local storage roots — are deliberately *not* configured
 * (EXTERNAL-SETUP.md §1.6): there is no MongoDB and no disk. Before this was fixed, a Worker
 * configured exactly as documented passed the startup gate (`loadWorkerEnv`) and then failed
 * every request that read `getEnv()`. Earlier local previews hid it, because a developer's
 * `.dev.vars` happened to carry both.
 *
 * The configuration below is exactly what a staging/production Worker has: its secrets and
 * `wrangler.jsonc` vars, nothing Node-only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '@/server/config/env';
import { loadWorkerEnv } from '@/server/config/env.worker';
import { setRuntimeOverride } from '@/server/runtime';
import { DATA_SOURCE_MODULES, envVarFor } from '@/server/repositories/data-source';

const workerConfiguration: NodeJS.ProcessEnv = {
  // wrangler.jsonc → env.production.vars
  NODE_ENV: 'production',
  APP_NAME: 'Biotech Research Drive',
  LOG_LEVEL: 'info',
  GOOGLE_DRIVE_STORAGE_ENABLED: 'true',
  DEFAULT_STORAGE_PROVIDER: 'google_drive',
  UPLOAD_STAGING: 'google_drive',
  MALWARE_SCAN_MODE: 'disabled',
  // secrets (EXTERNAL-SETUP.md §1.6)
  AUTH_SECRET: 'a'.repeat(32),
  SESSION_SECRET: 'b'.repeat(32),
  APP_URL: 'https://drive.company.com',
  COMPANY_EMAIL_DOMAINS: 'company.com',
  GOOGLE_SHARED_DRIVE_ID: '0ABCdefSharedDrive',
  GOOGLE_DRIVE_ROOT_FOLDER_ID: '1RootFolder',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'drive@project.iam.gserviceaccount.com',
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
  GOOGLE_WORKSPACE_DOMAIN: 'company.com',
  CF_ACCESS_TEAM_DOMAIN: 'company.cloudflareaccess.com',
  CF_ACCESS_AUD: 'f'.repeat(64),
  // cutover step 15: every module on D1 (a production Worker refuses to boot otherwise)
  ...Object.fromEntries(DATA_SOURCE_MODULES.map((name) => [envVarFor(name), 'd1'])),
};

afterEach(() => setRuntimeOverride(null));

describe('the shared schema on a Worker', () => {
  it('the documented Worker configuration passes both the startup gate and getEnv()', () => {
    setRuntimeOverride('workerd');
    // The flag matrix is read from `process.env`, as on a Worker with
    // `nodejs_compat_populate_process_env`: the one lookup both runtimes share.
    const flags = DATA_SOURCE_MODULES.map((name) => envVarFor(name));
    const saved = Object.fromEntries(flags.map((flag) => [flag, process.env[flag]]));
    for (const flag of flags) process.env[flag] = 'd1';
    try {
      expect(() => loadWorkerEnv(workerConfiguration as Record<string, string>)).not.toThrow();
    } finally {
      for (const flag of flags) {
        if (saved[flag] === undefined) delete process.env[flag];
        else process.env[flag] = saved[flag];
      }
    }

    const env = loadEnv(workerConfiguration);
    expect(env.isProduction).toBe(true);
    expect(env.APP_URL).toBe('https://drive.company.com');
  });

  it('reads the Drive service account under the names the Worker is configured with', () => {
    setRuntimeOverride('workerd');
    const env = loadEnv(workerConfiguration);
    expect(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL).toBe('drive@project.iam.gserviceaccount.com');
    expect(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY).toContain('BEGIN PRIVATE KEY');
  });

  it('marks the Node-only settings as unusable rather than inventing working ones', () => {
    setRuntimeOverride('workerd');
    const env = loadEnv(workerConfiguration);
    expect(env.MONGODB_URI).toMatch(/\.invalid/);
    expect(env.LOCAL_STORAGE_ROOT).toMatch(/no-filesystem-on-a-worker/);
  });

  it('never overrides a value that is set', () => {
    setRuntimeOverride('workerd');
    const env = loadEnv({ ...workerConfiguration, MONGODB_URI: 'mongodb://explicit:27017/x' });
    expect(env.MONGODB_URI).toBe('mongodb://explicit:27017/x');
  });

  it('an HTTP scanner fails closed by default on every Worker, staging included', () => {
    setRuntimeOverride('workerd');
    const http = {
      ...workerConfiguration,
      MALWARE_SCAN_MODE: 'http',
      MALWARE_SCAN_ENDPOINT: 'https://scanner.company.com/scan',
      MALWARE_SCAN_SECRET: 's'.repeat(32),
    };
    expect(loadEnv(http).MALWARE_SCAN_FAIL_CLOSED).toBe(true);
    // Staging is where the rehearsal runs on a production snapshot: an outage there must not
    // quietly accept unscanned files either.
    expect(loadEnv({ ...http, NODE_ENV: 'staging' } as unknown as NodeJS.ProcessEnv).MALWARE_SCAN_FAIL_CLOSED).toBe(true);
    // Failing open stays possible, but only as an explicit setting.
    expect(loadEnv({ ...http, NODE_ENV: 'staging', MALWARE_SCAN_FAIL_CLOSED: 'false' } as unknown as NodeJS.ProcessEnv).MALWARE_SCAN_FAIL_CLOSED).toBe(false);
  });

  it('on Node the same configuration is still refused: MongoDB and the roots are required there', () => {
    setRuntimeOverride('node');
    expect(() => loadEnv(workerConfiguration)).toThrow(/MONGODB_URI/);
    expect(() => loadEnv(workerConfiguration)).toThrow(/LOCAL_STORAGE_ROOT/);
  });
});
