/**
 * Folders, files, versions — and the two arrays that become closure tables.
 *
 * This is the largest group and the one with the most ways to be subtly wrong, so three
 * decisions are worth stating before the code:
 *
 * 1. **The hierarchy is written twice, on purpose.** `folders` goes in with `parent_folder_id`
 *    NULL, and `folder-hierarchy` back-fills the parent and writes `folder_ancestors`. There is
 *    no `_id` ordering that satisfies a self-referencing foreign key, because a folder created
 *    before its parent is perfectly ordinary — a drive root created lazily under a folder that
 *    already existed is exactly that shape.
 *
 * 2. **`pathAncestors` carries its own order and that order is the depth.** MongoDB stored the
 *    array root → parent. `folder_ancestors.depth` preserves the index, so breadcrumbs come out
 *    in the same order they went in without re-deriving anything from the tree.
 *
 * 3. **`files.currentVersionId` is written before the version exists, and that is legal.** It
 *    is not a foreign key in D1 — `schema/drive.ts` says so and explains why — so the load
 *    order files → versions needs no back-fill. The verification pass checks the pointer
 *    resolves, which is the guarantee that actually matters.
 */
import { FileModel, FileVersionModel, FolderModel } from '@/server/db/models';
import { RESOURCE_STATUSES } from '@/server/db/base-schema';
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
import { CONFIDENTIALITY_LEVELS } from '@/server/domain/permissions';
import { FILE_CATEGORIES } from '@/server/domain/file-types';
import {
  bool,
  enumValue,
  iso,
  nullableEnum,
  nullableStr,
  num,
  oid,
  oidList,
  requiredIso,
  requiredOid,
  str,
} from '../convert';
import { deleteWhere, fileFtsContent, insert, refreshFileFts, update, upsert } from '../sql';
import { modelStep } from '../step-helpers';
import type { MigrationStep, Statement } from '../types';
import { timestamps } from './identity';
import { tagStatements } from './research';

export const foldersStep: MigrationStep = modelStep({
  name: 'folders',
  description: 'Folders (parent references deferred)',
  targets: ['folders', 'folders_fts'],
  requires: ['organizations', 'users', 'departments', 'projects'],
  publishes: 'folders',
  model: FolderModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'folders._id');
    const organizationId = requiredOid(document.organizationId, 'folders.organizationId');
    const ownerId = requiredOid(document.ownerId, 'folders.ownerId');
    const createdBy = requiredOid(document.createdBy, 'folders.createdBy');

    const knownUsers = context.known.get('users');
    if (!knownUsers?.has(ownerId)) {
      return { kind: 'skip', reason: `owner ${ownerId} was not migrated` };
    }
    if (!knownUsers.has(createdBy)) {
      return { kind: 'skip', reason: `creator ${createdBy} was not migrated` };
    }

    const departmentId = oid(document.departmentId);
    const projectId = oid(document.projectId);
    const updatedBy = oid(document.updatedBy);

    return {
      kind: 'write',
      statements: [
        upsert('folders', {
          id,
          organization_id: organizationId,
          name: str(document.name),
          name_lower: str(document.nameLower, str(document.name).toLowerCase()),
          parent_folder_id: null,
          depth: num(document.depth),
          drive_type: enumValue(document.driveType, DRIVE_TYPES, 'my'),
          root_key: nullableStr(document.rootKey),
          owner_id: ownerId,
          department_id:
            departmentId && context.known.get('departments')?.has(departmentId)
              ? departmentId
              : null,
          project_id:
            projectId && context.known.get('projects')?.has(projectId) ? projectId : null,
          inherit_permissions: bool(document.inheritPermissions),
          confidentiality: enumValue(document.confidentiality, CONFIDENTIALITY_LEVELS, 'internal'),
          status: enumValue(document.status, RESOURCE_STATUSES, 'active'),
          description: str(document.description),
          color: nullableStr(document.color),
          template_key: nullableStr(document.templateKey),
          is_system: bool(document.isSystem),
          child_folder_count: num(document.childFolderCount),
          file_count: num(document.fileCount),
          created_by: createdBy,
          updated_by: updatedBy && knownUsers.has(updatedBy) ? updatedBy : null,
          archived_at: iso(document.archivedAt),
          trashed_with_folder_id: null,
          storage_provider: enumValue(document.storageProvider, STORAGE_PROVIDERS, 'local'),
          // The Drive mapping moves **unchanged**. `ux_folders_drive_id` makes one application
          // folder map to exactly one Drive folder forever, and re-deriving the mapping at
          // cutover would risk adopting a different folder for content that is already in one.
          google_drive_folder_id: nullableStr(document.googleDriveFolderId),
          google_drive_parent_folder_id: nullableStr(document.googleDriveParentFolderId),
          drive_mapping_status: enumValue(
            document.driveMappingStatus,
            DRIVE_MAPPING_STATUSES,
            'none',
          ),
          drive_mapped_at: iso(document.driveMappedAt),
          sync_status: enumValue(document.syncStatus, SYNC_STATUSES, 'not_required'),
          ...timestamps(document),
          deleted_at: iso(document.deletedAt),
          deleted_by: oid(document.deletedBy),
        }),
      ],
    };
  },
});

