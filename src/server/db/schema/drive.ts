/**
 * Folders, files, versions — and the Google Drive ids that must survive the migration exactly.
 */
import { index, sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { CONFIDENTIALITY_LEVELS } from '@/server/domain/permissions';
import { RESOURCE_STATUSES } from '@/server/db/base-schema';
import { FILE_CATEGORIES } from '@/server/domain/file-types';
import { DRIVE_TYPES } from '@/server/db/models/folder.model';
import { APPROVAL_STATUSES, REVIEW_STATUSES } from '@/server/db/models/file.model';
import { PROCESSING_STATUSES, VERSION_LABELS } from '@/server/db/models/file-version.model';
import {
  DRIVE_MAPPING_STATUSES,
  FILE_STORAGE_PROVIDERS,
  GOOGLE_NATIVE_KINDS,
  LOCAL_COPY_STATES,
  STORAGE_MIGRATION_STATUSES,
  STORAGE_PROVIDERS,
  SYNC_STATUSES,
} from '@/server/db/storage-fields';
import { boolean, enumText, softDeleteColumns, timestampColumns } from './_shared';
import { departments, organizations, users } from './identity';
import { experiments, projects } from './research';

/* ------------------------------------------------------------------ folders */

export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),

    name: text('name').notNull(),
    /** Case-folded, so "Protocols" and "protocols" cannot both live in one parent. */
    nameLower: text('name_lower').notNull(),

    parentFolderId: text('parent_folder_id').references((): AnySQLiteColumn => folders.id),
    depth: integer('depth').notNull().default(0),

    driveType: enumText('drive_type', DRIVE_TYPES).notNull(),
    /** `my:{userId}` | `department:{departmentId}` | `project:{projectId}`; roots only. */
    rootKey: text('root_key'),

    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    departmentId: text('department_id').references(() => departments.id),
    projectId: text('project_id').references(() => projects.id),

    /** When false, ancestor ACLs stop applying at this folder. */
    inheritPermissions: boolean('inherit_permissions').notNull().default(true),

    confidentiality: enumText('confidentiality', CONFIDENTIALITY_LEVELS)
      .notNull()
      .default('internal'),
    status: enumText('status', RESOURCE_STATUSES).notNull().default('active'),

    description: text('description').notNull().default(''),
    color: text('color'),
    templateKey: text('template_key'),
    /** A drive root or template folder: renaming and deleting are refused. */
    isSystem: boolean('is_system').notNull().default(false),

    childFolderCount: integer('child_folder_count').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),

    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    updatedBy: text('updated_by').references(() => users.id),
    archivedAt: text('archived_at'),
    /** Set when trashed as part of an ancestor's deletion, so restore returns the same set. */
    trashedWithFolderId: text('trashed_with_folder_id').references(
      (): AnySQLiteColumn => folders.id,
    ),

    /** The mirrored Drive folder. MongoDB — now D1 — remains the hierarchy. */
    storageProvider: enumText('storage_provider', STORAGE_PROVIDERS).notNull().default('local'),
    googleDriveFolderId: text('google_drive_folder_id'),
    googleDriveParentFolderId: text('google_drive_parent_folder_id'),
    driveMappingStatus: enumText('drive_mapping_status', DRIVE_MAPPING_STATUSES)
      .notNull()
      .default('none'),
    driveMappedAt: text('drive_mapped_at'),
    syncStatus: enumText('sync_status', SYNC_STATUSES).notNull().default('not_required'),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    /** One root per user / department / project. Partial: only roots carry a rootKey. */
    uniqueIndex('ux_folders_root_key').on(table.rootKey).where(sql`root_key IS NOT NULL`),

    /**
     * No two live folders share a name inside one parent.
     *
     * Partial on both conditions, exactly as the Mongo index was: restricted to rows with a
     * real parent so the several roots with `parent_folder_id IS NULL` do not collide, and to
     * live rows so a trashed folder does not block re-creating the name.
     */
    uniqueIndex('ux_folders_parent_name')
      .on(table.parentFolderId, table.nameLower)
      .where(sql`deleted_at IS NULL AND parent_folder_id IS NOT NULL`),

    index('ix_folders_parent').on(
      table.organizationId,
      table.parentFolderId,
      table.deletedAt,
      table.name,
    ),
    index('ix_folders_drive_owner').on(
      table.organizationId,
      table.driveType,
      table.ownerId,
      table.deletedAt,
    ),
    index('ix_folders_department').on(table.organizationId, table.departmentId, table.deletedAt),
    index('ix_folders_project').on(table.organizationId, table.projectId, table.deletedAt),
    index('ix_folders_status').on(table.organizationId, table.status, table.deletedAt),

    /**
     * **One application folder maps to exactly one Drive folder, forever.**
     *
     * Unique and partial, reproducing the Mongo index. This is what makes "reuse the
     * existing Drive folder, never create a second one" an enforced invariant rather than a
     * convention the mirroring code is trusted to follow: two concurrent uploads into the
     * same new folder produce one Drive folder, because the loser of the race fails at the
     * database and re-reads.
     */
    uniqueIndex('ux_folders_drive_id')
      .on(table.googleDriveFolderId)
      .where(sql`google_drive_folder_id IS NOT NULL`),

    index('ix_folders_drive_mapping').on(table.organizationId, table.driveMappingStatus),
  ],
);

