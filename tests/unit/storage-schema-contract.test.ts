/**
 * Phase 3 — the parts of the schema that are a *contract*, checked without a database.
 *
 * Two kinds of assertion live here.
 *
 * **Persisted vocabularies.** Every string in `storage-fields.ts` is written into MongoDB
 * documents, so renaming one is a data migration rather than a refactor. Pinning the lists
 * means a rename cannot happen by accident during an edit — it has to be a deliberate act
 * that also updates this file.
 *
 * **Employee-facing leakage.** §19 of the migration brief: a normal employee must never see
 * a storage provider, a Drive id, a revision, a migration status or a storage key. The DTO
 * layer is an explicit allow-list, so a new schema field cannot reach an API response
 * unless somebody adds it — these tests are what make that omission a deliberate,
 * test-enforced decision instead of a happy accident.
 */
import { describe, expect, it } from 'vitest';

import {
  DRIVE_MAPPING_STATUSES,
  FILE_STORAGE_PROVIDERS,
  GOOGLE_NATIVE_KINDS,
  IN_FLIGHT_MIGRATION_STATUSES,
  LOCAL_COPY_STATES,
  STORAGE_MIGRATION_STATUSES,
  STORAGE_PROVIDERS,
  SYNC_STATUSES,
} from '@/server/db/storage-fields';
import { FileVersionModel, IMMUTABLE_VERSION_PATHS } from '@/server/db/models/file-version.model';
import { FolderModel } from '@/server/db/models/folder.model';
import { FileModel } from '@/server/db/models/file.model';
import { STORAGE_PROVIDERS as PROVIDERS_FROM_STORAGE_LAYER } from '@/server/storage/types';
import { AUDIT_ACTIONS } from '@/server/db/models/audit-log.model';
import { toFileDto, toVersionDto } from '@/server/http/dto';

describe('persisted vocabularies', () => {
  /**
   * The registry dispatches on this value and every version document stores it. Two
   * definitions would let the database and the provider lookup drift apart, which fails as
   * "provider not available on this deployment" on a record that is perfectly fine.
   */
  it('shares one definition of the provider names with the storage layer', () => {
    expect(STORAGE_PROVIDERS).toBe(PROVIDERS_FROM_STORAGE_LAYER);
    expect([...STORAGE_PROVIDERS]).toEqual(['local', 'google_drive']);
  });

  it('pins the migration statuses named in the brief', () => {
    expect([...STORAGE_MIGRATION_STATUSES]).toEqual([
      'not_started',
      'queued',
      'uploading',
      'uploaded',
      'verifying',
      'verified',
      'failed',
      'rolled_back',
    ]);
  });

  it('pins the sync statuses named in the brief', () => {
    expect([...SYNC_STATUSES]).toEqual(['not_required', 'pending', 'synced', 'failed', 'conflict']);
  });

  it('pins the remaining vocabularies', () => {
    expect([...FILE_STORAGE_PROVIDERS]).toEqual(['local', 'google_drive', 'mixed']);
    expect([...LOCAL_COPY_STATES]).toEqual(['present', 'archived', 'deleted']);
    expect([...DRIVE_MAPPING_STATUSES]).toEqual(['none', 'creating', 'mapped', 'failed']);
    expect([...GOOGLE_NATIVE_KINDS]).toEqual(['document', 'spreadsheet', 'presentation']);
  });

  /**
   * `uploaded` and `verified` are distinct events: bytes arriving is not the same as bytes
   * being proved correct. Only `verified` may authorise deleting a local copy, so `verified`
   * must never be treated as still-in-flight and `uploaded` must never be treated as done.
   */
  it('treats a transfer as in flight up to and including verification', () => {
    expect([...IN_FLIGHT_MIGRATION_STATUSES]).toEqual(['uploading', 'uploaded', 'verifying']);
    expect(IN_FLIGHT_MIGRATION_STATUSES).not.toContain('verified');
    expect(IN_FLIGHT_MIGRATION_STATUSES).not.toContain('failed');
  });
});

describe('schema shape', () => {
  it('adds every storage field to FileVersion with a default', () => {
    const paths = FileVersionModel.schema.paths;
    for (const field of [
      'storageProvider',
      'googleDriveFileId',
      'googleDriveRevisionId',
      'googleDriveMd5',
      'migrationStatus',
      'syncStatus',
      'localCopyState',
      'isGoogleNative',
    ]) {
      expect(paths[field], `${field} missing from FileVersion`).toBeDefined();
      // A field with no default would read back undefined on a pre-Phase-3 document, and
      // the provider registry would then refuse to resolve it.
      expect(paths[field]!.options.default, `${field} has no default`).toBeDefined();
    }
  });

  it('keeps the local storage key required and unaffected', () => {
    // After migration a version holds both addresses. That redundancy is what makes a
    // rollback a field flip rather than moving data back, so the key must never become
    // optional or be cleared.
    expect(FileVersionModel.schema.paths.storageKey!.isRequired).toBe(true);
    expect(FileVersionModel.schema.paths.storageArea!.isRequired).toBe(true);
  });

  it('declares the immutable content-identity paths it claims to protect', () => {
    for (const path of IMMUTABLE_VERSION_PATHS) {
      expect(FileVersionModel.schema.paths[path], `${path} is not a real path`).toBeDefined();
    }
    // The set answering "which bytes did they approve?" must not shrink.
    expect(IMMUTABLE_VERSION_PATHS).toContain('checksumSha256');
    expect(IMMUTABLE_VERSION_PATHS).toContain('fileSize');
    expect(IMMUTABLE_VERSION_PATHS).toContain('storageKey');
  });

  it('gives Folder its mapping fields and File only a category', () => {
    expect(FolderModel.schema.paths.googleDriveFolderId).toBeDefined();
    expect(FolderModel.schema.paths.driveMappingStatus).toBeDefined();

    expect(FileModel.schema.paths.storageProvider).toBeDefined();
    expect(FileModel.schema.paths.hasGoogleNativeContent).toBeDefined();
    // A File has never held an address and still does not.
    expect(FileModel.schema.paths.googleDriveFileId).toBeUndefined();
    expect(FileModel.schema.paths.storageKey).toBeUndefined();
  });

  it('declares the unique partial indexes the guarantees rest on', () => {
    const versionIndexes = FileVersionModel.schema.indexes();
    const driveFileIndex = versionIndexes.find(([key]) => 'googleDriveFileId' in key);
    expect(driveFileIndex?.[1]?.unique).toBe(true);
    // Partial, or every unmigrated version would collide on null.
    expect(driveFileIndex?.[1]?.partialFilterExpression).toBeDefined();

    const folderIndex = FolderModel.schema.indexes().find(([key]) => 'googleDriveFolderId' in key);
    expect(folderIndex?.[1]?.unique).toBe(true);
    expect(folderIndex?.[1]?.partialFilterExpression).toBeDefined();
  });
});