/**
 * The folder tree: `parent_folder_id`, `trashed_with_folder_id`, and `folder_ancestors`.
 *
 * `trashed_with_folder_id` is not bookkeeping. It records that a folder was trashed as part of
 * an ancestor's deletion, and restoring the ancestor restores exactly that set — lose it and a
 * restore brings back a different tree than the one that was trashed.
 */
export const folderHierarchyStep: MigrationStep = modelStep({
  name: 'folder-hierarchy',
  description: 'Folder parents and the ancestor closure table',
  targets: ['folders', 'folder_ancestors'],
  requires: ['folders'],
  model: FolderModel as never,
  withDeleted: true,
  select: '_id parentFolderId pathAncestors trashedWithFolderId',
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'folders._id');
    const known = context.known.get('folders');
    if (!known?.has(id)) {
      return { kind: 'skip', reason: 'the folder itself was not migrated' };
    }

    const parentFolderId = oid(document.parentFolderId);
    const trashedWith = oid(document.trashedWithFolderId);

    const statements: Statement[] = [
      update(
        'folders',
        {
          parent_folder_id:
            parentFolderId && known.has(parentFolderId) ? parentFolderId : null,
          trashed_with_folder_id: trashedWith && known.has(trashedWith) ? trashedWith : null,
        },
        { id },
      ),
      deleteWhere('folder_ancestors', { folder_id: id }),
    ];

    // The array is ordered root → parent, and the index *is* the depth. Preserving it is what
    // makes a breadcrumb one indexed read ordered by `depth` rather than a walk up the tree.
    const ancestors = oidList(document.pathAncestors);
    const seen = new Set<string>();
    ancestors.forEach((ancestorId, index) => {
      if (!known.has(ancestorId) || seen.has(ancestorId)) return;
      seen.add(ancestorId);
      statements.push(
        insert('folder_ancestors', { folder_id: id, ancestor_id: ancestorId, depth: index }),
      );
    });

    return { kind: 'write', statements };
  },
});

/**
 * Files, their metadata, their tags, their folder-ancestor rows and their FTS row.
 *
 * `files.metadata` is a `Mixed` document in MongoDB and a key/value table in D1, because
 * `sampleId`, `experimentCode` and `description` are searched and several are filtered on
 * directly. Nested objects are stored as their JSON text: `METADATA_QUERY_KEYS` only ever
 * filters on scalars, and flattening a nested object into dotted keys would invent a schema the
 * application does not have.
 */
