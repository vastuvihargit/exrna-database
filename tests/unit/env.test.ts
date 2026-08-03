import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '@/server/config/env';

const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  MONGODB_URI: 'mongodb://localhost:27017/biotech_drive',
  MONGODB_DATABASE: 'biotech_drive',
  AUTH_SECRET: 'a'.repeat(32),
  SESSION_SECRET: 'b'.repeat(32),
  COMPANY_EMAIL_DOMAINS: 'company.com, Subsidiary.COM',
  ALLOW_AUTO_PROVISIONING: 'false',
  LOCAL_STORAGE_ROOT: path.join(os.tmpdir(), 'bd/storage'),
  TEMP_UPLOAD_ROOT: path.join(os.tmpdir(), 'bd/temp'),
  QUARANTINE_ROOT: path.join(os.tmpdir(), 'bd/quarantine'),
  PREVIEW_ROOT: path.join(os.tmpdir(), 'bd/previews'),
  EXPORT_ROOT: path.join(os.tmpdir(), 'bd/exports'),
};

describe('environment validation', () => {
  it('parses a valid configuration and derives byte limits', () => {
    const env = loadEnv({ ...base, MAX_UPLOAD_SIZE_MB: '2048', DEFAULT_USER_STORAGE_QUOTA_GB: '20' });
    expect(env.maxUploadBytes).toBe(2048 * 1024 ** 2);
    expect(env.defaultUserQuotaBytes).toBe(20 * 1024 ** 3);
    expect(env.isDevelopment).toBe(true);
  });

  it('normalises the company email domain list', () => {
    const env = loadEnv(base);
    expect(env.COMPANY_EMAIL_DOMAINS).toEqual(['company.com', 'subsidiary.com']);
  });

  it('rejects an empty or malformed domain list', () => {
    expect(() => loadEnv({ ...base, COMPANY_EMAIL_DOMAINS: '' })).toThrow(/COMPANY_EMAIL_DOMAINS/);
    expect(() => loadEnv({ ...base, COMPANY_EMAIL_DOMAINS: 'not a domain' })).toThrow(/COMPANY_EMAIL_DOMAINS/);
  });

  it('refuses to boot without strong secrets', () => {
    expect(() => loadEnv({ ...base, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
    expect(() => loadEnv({ ...base, SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET/);
  });

  it('refuses an invalid MongoDB URI', () => {
    expect(() => loadEnv({ ...base, MONGODB_URI: 'postgres://localhost/db' })).toThrow(/MONGODB_URI/);
  });

  // The single worst misconfiguration this system can have: research files placed
  // somewhere the web server would happily serve without authentication.
  it('refuses a storage root inside the public directory', () => {
    expect(() =>
      loadEnv({ ...base, LOCAL_STORAGE_ROOT: path.join(process.cwd(), 'public', 'uploads') }),
    ).toThrow(/publicly served/);

    expect(() => loadEnv({ ...base, PREVIEW_ROOT: './public' })).toThrow(/publicly served/);
  });

  it('resolves relative storage roots against the project root', () => {
    const env = loadEnv({ ...base, LOCAL_STORAGE_ROOT: './.data/storage' });
    expect(path.isAbsolute(env.storageRoots.storage)).toBe(true);
    expect(env.storageRoots.storage).toBe(path.resolve(process.cwd(), '.data/storage'));
  });

  it('applies production-only hardening rules', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/https/);
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        APP_URL: 'https://drive.company.com',
        SESSION_SECRET: 'a'.repeat(32),
      }),
    ).toThrow(/must differ/);
  });

  it('rejects an absolute session timeout shorter than the idle timeout', () => {
    expect(() =>
      loadEnv({ ...base, SESSION_IDLE_TIMEOUT_MINUTES: '600', SESSION_ABSOLUTE_TIMEOUT_MINUTES: '60' }),
    ).toThrow(/SESSION_ABSOLUTE_TIMEOUT_MINUTES/);
  });

  it('reports every problem at once rather than one at a time', () => {
    let message = '';
    try {
      loadEnv({ ...base, AUTH_SECRET: 'x', MONGODB_URI: 'bad', COMPANY_EMAIL_DOMAINS: '' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('AUTH_SECRET');
    expect(message).toContain('MONGODB_URI');
    expect(message).toContain('COMPANY_EMAIL_DOMAINS');
  });
});
