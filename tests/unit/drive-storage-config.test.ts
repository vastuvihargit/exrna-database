/**
 * Configuration of the Google Shared Drive backend.
 *
 * Two things are being protected here. The first is that a half-configured deployment
 * **refuses to boot** rather than starting and failing on somebody's upload hours later —
 * storage is the one subsystem where "start anyway and find out on first use" risks losing
 * bytes. The second is that the service-account key is never reachable through any surface
 * that reports on the configuration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEnv, resetEnvCache } from '@/server/config/env';
import {
  describeDriveStorage,
  getDriveStorageConfig,
  isDriveStorageEnabled,
  resetDriveStorageConfigCache,
} from '@/server/storage/google/drive-config';

const PEM = ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', '-----END PRIVATE KEY-----'].join(
  '\n',
);

const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  MONGODB_URI: 'mongodb://localhost:27017/biotech_drive',
  AUTH_SECRET: 'a'.repeat(32),
  SESSION_SECRET: 'b'.repeat(32),
  COMPANY_EMAIL_DOMAINS: 'company.com',
  LOCAL_STORAGE_ROOT: path.join(os.tmpdir(), 'bd/storage'),
  TEMP_UPLOAD_ROOT: path.join(os.tmpdir(), 'bd/temp'),
  QUARANTINE_ROOT: path.join(os.tmpdir(), 'bd/quarantine'),
  PREVIEW_ROOT: path.join(os.tmpdir(), 'bd/previews'),
  EXPORT_ROOT: path.join(os.tmpdir(), 'bd/exports'),
};

const driveOn: NodeJS.ProcessEnv = {
  ...base,
  GOOGLE_DRIVE_STORAGE_ENABLED: 'true',
  GOOGLE_SHARED_DRIVE_ID: '0ABCdefGHIjkl',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL: 'drive-storage@example.iam.gserviceaccount.com',
  GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
};

/** The same configuration with one variable simply absent, as an operator would leave it. */
function without(source: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

describe('environment refusals for Google Drive storage', () => {
  it('accepts a deployment that never mentions Drive at all', () => {
    const env = loadEnv(base);
    expect(env.GOOGLE_DRIVE_STORAGE_ENABLED).toBe(false);
    expect(env.DEFAULT_STORAGE_PROVIDER).toBe('local');
    // The retention default is what makes rollback possible; it must not be zero by accident.
    expect(env.LOCAL_COPY_RETENTION_DAYS).toBe(30);
    expect(env.DELETE_LOCAL_AFTER_MIGRATION).toBe(false);
  });

  /**
   * The configuration mistake this migration invites most: pointing new uploads at Drive on
   * a deployment where Drive is switched off. Every upload would fail. Failing at startup is
   * the honest outcome.
   */
  it('refuses to default to Drive while Drive is disabled', () => {
    expect(() => loadEnv({ ...base, DEFAULT_STORAGE_PROVIDER: 'google_drive' })).toThrow(
      /DEFAULT_STORAGE_PROVIDER/,
    );
  });

  it('refuses to enable Drive without a Shared Drive id', () => {
    expect(() => loadEnv(without(driveOn, 'GOOGLE_SHARED_DRIVE_ID'))).toThrow(/GOOGLE_SHARED_DRIVE_ID/);
  });

  /** Named explicitly in the message, because "why a Shared Drive" is the design decision. */
  it('explains why a Shared Drive rather than a personal account', () => {
    expect(() => loadEnv(without(driveOn, 'GOOGLE_SHARED_DRIVE_ID'))).toThrow(/My Drive/i);
  });

  it('refuses to enable Drive without a service account', () => {
    expect(() => loadEnv(without(driveOn, 'GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL'))).toThrow(
      /GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL/,
    );
  });

  it('refuses to enable Drive without a key from either source', () => {
    expect(() => loadEnv(without(driveOn, 'GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY'))).toThrow(
      /service-account key is required/,
    );
  });

  it('accepts a mounted key file as the only key source', () => {
    const env = loadEnv({
      ...without(driveOn, 'GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY'),
      GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE: '/run/secrets/drive-key',
    });
    expect(env.GOOGLE_DRIVE_STORAGE_ENABLED).toBe(true);
  });

  /**
   * A zero-day retention deletes the only rollback copy the instant a migration verifies,
   * which removes the entire safety net the phase plan is built on.
   */
  it('refuses zero-day retention alongside automatic local deletion', () => {
    expect(() =>
      loadEnv({ ...base, DELETE_LOCAL_AFTER_MIGRATION: 'true', LOCAL_COPY_RETENTION_DAYS: '0' }),
    ).toThrow(/LOCAL_COPY_RETENTION_DAYS/);
  });

  it('derives the upload chunk size in bytes', () => {
    expect(loadEnv({ ...driveOn, GOOGLE_DRIVE_UPLOAD_CHUNK_MB: '16' }).googleDriveUploadChunkBytes).toBe(
      16 * 1024 ** 2,
    );
  });
});

describe('resolving the service-account credential', () => {
  const previousEnv = { ...process.env };

  function applyEnv(values: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GOOGLE_') || key === 'DEFAULT_STORAGE_PROVIDER') delete process.env[key];
    }
    Object.assign(process.env, values);
    resetEnvCache();
    resetDriveStorageConfigCache();
  }

  beforeEach(() => applyEnv(driveOn));

  afterEach(() => {
    process.env = { ...previousEnv };
    resetEnvCache();
    resetDriveStorageConfigCache();
  });

  /** `.env` files cannot hold real newlines, so an inline PEM always arrives escaped. */
  it('un-escapes an inline PEM into a real key', () => {
    const config = getDriveStorageConfig();
    expect(config.privateKey).toBe(PEM);
    expect(config.keySource).toBe('inline');
  });

  it('rejects a value that is not a PEM private key', () => {
    applyEnv({ ...driveOn, GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY: 'not-a-key' });
    expect(() => getDriveStorageConfig()).toThrow(/PEM private key/);
  });

  /**
   * A deployment that mounts a secret *and* has a stale inline value left in its
   * environment must use the secret — not whichever the code happened to check first.
   */
  it('prefers a mounted key file over an inline value', () => {
    const keyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drive-key-')), 'key.pem');
    fs.writeFileSync(keyPath, `${PEM}\n`);

    applyEnv({
      ...driveOn,
      GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nSTALE\\n-----END PRIVATE KEY-----',
      GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE: keyPath,
    });

    const config = getDriveStorageConfig();
    expect(config.keySource).toBe('file');
    expect(config.privateKey).toBe(PEM);
  });

  /** The path is a filesystem path, which this codebase never puts into an error message. */
  it('reports an unreadable key file without naming it', () => {
    const missing = path.join(os.tmpdir(), 'definitely-not-here', 'key.pem');
    applyEnv({ ...driveOn, GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE: missing });

    expect(() => getDriveStorageConfig()).toThrow(/could not be read/);
    try {
      getDriveStorageConfig();
    } catch (error) {
      expect((error as Error).message).not.toContain(missing);
    }
  });

  it('refuses to produce a configuration when the backend is switched off', () => {
    applyEnv(base);
    expect(isDriveStorageEnabled()).toBe(false);
    expect(() => getDriveStorageConfig()).toThrow(/not enabled/);
  });
});