describe('audit actions distinguish the two migrations', () => {
  /**
   * This platform has an inbound Drive importer using `migration.*`. An operator reading the
   * audit log during an incident must be able to tell "we imported from a Drive" from "we
   * moved company files into the Shared Drive" at a glance.
   */
  it('keeps the outbound storage migration on its own prefix', () => {
    const storage = AUDIT_ACTIONS.filter((a) => a.startsWith('storage_migration.'));
    const inbound = AUDIT_ACTIONS.filter((a) => a.startsWith('migration.'));

    expect(storage.length).toBeGreaterThan(0);
    expect(inbound.length).toBeGreaterThan(0);
    expect(storage.some((a) => inbound.includes(a))).toBe(false);
  });

  it('covers every action §17 of the brief asks for', () => {
    for (const action of [
      'storage_migration.queued',
      'storage_migration.started',
      'storage_migration.completed',
      'storage_migration.failed',
      'storage_migration.retried',
      'storage_migration.rolled_back',
      'storage_migration.provider_changed',
      'storage_migration.local_copy_archived',
      'storage_migration.local_copy_deleted',
      'drive_storage.connection_established',
      'drive_storage.connection_failed',
      'drive_storage.sync_started',
      'drive_storage.sync_completed',
      'drive_storage.sync_conflict',
      'drive_storage.file_missing',
    ] as const) {
      expect(AUDIT_ACTIONS, `${action} missing`).toContain(action);
    }
  });
});

/**
 * §19: the migration must be invisible to a normal employee. These fields exist to run it;
 * none of them is anything a bench scientist should ever be shown.
 */
describe('none of it reaches an employee-facing response', () => {
  const FORBIDDEN = /googleDrive|storageProvider|storageKey|storageArea|migrationStatus|syncStatus|localCopy|isGoogleNative|googleNativeKind|relativeStoragePath|storedFilename/;

  it('omits every storage field from the version DTO', () => {
    // A record carrying all of them — if the DTO copied fields wholesale, they would appear.
    const record = {
      id: 'v1',
      fileId: 'f1',
      versionNumber: 1,
      originalFilename: 'a.csv',
      fileSize: 10,
      mimeType: 'text/csv',
      extension: 'csv',
      checksumSha256: 'x'.repeat(64),
      uploadedBy: 'u1',
      uploadedAt: new Date(),
      versionNote: '',
      restoredFromVersionId: null,
      processingStatus: 'ready',
      label: 'draft',
      isCurrent: true,
      isApproved: false,
      approvedBy: null,
      approvedAt: null,
      previewStatus: 'none',
      storageProvider: 'google_drive',
      storageKey: 'originals/aa/bb',
      storageArea: 'originals',
      googleDriveFileId: 'drive-secret',
      googleDriveRevisionId: 'rev-9',
      googleDriveMd5: 'y'.repeat(32),
      migrationStatus: 'verified',
      syncStatus: 'synced',
      localCopyState: 'present',
      isGoogleNative: false,
    };

    const dto = toVersionDto(record as never);

    expect(Object.keys(dto).filter((key) => FORBIDDEN.test(key))).toEqual([]);
    expect(JSON.stringify(dto)).not.toContain('drive-secret');
    expect(JSON.stringify(dto)).not.toContain('originals/aa/bb');
  });

  it('omits the storage category from the file DTO', () => {
    const record = {
      id: 'f1',
      displayName: 'a.csv',
      originalFilename: 'a.csv',
      extension: 'csv',
      category: 'spreadsheet',
      folderId: 'fo1',
      driveType: 'my',
      ownerId: 'u1',
      departmentId: null,
      projectId: null,
      experimentId: null,
      currentVersionId: 'v1',
      approvedVersionId: null,
      versionCount: 1,
      sizeBytes: 10,
      mimeType: 'text/csv',
      checksumSha256: null,
      tags: [],
      metadata: {},
      confidentiality: 'internal',
      reviewStatus: 'draft',
      approvalStatus: 'none',
      status: 'active',
      inheritPermissions: true,
      downloadCount: 0,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      storageProvider: 'mixed',
      hasGoogleNativeContent: true,
    };

    const dto = toFileDto(record as never);

    expect(Object.keys(dto).filter((key) => FORBIDDEN.test(key))).toEqual([]);
    expect(Object.keys(dto)).not.toContain('hasGoogleNativeContent');
  });
});
