/**
 * `AUTH_PROVIDER=google_oauth` at startup: what the Worker gate and the shared schema accept.
 *
 * The mode replaces Cloudflare Access as the front door, so it must be complete on its own
 * (OAuth client, Workspace domain, https) and must not coexist with an Access configuration —
 * and a Worker that selects neither must still refuse to boot in production.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '@/server/config/env';
import { loadWorkerEnv } from '@/server/config/env.worker';
import { setRuntimeOverride } from '@/server/runtime';
import { DATA_SOURCE_MODULES, envVarFor } from '@/server/repositories/data-source';
import { googleOAuthRedirectUri, signInConfigIssues } from '@/server/auth/auth-provider';

const FLAGS = DATA_SOURCE_MODULES.map((name) => envVarFor(name));

/** A staging Worker in google_oauth mode: wrangler vars plus secrets, nothing Access-related. */
const googleOAuthWorker: Record<string, string> = {
  NODE_ENV: 'staging',
  GOOGLE_DRIVE_STORAGE_ENABLED: 'true',
  DEFAULT_STORAGE_PROVIDER: 'google_drive',
  UPLOAD_STAGING: 'google_drive',
  MALWARE_SCAN_MODE: 'disabled',
  AUTH_PROVIDER: 'google_oauth',
  AUTH_SECRET: 'a'.repeat(32),
  SESSION_SECRET: 'b'.repeat(32),
  APP_URL: 'https://exrna-database-staging.example.workers.dev',
  COMPANY_EMAIL_DOMAINS: 'exrna.com',
  GOOGLE_WORKSPACE_DOMAIN: 'exrna.com',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  GOOGLE_SHARED_DRIVE_ID: '0ABCdefSharedDrive',
  GOOGLE_DRIVE_ROOT_FOLDER_ID: '1RootFolder',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'drive@project.iam.gserviceaccount.com',
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
  ...Object.fromEntries(FLAGS.map((flag) => [flag, 'd1'])),
};

function withFlags<T>(run: () => T): T {
  const saved = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));
  for (const flag of FLAGS) process.env[flag] = 'd1';
  try {
    return run();
  } finally {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  }
}

/**
 * `@types/node` narrows NODE_ENV to development | production | test, but a staging Worker
 * really runs with `staging` — which the schema accepts. The cast states that, once.
 */
const asProcessEnv = (config: Record<string, string>) => config as unknown as NodeJS.ProcessEnv;

const without = (config: Record<string, string>, ...names: string[]) =>
  Object.fromEntries(Object.entries(config).filter(([name]) => !names.includes(name)));

afterEach(() => setRuntimeOverride(null));

describe('AUTH_PROVIDER=google_oauth on a Worker', () => {
  it('boots with the OAuth client and no Cloudflare Access configuration', () => {
    setRuntimeOverride('workerd');
    withFlags(() => {
      expect(() => loadWorkerEnv(googleOAuthWorker)).not.toThrow();
      // Production too: google_oauth is an identity provider, so Access is not required.
      expect(() => loadWorkerEnv({ ...googleOAuthWorker, NODE_ENV: 'production' })).not.toThrow();
    });
  });

  it('passes the shared schema and derives the redirect URI from APP_URL', () => {
    setRuntimeOverride('workerd');
    const env = withFlags(() => loadEnv(asProcessEnv(googleOAuthWorker)));
    expect(env.GOOGLE_CLIENT_ID).toBe('client-id.apps.googleusercontent.com');
    expect(env.GOOGLE_CLIENT_SECRET).toBe('client-secret');
    expect(env.GOOGLE_REDIRECT_URI).toBe(
      'https://exrna-database-staging.example.workers.dev/api/auth/google/callback',
    );
  });

  it.each(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_WORKSPACE_DOMAIN'])(
    'refuses to boot without %s',
    (name) => {
      setRuntimeOverride('workerd');
      withFlags(() => {
        expect(() => loadWorkerEnv(without(googleOAuthWorker, name))).toThrow(new RegExp(name));
      });
    },
  );

  it('refuses a Cloudflare Access configuration alongside it', () => {
    setRuntimeOverride('workerd');
    withFlags(() => {
      expect(() =>
        loadWorkerEnv({
          ...googleOAuthWorker,
          CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
          CF_ACCESS_AUD: 'f'.repeat(64),
        }),
      ).toThrow(/CF_ACCESS_TEAM_DOMAIN: must be unset/);
    });
  });

  it('refuses a plain-http APP_URL outside development', () => {
    setRuntimeOverride('workerd');
    withFlags(() => {
      expect(() => loadWorkerEnv({ ...googleOAuthWorker, APP_URL: 'http://staging.exrna.com' })).toThrow(
        /APP_URL: must use https/,
      );
    });
  });

  it('refuses a Workspace domain that is not on the email allow-list', () => {
    setRuntimeOverride('workerd');
    withFlags(() => {
      expect(() =>
        loadWorkerEnv({ ...googleOAuthWorker, COMPANY_EMAIL_DOMAINS: 'other-company.com' }),
      ).toThrow(/COMPANY_EMAIL_DOMAINS: must include GOOGLE_WORKSPACE_DOMAIN/);
    });
  });

  it('refuses a redirect URI on another origin than APP_URL', () => {
    setRuntimeOverride('workerd');
    expect(() =>
      withFlags(() =>
        loadEnv(
          asProcessEnv({
            ...googleOAuthWorker,
            GOOGLE_REDIRECT_URI: 'https://elsewhere.example/api/auth/google/callback',
          }),
        ),
      ),
    ).toThrow(/GOOGLE_REDIRECT_URI/);
  });

  it('still refuses a production Worker with no identity provider at all', () => {
    setRuntimeOverride('workerd');
    withFlags(() => {
      expect(() =>
        loadWorkerEnv({ ...without(googleOAuthWorker, 'AUTH_PROVIDER'), NODE_ENV: 'production' }),
      ).toThrow(/Cloudflare Access is not configured/);
    });
  });
});

describe('signInConfigIssues', () => {
  const base = { NODE_ENV: 'staging', APP_URL: 'https://staging.exrna.com' };

  it('asks nothing of a deployment that selects no provider', () => {
    expect(signInConfigIssues(base)).toEqual([]);
  });

  it('requires both Access values when cloudflare_access is selected explicitly', () => {
    expect(signInConfigIssues({ ...base, AUTH_PROVIDER: 'cloudflare_access' })).toHaveLength(1);
    expect(
      signInConfigIssues({
        ...base,
        AUTH_PROVIDER: 'cloudflare_access',
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUD: 'aud',
      }),
    ).toEqual([]);
  });

  it('gives the staging Worker the redirect URI registered in Google Cloud Console', () => {
    expect(googleOAuthRedirectUri('https://exrna-database-staging.cmc-330.workers.dev')).toBe(
      'https://exrna-database-staging.cmc-330.workers.dev/api/auth/google/callback',
    );
  });

  it('builds the callback on APP_URL', () => {
    expect(googleOAuthRedirectUri('https://staging.exrna.com')).toBe(
      'https://staging.exrna.com/api/auth/google/callback',
    );
  });
});