describe('the administrator-facing configuration summary', () => {
  const previousEnv = { ...process.env };

  function applyEnv(values: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GOOGLE_') || key === 'DEFAULT_STORAGE_PROVIDER') delete process.env[key];
    }
    Object.assign(process.env, values);
    resetEnvCache();
    resetDriveStorageConfigCache();
  }

  afterEach(() => {
    process.env = { ...previousEnv };
    resetEnvCache();
    resetDriveStorageConfigCache();
  });

  /**
   * The load-bearing assertion of this file. Everything the admin panel and the system
   * status page render comes from this object; if the key cannot appear in it, it cannot
   * appear on a page, in a log line, or in an API response.
   */
  it('never contains the private key in any field', () => {
    applyEnv(driveOn);
    const summary = describeDriveStorage();
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    // What it *does* report is where the key came from, which is what the warning is about.
    expect(summary.keySource).toBe('inline');
  });

  it('reports a disabled backend without reading any credential', () => {
    applyEnv(base);
    const summary = describeDriveStorage();

    expect(summary.enabled).toBe(false);
    expect(summary.configured).toBe(false);
    expect(summary.sharedDriveId).toBeNull();
    expect(summary.serviceAccountEmail).toBeNull();
  });

  it('warns in production when the key is inline rather than a mounted secret', () => {
    applyEnv({ ...driveOn, NODE_ENV: 'production', APP_URL: 'https://drive.company.com' });
    expect(describeDriveStorage().warnings.join(' ')).toMatch(/mounted secret/i);
  });

  it('warns when no root folder scopes the Shared Drive', () => {
    applyEnv(driveOn);
    expect(describeDriveStorage().warnings.join(' ')).toMatch(/root folder/i);
  });

  /**
   * The panel whose job is to explain a broken configuration must not itself fail to
   * render — otherwise the administrator sees a 500 and no diagnosis.
   */
  it('reports a malformed key as a warning instead of throwing', () => {
    applyEnv({ ...driveOn, GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY: 'garbage' });

    const summary = describeDriveStorage();
    expect(summary.configured).toBe(false);
    expect(summary.warnings.join(' ')).toMatch(/PEM private key/);
  });
});