/* ------------------------------------------------------------------ folder_ancestors */

/**
 * `folders.pathAncestors[]` — the materialized ancestor list, root → parent.
 *
 * Stored as a closure table rather than a text path, for the same three reasons the array
 * existed in MongoDB, all of which are still true in SQL:
 *   • breadcrumbs      — one indexed read of a folder's ancestors, ordered by `depth`
 *   • subtree queries  — `WHERE ancestor_id = ?` finds every descendant
 *   • move safety      — the target's ancestors are already loaded, so a circular move is
 *                        caught before it happens
 *
 * A text path would break the moment a folder is renamed.
 */
export const folderAncestors = sqliteTable(
  'folder_ancestors',
  {
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    ancestorId: text('ancestor_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    /** 0 = the drive root, increasing towards the parent. Preserves the array's order. */
    depth: integer('depth').notNull(),
  },
  (table) => [
    uniqueIndex('ux_folder_ancestors').on(table.folderId, table.ancestorId),
    // The subtree direction — the expensive one, and the reason this is a table.
    index('ix_folder_ancestors_ancestor').on(table.ancestorId),
    index('ix_folder_ancestors_ordered').on(table.folderId, table.depth),
  ],
);

/* ------------------------------------------------------------------ files */

export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),

    displayName: text('display_name').notNull(),
    displayNameLower: text('display_name_lower').notNull(),
    /** Exactly what the user's machine called it, kept for download and provenance. */
    originalFilename: text('original_filename').notNull(),
    extension: text('extension').notNull(),
    category: enumText('category', FILE_CATEGORIES).notNull().default('other'),

    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id),
    driveType: enumText('drive_type', DRIVE_TYPES).notNull(),

    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    departmentId: text('department_id').references(() => departments.id),
    projectId: text('project_id').references(() => projects.id),
    experimentId: text('experiment_id').references(() => experiments.id),

    /**
     * Circular with `file_versions.file_id`. SQLite resolves FK targets at DML time, so both
     * can be declared at CREATE TABLE; the Phase 5 migration loads files, then versions, then
     * back-fills these two columns (step 12) under `PRAGMA defer_foreign_keys`.
     */
    currentVersionId: text('current_version_id'),
    /** The version reviewers signed off. Never silently replaced by a new upload. */
    approvedVersionId: text('approved_version_id'),
    versionCount: integer('version_count').notNull().default(0),

    /** Mirrors the current version, so a listing needs one query. */
    sizeBytes: integer('size_bytes').notNull().default(0),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    checksumSha256: text('checksum_sha256'),

    confidentiality: enumText('confidentiality', CONFIDENTIALITY_LEVELS)
      .notNull()
      .default('internal'),
    reviewStatus: enumText('review_status', REVIEW_STATUSES).notNull().default('draft'),
    approvalStatus: enumText('approval_status', APPROVAL_STATUSES).notNull().default('none'),
    status: enumText('status', RESOURCE_STATUSES).notNull().default('active'),

    inheritPermissions: boolean('inherit_permissions').notNull().default(true),

    downloadCount: integer('download_count').notNull().default(0),
    lastAccessedAt: text('last_accessed_at'),

    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    updatedBy: text('updated_by').references(() => users.id),
    archivedAt: text('archived_at'),
    trashedWithFolderId: text('trashed_with_folder_id').references(() => folders.id),

    /**
     * A read-only *category*, never an address.
     *
     * **No Drive id is stored on this table.** `file.model.ts` states the rule: a `File`
     * never holds a storage location, so a physical address cannot leak through a file
     * listing however carelessly it is serialized. Drive ids live on `file_versions`.
     *
     * `mixed` is a real state during migration — v1 local, v2 in Drive.
     */
    storageProvider: enumText('storage_provider', FILE_STORAGE_PROVIDERS)
      .notNull()
      .default('local'),
    hasGoogleNativeContent: boolean('has_google_native_content').notNull().default(false),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    index('ix_files_folder').on(table.folderId, table.deletedAt, table.displayName),
    index('ix_files_owner').on(table.organizationId, table.ownerId, table.deletedAt),
    index('ix_files_department').on(table.organizationId, table.departmentId, table.deletedAt),
    index('ix_files_project').on(table.organizationId, table.projectId, table.deletedAt),
    index('ix_files_experiment').on(table.experimentId),
    index('ix_files_review').on(table.organizationId, table.reviewStatus, table.updatedAt),
    index('ix_files_approval').on(table.organizationId, table.approvalStatus, table.updatedAt),
    index('ix_files_checksum').on(table.checksumSha256),
  ],
);

