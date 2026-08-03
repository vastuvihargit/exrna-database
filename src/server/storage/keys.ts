/**
 * Storage key builders.
 *
 * Physical names are always generated identifiers (ObjectId hex / UUID), never the
 * user's filename — so a key can never carry a path separator, an executable
 * extension, or an attacker-chosen string. The original filename lives in MongoDB.
 *
 * Layout (docs/phase-0/04-storage.md):
 *   originals/{organizationId}/{departmentId}/{fileId}/{versionId}
 *   versions/{fileId}/{versionId}
 *   previews/{fileId}/{versionId}.{ext}
 *   quarantine/{uploadSessionId}/{part}
 *   migration-staging/{migrationJobId}/{itemId}
 *   exports/{userId}/{exportJobId}.zip
 *   archives/{organizationId}/{year}/{fileId}/{versionId}
 */
import { randomUUID } from 'crypto';
import { assertSafeKey } from './path-safety';
import type { StorageArea } from './types';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

function id(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} for storage key: identifiers must be alphanumeric`);
  }
  return value;
}

export function newStorageId(): string {
  return randomUUID();
}

export interface KeyRef {
  key: string;
  area: StorageArea;
}

export function buildOriginalKey(input: {
  organizationId: string;
  departmentId?: string | null;
  fileId: string;
  versionId: string;
}): KeyRef {
  const department = input.departmentId ? id(input.departmentId, 'departmentId') : 'no-department';
  const key = [
    id(input.organizationId, 'organizationId'),
    department,
    id(input.fileId, 'fileId'),
    id(input.versionId, 'versionId'),
  ].join('/');
  assertSafeKey(key);
  return { key, area: 'originals' };
}

export function buildVersionKey(input: { fileId: string; versionId: string }): KeyRef {
  const key = `${id(input.fileId, 'fileId')}/${id(input.versionId, 'versionId')}`;
  assertSafeKey(key);
  return { key, area: 'versions' };
}

export function buildPreviewKey(input: {
  fileId: string;
  versionId: string;
  extension: string;
}): KeyRef {
  const ext = input.extension.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ext) throw new Error('Preview key requires an extension');
  const key = `${id(input.fileId, 'fileId')}/${id(input.versionId, 'versionId')}.${ext}`;
  assertSafeKey(key);
  return { key, area: 'previews' };
}

export function buildQuarantineKey(input: { uploadSessionId: string; part?: string }): KeyRef {
  const part = input.part ? id(input.part, 'part') : 'assembled';
  const key = `${id(input.uploadSessionId, 'uploadSessionId')}/${part}`;
  assertSafeKey(key);
  return { key, area: 'quarantine' };
}

export function buildTemporaryChunkKey(input: {
  uploadSessionId: string;
  chunkIndex: number;
}): KeyRef {
  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0 || input.chunkIndex > 999_999) {
    throw new Error('Invalid chunk index');
  }
  const key = `${id(input.uploadSessionId, 'uploadSessionId')}/part-${String(input.chunkIndex).padStart(6, '0')}`;
  assertSafeKey(key);
  return { key, area: 'temporary' };
}

export function buildMigrationStagingKey(input: {
  migrationJobId: string;
  migrationItemId: string;
}): KeyRef {
  const key = `${id(input.migrationJobId, 'migrationJobId')}/${id(input.migrationItemId, 'migrationItemId')}`;
  assertSafeKey(key);
  return { key, area: 'migration-staging' };
}

export function buildExportKey(input: { userId: string; exportJobId: string }): KeyRef {
  const key = `${id(input.userId, 'userId')}/${id(input.exportJobId, 'exportJobId')}.zip`;
  assertSafeKey(key);
  return { key, area: 'exports' };
}

export function buildArchiveKey(input: {
  organizationId: string;
  year: number;
  fileId: string;
  versionId: string;
}): KeyRef {
  if (!Number.isInteger(input.year) || input.year < 1970 || input.year > 9999) {
    throw new Error('Invalid archive year');
  }
  const key = [
    id(input.organizationId, 'organizationId'),
    String(input.year),
    id(input.fileId, 'fileId'),
    id(input.versionId, 'versionId'),
  ].join('/');
  assertSafeKey(key);
  return { key, area: 'archives' };
}