export const filesStep: MigrationStep = modelStep({
  name: 'files',
  description: 'Files, metadata, tags, folder ancestors and the search index',
  targets: [
    'files',
    'file_metadata',
    'file_folder_ancestors',
    'resource_tags',
    'files_fts',
  ],
  requires: ['folders', 'users', 'experiments'],
  publishes: 'files',
  model: FileModel as never,
  withDeleted: true,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'files._id');
    const organizationId = requiredOid(document.organizationId, 'files.organizationId');
    const folderId = requiredOid(document.folderId, 'files.folderId');
    const ownerId = requiredOid(document.ownerId, 'files.ownerId');
    const createdBy = requiredOid(document.createdBy, 'files.createdBy');

    const knownFolders = context.known.get('folders');
    const knownUsers = context.known.get('users');
    // `files.folder_id` is NOT NULL and a foreign key. A file whose folder is gone has nowhere
    // to live, and putting it somewhere else would move research data into a folder its
    // permissions were never checked against.
    if (!knownFolders?.has(folderId)) {
      return { kind: 'skip', reason: `folder ${folderId} was not migrated` };
    }
    if (!knownUsers?.has(ownerId)) {
      return { kind: 'skip', reason: `owner ${ownerId} was not migrated` };
    }
    if (!knownUsers.has(createdBy)) {
      return { kind: 'skip', reason: `creator ${createdBy} was not migrated` };
    }

    const departmentId = oid(document.departmentId);
    const projectId = oid(document.projectId);
    const experimentId = oid(document.experimentId);
    const updatedBy = oid(document.updatedBy);
    const trashedWith = oid(document.trashedWithFolderId);
    const displayName = str(document.displayName);
    const originalFilename = str(document.originalFilename);
    const metadata =
      document.metadata && typeof document.metadata === 'object'
        ? (document.metadata as Record<string, unknown>)
        : {};
    const tags = [
      ...new Set(
        (Array.isArray(document.tags) ? document.tags : [])
          .map((value) => str(value))
          .filter((value) => value.length > 0),
      ),
    ];

    const statements: Statement[] = [
      upsert('files', {
        id,
        organization_id: organizationId,
        display_name: displayName,
        display_name_lower: str(document.displayNameLower, displayName.toLowerCase()),
        original_filename: originalFilename,
        extension: str(document.extension),
        category: enumValue(document.category, FILE_CATEGORIES, 'other'),
        folder_id: folderId,
        drive_type: enumValue(document.driveType, DRIVE_TYPES, 'my'),
        owner_id: ownerId,
        department_id:
          departmentId && context.known.get('departments')?.has(departmentId) ? departmentId : null,
        project_id: projectId && context.known.get('projects')?.has(projectId) ? projectId : null,
        experiment_id:
          experimentId && context.known.get('experiments')?.has(experimentId) ? experimentId : null,
        // Not foreign keys — versions are loaded next and the verification pass checks the
        // pointers resolve. See the header.
        current_version_id: oid(document.currentVersionId),
        approved_version_id: oid(document.approvedVersionId),
        version_count: num(document.versionCount),
        size_bytes: num(document.sizeBytes),
        mime_type: str(document.mimeType, 'application/octet-stream'),
        checksum_sha256: nullableStr(document.checksumSha256),
        confidentiality: enumValue(document.confidentiality, CONFIDENTIALITY_LEVELS, 'internal'),
        review_status: enumValue(document.reviewStatus, REVIEW_STATUSES, 'draft'),
        approval_status: enumValue(document.approvalStatus, APPROVAL_STATUSES, 'none'),
        status: enumValue(document.status, RESOURCE_STATUSES, 'active'),
        inherit_permissions: bool(document.inheritPermissions),
        download_count: num(document.downloadCount),
        last_accessed_at: iso(document.lastAccessedAt),
        created_by: createdBy,
        updated_by: updatedBy && knownUsers.has(updatedBy) ? updatedBy : null,
        archived_at: iso(document.archivedAt),
        trashed_with_folder_id: trashedWith && knownFolders.has(trashedWith) ? trashedWith : null,
        storage_provider: enumValue(document.storageProvider, FILE_STORAGE_PROVIDERS, 'local'),
        has_google_native_content: bool(document.hasGoogleNativeContent),
        ...timestamps(document),
        deleted_at: iso(document.deletedAt),
        deleted_by: oid(document.deletedBy),
      }),
      deleteWhere('file_metadata', { file_id: id }),
      deleteWhere('file_folder_ancestors', { file_id: id }),
      ...tagStatements('file', id, organizationId, tags),
    ];

    for (const [key, value] of Object.entries(metadata)) {
      if (value === null || value === undefined) continue;
      statements.push(
        insert('file_metadata', {
          file_id: id,
          key,
          value: typeof value === 'object' ? JSON.stringify(value) : String(value),
        }),
      );
    }

    const ancestors = oidList(document.folderPathAncestors);
    const seen = new Set<string>();
    ancestors.forEach((ancestorId, index) => {
      if (!knownFolders.has(ancestorId) || seen.has(ancestorId)) return;
      seen.add(ancestorId);
      statements.push(
        insert('file_folder_ancestors', { file_id: id, ancestor_id: ancestorId, depth: index }),
      );
    });

    /**
     * The FTS row, built here rather than left to the insert trigger.
     *
     * `trg_files_fts_insert` writes empty `keywords` and `description`, because at INSERT time
     * the tag and metadata rows do not exist. Nothing re-aggregates them unless the `files` row
     * is updated again — so a migrated corpus would be searchable by filename and by nothing
     * else, and the symptom is a search returning fewer results than it should, which nobody
     * notices until somebody insists a file exists.
     *
     * A trashed file gets no row: the trigger's own `WHERE deleted_at IS NULL`.
     */
    statements.push(
      ...refreshFileFts(
        id,
        document.deletedAt
          ? null
          : fileFtsContent(displayName, originalFilename, tags, metadata),
      ),
    );

    return { kind: 'write', statements };
  },
});

