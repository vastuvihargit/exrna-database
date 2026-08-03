/**
 * The developer switcher's production gate.
 *
 * This feature issues a session for another employee without their password. That is
 * entirely reasonable in a development database full of seeded fixtures and completely
 * unacceptable anywhere else, so the gate is the feature — the switcher itself is just
 * a panel.
 *
 * The cases below are the ways somebody could plausibly end up with it live: a
 * production deployment that inherits `ENABLE_DEV_SWITCHER=true` from a shared env file,
 * a `.env.production` copied from a developer machine, or a staging box that wants
 * production behaviour without a production build.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Typed loosely: `loadEnv` takes a raw source, and these cases vary NODE_ENV per test. */
const BASE_ENV: Record<string, string> = {
  APP_URL: 'https://drive.company.com',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/biotech_drive',
  AUTH_SECRET: 'production-auth-secret-value-that-is-long',
  SESSION_SECRET: 'production-session-secret-value-different',
  COMPANY_EMAIL_DOMAINS: 'company.com',
  LOCAL_STORAGE_ROOT: '/data/storage',
  TEMP_UPLOAD_ROOT: '/data/temp',
  QUARANTINE_ROOT: '/data/quarantine',
  PREVIEW_ROOT: '/data/previews',
  EXPORT_ROOT: '/data/exports',
};

async function loadEnvModule() {
  const envModule = await import('@/server/config/env');
  envModule.resetEnvCache();
  return envModule;
}

afterEach(async () => {
  const { resetEnvCache } = await import('@/server/config/env');
  resetEnvCache();
});

describe('environment gate', () => {
  it('refuses to boot when production explicitly asks for the switcher', async () => {
    // Silently ignoring it would leave whoever set the variable believing it worked.
    const { loadEnv } = await loadEnvModule();

    expect(() =>
      loadEnv({ ...BASE_ENV, NODE_ENV: 'production', ENABLE_DEV_SWITCHER: 'true' }),
    ).toThrow(/ENABLE_DEV_SWITCHER/);
  });

  it('also refuses the "1" spelling', async () => {
    const { loadEnv } = await loadEnvModule();

    expect(() => loadEnv({ ...BASE_ENV, NODE_ENV: 'production', ENABLE_DEV_SWITCHER: '1' })).toThrow(
      /must not be enabled in production/,
    );
  });

  it('boots normally in production when the variable is absent', async () => {
    // The ordinary case. An unset variable is not a misconfiguration.
    const { loadEnv } = await loadEnvModule();
    const env = loadEnv({ ...BASE_ENV, NODE_ENV: 'production' });
    expect(env.isProduction).toBe(true);
  });

  it('boots in production when the variable is explicitly false', async () => {
    const { loadEnv } = await loadEnvModule();
    expect(() =>
      loadEnv({ ...BASE_ENV, NODE_ENV: 'production', ENABLE_DEV_SWITCHER: 'false' }),
    ).not.toThrow();
  });

  it('defaults to on outside production', async () => {
    const { loadEnv } = await loadEnvModule();
    const env = loadEnv({ ...BASE_ENV, NODE_ENV: 'development', APP_URL: 'http://localhost:3000' });
    expect(env.ENABLE_DEV_SWITCHER).toBe(true);
  });

  it('can be turned off outside production, for a production-like staging box', async () => {
    const { loadEnv } = await loadEnvModule();
    // 'staging' is valid for this application's schema but not for @types/node's
    // narrowed NODE_ENV union, hence the cast.
    const env = loadEnv({
      ...BASE_ENV,
      NODE_ENV: 'staging',
      ENABLE_DEV_SWITCHER: 'false',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.ENABLE_DEV_SWITCHER).toBe(false);
    expect(env.isProduction).toBe(false);
  });
});

describe('the runtime gate', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env = { ...original };
  });

  afterEach(() => {
    process.env = { ...original };
  });

  async function freshGate() {
    const { resetEnvCache } = await import('@/server/config/env');
    resetEnvCache();
    // Re-imported per case so the memoized environment is rebuilt from the mutated
    // process.env rather than whatever the previous test left behind.
    return import('@/server/config/dev-mode');
  }

  it('is open in development', async () => {
    Object.assign(process.env, BASE_ENV, {
      NODE_ENV: 'development',
      APP_URL: 'http://localhost:3000',
    });
    delete process.env.ENABLE_DEV_SWITCHER;

    const { isDevToolingEnabled, assertDevToolingEnabled } = await freshGate();
    expect(isDevToolingEnabled()).toBe(true);
    expect(() => assertDevToolingEnabled()).not.toThrow();
  });

  it('is shut in production, and reports 404 rather than 403', async () => {
    // 403 would confirm the endpoint exists and is merely refused, which tells an
    // attacker exactly which build they are talking to. 404 makes a production
    // deployment indistinguishable from one where the feature was never written.
    Object.assign(process.env, BASE_ENV, { NODE_ENV: 'production' });
    delete process.env.ENABLE_DEV_SWITCHER;

    const { isDevToolingEnabled, assertDevToolingEnabled } = await freshGate();
    expect(isDevToolingEnabled()).toBe(false);
    expect(() => assertDevToolingEnabled()).toThrow(
      expect.objectContaining({ status: 404 }) as unknown as Error,
    );
  });

  it('is shut when explicitly disabled outside production', async () => {
    Object.assign(process.env, BASE_ENV, {
      NODE_ENV: 'development',
      APP_URL: 'http://localhost:3000',
      ENABLE_DEV_SWITCHER: 'false',
    });

    const { isDevToolingEnabled } = await freshGate();
    expect(isDevToolingEnabled()).toBe(false);
  });
});

describe('the service refuses to run behind a shut gate', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('will not list users in production', async () => {
    // The gate is asserted inside the service too, not only in the route — so a future
    // server action or script that calls the service directly cannot bypass it.
    Object.assign(process.env, BASE_ENV, { NODE_ENV: 'production' });
    delete process.env.ENABLE_DEV_SWITCHER;

    const { resetEnvCache } = await import('@/server/config/env');
    resetEnvCache();

    const { devSwitcherService } = await import('@/server/services/dev-switcher.service');
    await expect(devSwitcherService.listSwitchableUsers()).rejects.toMatchObject({ status: 404 });
  });

  it('will not switch users in production', async () => {
    Object.assign(process.env, BASE_ENV, { NODE_ENV: 'production' });
    delete process.env.ENABLE_DEV_SWITCHER;

    const { resetEnvCache } = await import('@/server/config/env');
    resetEnvCache();

    const { devSwitcherService } = await import('@/server/services/dev-switcher.service');
    await expect(
      devSwitcherService.switchToUser({
        targetUserId: '0123456789abcdef01234567',
        meta: { requestId: 'test', ip: '10.0.0.1', userAgent: 'vitest' },
      }),
      // Rejected before it can reach the database — the gate is the first statement.
    ).rejects.toMatchObject({ status: 404 });
  });
});