/** `files.folderPathAncestors[]` — "everything under this folder" in one indexed read. */
export const fileFolderAncestors = sqliteTable(
  'file_folder_ancestors',
  {
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    ancestorId: text('ancestor_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull(),
  },
  (table) => [
    uniqueIndex('ux_file_folder_ancestors').on(table.fileId, table.ancestorId),
    index('ix_file_folder_ancestors_ancestor').on(table.ancestorId),
  ],
);

/**
 * `files.metadata` — the free-form research metadata.
 *
 * Key/value rather than a JSON column because `sampleId`, `experimentCode` and `description`
 * are all searched (they carried their own weights in the Mongo text index) and several are
 * filtered on directly by `METADATA_QUERY_KEYS`.
 */
export const fileMetadata = sqliteTable(
  'file_metadata',
  {
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (table) => [
    uniqueIndex('ux_file_metadata').on(table.fileId, table.key),
    // The filter direction: "every file whose sampleId is S-4471".
    index('ix_file_metadata_lookup').on(table.key, table.value),
  ],
);

/* ------------------------------------------------------------------ file_versions */

export const fileVersions = sqliteTable(
  'file_versions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id),
    versionNumber: integer('version_number').notNull(),

    /**
     * Internal only — never serialized, never returned by an API.
     *
     * Retained after the Drive migration rather than cleared: a version carries both a local
     * key and a Drive id, and that redundancy is what makes a storage rollback a field flip
     * instead of moving data back.
     */
    storageKey: text('storage_key').notNull(),
    storageArea: text('storage_area').notNull(),
    relativeStoragePath: text('relative_storage_path'),
    storedFilename: text('stored_filename'),

    originalFilename: text('original_filename').notNull(),
    fileSize: integer('file_size').notNull(),
    mimeType: text('mime_type').notNull(),
    extension: text('extension').notNull(),
    /** Measured while streaming, never taken from the client. */
    checksumSha256: text('checksum_sha256').notNull(),

    uploadedBy: text('uploaded_by')
      .notNull()
      .references(() => users.id),
    uploadedAt: text('uploaded_at').notNull(),
    versionNote: text('version_note').notNull().default(''),
    restoredFromVersionId: text('restored_from_version_id').references(
      (): AnySQLiteColumn => fileVersions.id,
    ),

    processingStatus: enumText('processing_status', PROCESSING_STATUSES)
      .notNull()
      .default('pending'),
    label: enumText('label', VERSION_LABELS).notNull().default('draft'),
    isCurrent: boolean('is_current').notNull().default(false),
    isApproved: boolean('is_approved').notNull().default(false),
    approvedBy: text('approved_by').references(() => users.id),
    approvedAt: text('approved_at'),

    /** The exact remote state an approval was granted against, and whether it still holds. */
    approvedRevisionId: text('approved_revision_id'),
    approvedContentModifiedAt: text('approved_content_modified_at'),
    approvalSupersededAt: text('approval_superseded_at'),
    approvalSupersededReason: text('approval_superseded_reason'),

    previewKey: text('preview_key'),
    previewStatus: enumText('preview_status', [
      'none',
      'pending',
      'ready',
      'unsupported',
      'failed',
    ] as const)
      .notNull()
      .default('none'),

    /** Where the bytes live externally, and how far through migration this version is. */
    storageProvider: enumText('storage_provider', STORAGE_PROVIDERS).notNull().default('local'),
    googleDriveFileId: text('google_drive_file_id'),
    googleDriveParentId: text('google_drive_parent_id'),
    /** Binds an approval to an exact state; changes when a native document is edited. */
    googleDriveRevisionId: text('google_drive_revision_id'),
    /** Drive publishes MD5 and no SHA-256, so this is what a re-verification compares. */
    googleDriveMd5: text('google_drive_md5'),
    googleDriveModifiedTime: text('google_drive_modified_time'),
    googleDriveWebViewLink: text('google_drive_web_view_link'),

    migrationStatus: enumText('migration_status', STORAGE_MIGRATION_STATUSES)
      .notNull()
      .default('not_started'),
    migratedAt: text('migrated_at'),
    migrationFailureReason: text('migration_failure_reason'),

    syncStatus: enumText('sync_status', SYNC_STATUSES).notNull().default('not_required'),
    lastSyncedAt: text('last_synced_at'),

    localCopyState: enumText('local_copy_state', LOCAL_COPY_STATES).notNull().default('present'),
    localCopyEligibleForDeletionAt: text('local_copy_eligible_for_deletion_at'),
    archivedStorageKey: text('archived_storage_key'),
    localCopyArchivedAt: text('local_copy_archived_at'),
    localCopyDeletedAt: text('local_copy_deleted_at'),

    isGoogleNative: boolean('is_google_native').notNull().default(false),
    googleNativeKind: enumText('google_native_kind', GOOGLE_NATIVE_KINDS),

    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('ux_file_versions_number').on(table.fileId, table.versionNumber),
    uniqueIndex('ux_file_versions_storage_key').on(table.storageKey),
    index('ix_file_versions_current').on(table.fileId, table.isCurrent),
    index('ix_file_versions_checksum').on(table.checksumSha256),
    index('ix_file_versions_processing').on(
      table.organizationId,
      table.processingStatus,
      table.createdAt,
    ),

    /**
     * **The hard guarantee against duplicate uploads on retry.**
     *
     * Unique and partial, so it constrains only rows that have actually been migrated. A
     * retry that would record a second Drive file for the same version fails *at the
     * database* rather than relying on the worker's own bookkeeping — which is the layer that
     * is by definition unavailable when the worker has just crashed.
     */
    uniqueIndex('ux_file_versions_drive_id')
      .on(table.googleDriveFileId)
      .where(sql`google_drive_file_id IS NOT NULL`),

    /** The migration worker's cursor: "next N unmigrated versions, in a stable order". */
    index('ix_file_versions_migration').on(table.storageProvider, table.migrationStatus, table.id),

    /** Only rows a sync worker would act on — keeps the index small as the corpus grows. */
    index('ix_file_versions_sync')
      .on(table.syncStatus, table.lastSyncedAt)
      .where(sql`sync_status IN ('pending', 'failed', 'conflict')`),

    /** The approval-integrity sweep: which live approvals are bound to remote content? */
    index('ix_file_versions_approval_integrity')
      .on(table.storageProvider, table.approvalSupersededAt, table.id)
      .where(sql`is_approved = 1`),

    /** The retention sweep: which local copies are now old enough to consider removing. */
    index('ix_file_versions_local_copy')
      .on(table.localCopyState, table.localCopyEligibleForDeletionAt)
      .where(sql`local_copy_state = 'present'`),
  ],
);

/* ------------------------------------------------------------------ resource_tags */

/**
 * `files.tags[]`, `projects.tags[]`, `experiments.tags[]`.
 *
 * One table for three owners, for the same reason `resource_permissions` is one table: the
 * shape is identical, faceted search reads across all three, and three tables would be three
 * indexes and a union.
 */
export const resourceTags = sqliteTable(
  'resource_tags',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    resourceType: enumText('resource_type', ['file', 'project', 'experiment'] as const).notNull(),
    resourceId: text('resource_id').notNull(),
    tag: text('tag').notNull(),
  },
  (table) => [
    uniqueIndex('ux_resource_tags').on(table.resourceType, table.resourceId, table.tag),
    // The facet direction: "every file tagged tox-study".
    index('ix_resource_tags_tag').on(table.organizationId, table.tag, table.resourceType),
  ],
);