/**
 * File versions — the immutable record of what was uploaded and, for an approved version, of
 * exactly which bytes a reviewer signed.
 *
 * Every content-identity field moves verbatim: `checksum_sha256`, `file_size`, `mime_type`,
 * `extension`, `original_filename`, `version_number`, `storage_key`. The Mongoose hook that
 * makes them immutable is stated in `IMMUTABLE_VERSION_PATHS`, and the reason a migration must
 * not "normalise" any of them is the same reason the hook exists: a migration that could rewrite
 * a checksum could hide a corrupt transfer by recording the corruption as expected.
 *
 * `restored_from_version_id` is deferred — it points at another version, and a restore can
 * reference a version with a higher `_id` than its own is not possible, but a version restored
 * from one in a *different* file batch is. Deferring costs one extra pass and removes the
 * question entirely.
 */
export const fileVersionsStep: MigrationStep = modelStep({
  name: 'file-versions',
  description: 'File versions (restore references deferred)',
  targets: ['file_versions'],
  requires: ['files', 'users'],
  publishes: 'file_versions',
  model: FileVersionModel as never,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'file_versions._id');
    const organizationId = requiredOid(document.organizationId, 'file_versions.organizationId');
    const fileId = requiredOid(document.fileId, 'file_versions.fileId');
    const uploadedBy = requiredOid(document.uploadedBy, 'file_versions.uploadedBy');

    if (!context.known.get('files')?.has(fileId)) {
      return { kind: 'skip', reason: `file ${fileId} was not migrated` };
    }
    const knownUsers = context.known.get('users');
    if (!knownUsers?.has(uploadedBy)) {
      return { kind: 'skip', reason: `uploader ${uploadedBy} was not migrated` };
    }
    const approvedBy = oid(document.approvedBy);

    return {
      kind: 'write',
      statements: [
        upsert('file_versions', {
          id,
          organization_id: organizationId,
          file_id: fileId,
          version_number: num(document.versionNumber, 1),
          storage_key: str(document.storageKey),
          storage_area: str(document.storageArea),
          relative_storage_path: nullableStr(document.relativeStoragePath),
          stored_filename: nullableStr(document.storedFilename),
          original_filename: str(document.originalFilename),
          file_size: num(document.fileSize),
          mime_type: str(document.mimeType, 'application/octet-stream'),
          extension: str(document.extension),
          checksum_sha256: str(document.checksumSha256),
          uploaded_by: uploadedBy,
          uploaded_at: requiredIso(
            document.uploadedAt,
            requiredIso(document.createdAt, new Date(0).toISOString()),
          ),
          version_note: str(document.versionNote),
          restored_from_version_id: null,
          processing_status: enumValue(document.processingStatus, PROCESSING_STATUSES, 'pending'),
          label: enumValue(document.label, VERSION_LABELS, 'draft'),
          is_current: bool(document.isCurrent),
          is_approved: bool(document.isApproved),
          approved_by: approvedBy && knownUsers.has(approvedBy) ? approvedBy : null,
          approved_at: iso(document.approvedAt),
          approved_revision_id: nullableStr(document.approvedRevisionId),
          approved_content_modified_at: iso(document.approvedContentModifiedAt),
          approval_superseded_at: iso(document.approvalSupersededAt),
          approval_superseded_reason: nullableStr(document.approvalSupersededReason),
          preview_key: nullableStr(document.previewKey),
          preview_status: enumValue(
            document.previewStatus,
            ['none', 'pending', 'ready', 'unsupported', 'failed'] as const,
            'none',
          ),
          storage_provider: enumValue(document.storageProvider, STORAGE_PROVIDERS, 'local'),
          google_drive_file_id: nullableStr(document.googleDriveFileId),
          google_drive_parent_id: nullableStr(document.googleDriveParentId),
          google_drive_revision_id: nullableStr(document.googleDriveRevisionId),
          google_drive_md5: nullableStr(document.googleDriveMd5),
          google_drive_modified_time: iso(document.googleDriveModifiedTime),
          google_drive_web_view_link: nullableStr(document.googleDriveWebViewLink),
          migration_status: enumValue(
            document.migrationStatus,
            STORAGE_MIGRATION_STATUSES,
            'not_started',
          ),
          migrated_at: iso(document.migratedAt),
          migration_failure_reason: nullableStr(document.migrationFailureReason),
          sync_status: enumValue(document.syncStatus, SYNC_STATUSES, 'not_required'),
          last_synced_at: iso(document.lastSyncedAt),
          local_copy_state: enumValue(document.localCopyState, LOCAL_COPY_STATES, 'present'),
          local_copy_eligible_for_deletion_at: iso(document.localCopyEligibleForDeletionAt),
          archived_storage_key: nullableStr(document.archivedStorageKey),
          local_copy_archived_at: iso(document.localCopyArchivedAt),
          local_copy_deleted_at: iso(document.localCopyDeletedAt),
          is_google_native: bool(document.isGoogleNative),
          google_native_kind: nullableEnum(document.googleNativeKind, GOOGLE_NATIVE_KINDS),
          ...timestamps(document),
        }),
      ],
    };
  },
});

export const fileVersionBackfillStep: MigrationStep = modelStep({
  name: 'file-versions-backfill',
  description: 'Restore-source references between versions',
  targets: ['file_versions'],
  requires: ['file-versions'],
  model: FileVersionModel as never,
  select: '_id restoredFromVersionId',
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'file_versions._id');
    const restoredFrom = oid(document.restoredFromVersionId);
    if (!restoredFrom) return { kind: 'write', statements: [] };

    const known = context.known.get('file_versions');
    return {
      kind: 'write',
      statements: [
        update(
          'file_versions',
          { restored_from_version_id: known?.has(restoredFrom) ? restoredFrom : null },
          { id },
        ),
      ],
    };
  },
});
