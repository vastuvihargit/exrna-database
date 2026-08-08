/**
 * Version persistence on D1.
 *
 * The MongoDB implementation's counterpart, held to `file-version.repository.contract.ts`. Read
 * that first: it explains why "current" is recorded both as `files.current_version_id` and as
 * `file_versions.is_current`, and why the storage key, the Drive id and the approval binding
 * are reachable only through separate, conspicuously named calls rather than from
 * `VersionRecord`.
 *
 * ── Dates ───────────────────────────────────────────────────────────────────────────────
 *
 * Every timestamp column is ISO text, and every record field is a `Date`. The conversion is at
 * the edges — `toDate` on the way out, `toIso` on the way in — so nothing downstream can tell
 * which engine answered. Text comparison on ISO-8601 UTC is the same ordering as time, which is
 * what lets `last_synced_at` and the id cursors be compared in SQL.
 *
 * ── What is not here ────────────────────────────────────────────────────────────────────
 *
 * Creating a version. It writes a `file_versions` row *and* repoints `files.current_version_id`
 * and those are two repositories, so it lives in `d1-unit-of-work.ts` as one batch. `create`
 * below writes only the version row, exactly as the Mongo one does, and remains available for
 * the callers that genuinely want only that.
 *
 * No Google API client, no filesystem, no Mongoose. This module stores Drive *metadata*; the
 * calls that talk to Drive live in the storage layer, and a `workerd` smoke test asserts the
 * module graph stays free of Node built-ins.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { withBatch, type Database } from '@/server/db/d1';
import { getD1 } from '@/server/db/d1-context';
import { fileVersions } from '@/server/db/schema/drive';
import { ConflictError } from '@/server/errors/app-error';
import type { StorageArea, StorageLocator, StorageProviderName } from '@/server/storage/types';
import type { GoogleNativeKind, LocalCopyState } from '@/server/db/storage-fields';
import type {
  CreateVersionInput,
  FileVersionRepository,
  StoredObjectRef,
  VersionApprovalBinding,
  VersionByDriveId,
  VersionPatch,
  VersionRecord,
  VersionStorageLocation,
} from './file-version.repository.contract';

type VersionRow = typeof fileVersions.$inferSelect;

/* ------------------------------------------------------------------ helpers */

function nowIso(): string {
  return new Date().toISOString();
}

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * How many ids one `IN (...)` may carry.
 *
 * SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999 and D1 rejects statements above it. The
 * purge path hands this module a page of file ids, and a page large enough to trip that would
 * fail as an opaque `D1_ERROR` rather than as anything a caller could act on — so the reads
 * chunk instead. Same reasoning as `MAX_MOVE_FOLDERS` in the unit-of-work.
 */
const MAX_BOUND_IDS = 500;

function chunk<T>(values: T[], size = MAX_BOUND_IDS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Absent on every row written before the Drive migration, and those are all local. */
function providerOf(value: string | null | undefined): StorageProviderName {
  return value === 'google_drive' ? 'google_drive' : 'local';
}

function toRecord(row: VersionRow): VersionRecord {
  return {
    id: row.id,
    fileId: row.fileId,
    versionNumber: row.versionNumber,
    originalFilename: row.originalFilename,
    fileSize: row.fileSize,
    mimeType: row.mimeType,
    extension: row.extension,
    checksumSha256: row.checksumSha256,
    uploadedBy: row.uploadedBy,
    // `uploaded_at` is NOT NULL, but a row imported from Mongo may carry the creation time
    // instead; falling back keeps the record's contract (`uploadedAt` is never null) intact.
    uploadedAt: toDate(row.uploadedAt) ?? toDate(row.createdAt) ?? new Date(0),
    versionNote: row.versionNote ?? '',
    restoredFromVersionId: row.restoredFromVersionId ?? null,
    processingStatus: row.processingStatus ?? 'pending',
    label: row.label ?? 'draft',
    isCurrent: row.isCurrent === true,
    isApproved: row.isApproved === true,
    approvedBy: row.approvedBy ?? null,
    approvedAt: toDate(row.approvedAt),
    approvalSupersededAt: toDate(row.approvalSupersededAt),
    approvalSupersededReason: row.approvalSupersededReason ?? null,
    previewStatus: row.previewStatus ?? 'none',
    createdAt: toDate(row.createdAt) ?? new Date(0),
  };
}

function toApprovalBinding(row: {
  id: string;
  fileId: string;
  versionNumber: number;
  isApproved: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  approvedRevisionId: string | null;
  approvedContentModifiedAt: string | null;
  approvalSupersededAt: string | null;
}): VersionApprovalBinding {
  return {
    versionId: row.id,
    fileId: row.fileId,
    versionNumber: row.versionNumber,
    isApproved: row.isApproved === true,
    approvedAt: toDate(row.approvedAt),
    approvedBy: row.approvedBy ?? null,
    approvedRevisionId: row.approvedRevisionId ?? null,
    approvedContentModifiedAt: toDate(row.approvedContentModifiedAt),
    approvalSupersededAt: toDate(row.approvalSupersededAt),
  };
}

const APPROVAL_BINDING_COLUMNS = {
  id: fileVersions.id,
  fileId: fileVersions.fileId,
  versionNumber: fileVersions.versionNumber,
  isApproved: fileVersions.isApproved,
  approvedAt: fileVersions.approvedAt,
  approvedBy: fileVersions.approvedBy,
  approvedRevisionId: fileVersions.approvedRevisionId,
  approvedContentModifiedAt: fileVersions.approvedContentModifiedAt,
  approvalSupersededAt: fileVersions.approvalSupersededAt,
} as const;

/* ------------------------------------------------------------------ reads */

export async function findById(id: string): Promise<VersionRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const [row] = await db.select().from(fileVersions).where(eq(fileVersions.id, id)).limit(1);
  return row ? toRecord(row) : null;
}

/** Newest first, matching the Mongo sort the version list renders from. */
export async function listForFile(fileId: string): Promise<VersionRecord[]> {
  if (!fileId) return [];
  const db = await getD1();
  const rows = await db
    .select()
    .from(fileVersions)
    .where(eq(fileVersions.fileId, fileId))
    .orderBy(desc(fileVersions.versionNumber));
  return rows.map(toRecord);
}

export async function findCurrent(fileId: string): Promise<VersionRecord | null> {
  if (!fileId) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.isCurrent, true)))
    .limit(1);
  return row ? toRecord(row) : null;
}

/**
 * What the next version number would be — **advisory**.
 *
 * `MAX(version_number) + 1` read outside any transaction, so two concurrent uploads can read
 * the same answer. That is not a defect here to be fixed with a lock; it is why the authority
 * is the unique index on `(file_id, version_number)` and why `createVersionWithFile` in the
 * unit-of-work re-reads and retries when the insert collides.
 */
export async function nextVersionNumber(fileId: string): Promise<number> {
  if (!fileId) return 1;
  const db = await getD1();
  const [row] = await db
    .select({ highest: sql<number | null>`max(${fileVersions.versionNumber})` })
    .from(fileVersions)
    .where(eq(fileVersions.fileId, fileId));
  return (row?.highest ?? 0) + 1;
}

export async function getStorageLocation(
  versionId: string,
): Promise<VersionStorageLocation | null> {
  if (!versionId) return null;
  const db = await getD1();
  const [row] = await db
    .select({
      storageKey: fileVersions.storageKey,
      storageArea: fileVersions.storageArea,
      storageProvider: fileVersions.storageProvider,
      googleDriveFileId: fileVersions.googleDriveFileId,
      googleDriveRevisionId: fileVersions.googleDriveRevisionId,
      googleDriveWebViewLink: fileVersions.googleDriveWebViewLink,
      isGoogleNative: fileVersions.isGoogleNative,
      googleNativeKind: fileVersions.googleNativeKind,
      localCopyState: fileVersions.localCopyState,
      mimeType: fileVersions.mimeType,
      fileSize: fileVersions.fileSize,
      originalFilename: fileVersions.originalFilename,
    })
    .from(fileVersions)
    .where(eq(fileVersions.id, versionId))
    .limit(1);
  if (!row) return null;

  return {
    provider: providerOf(row.storageProvider),
    key: row.storageKey,
    area: row.storageArea as StorageArea,
    ...(row.googleDriveFileId ? { externalId: row.googleDriveFileId } : {}),
    ...(row.googleDriveRevisionId ? { externalRevisionId: row.googleDriveRevisionId } : {}),
    mimeType: row.mimeType,
    size: row.fileSize,
    filename: row.originalFilename,
    isGoogleNative: row.isGoogleNative === true,
    googleNativeKind: (row.googleNativeKind as GoogleNativeKind | null) ?? null,
    webViewLink: row.googleDriveWebViewLink ?? null,
    localCopyState: (row.localCopyState as LocalCopyState | null) ?? 'present',
  };
}

export async function getStorageLocationsForFiles(fileIds: string[]): Promise<StorageLocator[]> {
  const unique = [...new Set(fileIds.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();

  const out: StorageLocator[] = [];
  for (const page of chunk(unique)) {
    const rows = await db
      .select({
        storageKey: fileVersions.storageKey,
        storageArea: fileVersions.storageArea,
        storageProvider: fileVersions.storageProvider,
        googleDriveFileId: fileVersions.googleDriveFileId,
      })
      .from(fileVersions)
      .where(inArray(fileVersions.fileId, page));

    for (const row of rows) {
      out.push({
        provider: providerOf(row.storageProvider),
        key: row.storageKey,
        area: row.storageArea as StorageArea,
        ...(row.googleDriveFileId ? { externalId: row.googleDriveFileId } : {}),
      });
    }
  }
  return out;
}

/**
 * ⚠️ Bypass: the Drive change feed, which runs as no user.
 *
 * Reads **two** rows to answer a question that must have one answer. `ux_file_versions_drive_id`
 * makes a duplicate impossible to insert, but this repository will also be fed rows migrated
 * from MongoDB, which had no such constraint — so the one place that maps a Drive id back to a
 * version is the place to find out, and finding out means refusing rather than picking. Silently
 * taking the first would apply a Drive edit to an arbitrary one of two versions.
 */
export async function findByDriveFileId(
  googleDriveFileId: string,
): Promise<VersionByDriveId | null> {
  if (!googleDriveFileId) return null;
  const db = await getD1();

  const rows = await db
    .select({
      id: fileVersions.id,
      fileId: fileVersions.fileId,
      versionNumber: fileVersions.versionNumber,
      isCurrent: fileVersions.isCurrent,
      isApproved: fileVersions.isApproved,
      storageProvider: fileVersions.storageProvider,
      googleDriveParentId: fileVersions.googleDriveParentId,
      googleDriveRevisionId: fileVersions.googleDriveRevisionId,
      googleDriveMd5: fileVersions.googleDriveMd5,
      googleDriveModifiedTime: fileVersions.googleDriveModifiedTime,
      isGoogleNative: fileVersions.isGoogleNative,
    })
    .from(fileVersions)
    .where(eq(fileVersions.googleDriveFileId, googleDriveFileId))
    .limit(2);

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new ConflictError(
      `Drive file ${googleDriveFileId} maps to more than one version; refusing to guess`,
      'STORAGE_ERROR',
    );
  }

  const row = rows[0]!;
  return {
    versionId: row.id,
    fileId: row.fileId,
    versionNumber: row.versionNumber,
    isCurrent: row.isCurrent === true,
    isApproved: row.isApproved === true,
    storageProvider: providerOf(row.storageProvider),
    googleDriveParentId: row.googleDriveParentId ?? null,
    googleDriveRevisionId: row.googleDriveRevisionId ?? null,
    googleDriveMd5: row.googleDriveMd5 ?? null,
    googleDriveModifiedTime: toDate(row.googleDriveModifiedTime),
    isGoogleNative: row.isGoogleNative === true,
  };
}

/** ⚠️ Bypass: the full reconcile after an expired Drive cursor. Paged by id, never by offset. */
export async function listDriveBackedVersions(input: {
  limit: number;
  afterId?: string | null;
}): Promise<Array<{ versionId: string; fileId: string; googleDriveFileId: string }>> {
  const db = await getD1();
  const conditions = [
    eq(fileVersions.storageProvider, 'google_drive'),
    isNotNull(fileVersions.googleDriveFileId),
  ];
  if (input.afterId) conditions.push(gt(fileVersions.id, input.afterId));

  const rows = await db
    .select({
      id: fileVersions.id,
      fileId: fileVersions.fileId,
      googleDriveFileId: fileVersions.googleDriveFileId,
    })
    .from(fileVersions)
    .where(and(...conditions))
    .orderBy(asc(fileVersions.id))
    .limit(Math.max(1, Math.min(input.limit, 500)));

  return rows.map((row) => ({
    versionId: row.id,
    fileId: row.fileId,
    googleDriveFileId: row.googleDriveFileId!,
  }));
}

export async function getApprovalBinding(
  versionId: string,
): Promise<VersionApprovalBinding | null> {
  if (!versionId) return null;
  const db = await getD1();
  const [row] = await db
    .select(APPROVAL_BINDING_COLUMNS)
    .from(fileVersions)
    .where(eq(fileVersions.id, versionId))
    .limit(1);
  return row ? toApprovalBinding(row) : null;
}

/**
 * ⚠️ Bypass: the approval-integrity sweep's work list.
 *
 * Rows already marked superseded are excluded: re-checking a known-stale approval every cycle
 * would spend a Drive call per file per run to re-learn something already recorded.
 */
export async function listLiveRemoteApprovals(input: {
  limit: number;
  afterId?: string | null;
}): Promise<VersionApprovalBinding[]> {
  const db = await getD1();
  const conditions = [
    eq(fileVersions.isApproved, true),
    eq(fileVersions.storageProvider, 'google_drive'),
    isNull(fileVersions.approvalSupersededAt),
  ];
  if (input.afterId) conditions.push(gt(fileVersions.id, input.afterId));

  const rows = await db
    .select(APPROVAL_BINDING_COLUMNS)
    .from(fileVersions)
    .where(and(...conditions))
    .orderBy(asc(fileVersions.id))
    .limit(Math.max(1, Math.min(input.limit, 500)));

  return rows.map(toApprovalBinding);
}

/** ⚠️ Bypass: the storage-integrity sweep, over every stored object. Paged by id. */
export async function listStoredObjects(input: {
  afterId?: string;
  limit: number;
}): Promise<StoredObjectRef[]> {
  const db = await getD1();
  const rows = await db
    .select({
      id: fileVersions.id,
      fileId: fileVersions.fileId,
      storageKey: fileVersions.storageKey,
      storageArea: fileVersions.storageArea,
      storageProvider: fileVersions.storageProvider,
      googleDriveFileId: fileVersions.googleDriveFileId,
      fileSize: fileVersions.fileSize,
      checksumSha256: fileVersions.checksumSha256,
    })
    .from(fileVersions)
    .where(input.afterId ? gt(fileVersions.id, input.afterId) : undefined)
    .orderBy(asc(fileVersions.id))
    .limit(input.limit);

  return rows.map((row) => ({
    versionId: row.id,
    fileId: row.fileId,
    provider: providerOf(row.storageProvider),
    key: row.storageKey,
    area: row.storageArea as StorageArea,
    ...(row.googleDriveFileId ? { externalId: row.googleDriveFileId } : {}),
    fileSize: row.fileSize,
    checksumSha256: row.checksumSha256,
  }));
}

/* ------------------------------------------------------------------ counters */

async function countWhere(where: SQL | undefined): Promise<number> {
  const db = await getD1();
  const [row] = await db.select({ value: count() }).from(fileVersions).where(where);
  return row?.value ?? 0;
}

export async function countSyncConflicts(): Promise<number> {
  return countWhere(eq(fileVersions.syncStatus, 'conflict'));
}

export async function countLiveRemoteApprovals(): Promise<number> {
  return countWhere(
    and(
      eq(fileVersions.isApproved, true),
      eq(fileVersions.storageProvider, 'google_drive'),
      isNull(fileVersions.approvalSupersededAt),
    ),
  );
}

export async function countSupersededApprovals(): Promise<number> {
  return countWhere(isNotNull(fileVersions.approvalSupersededAt));
}

export async function countStoredObjects(): Promise<number> {
  return countWhere(undefined);
}

/* ------------------------------------------------------------------ writes */

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * The insert, as a statement rather than as a commit.
 *
 * Exported so `d1-unit-of-work.ts` can put it in the same batch as the `files` update that
 * repoints `current_version_id`. `create` below is the same statement executed on its own, for
 * the callers that really do want only a version row.
 */
export function buildCreateVersionStatement(
  db: Database,
  input: CreateVersionInput & { id: string },
): BatchItem<'sqlite'> {
  const now = nowIso();
  const uploadedAt = toIso(input.uploadedAt) ?? now;

  return db.insert(fileVersions).values({
    id: input.id,
    organizationId: input.organizationId,
    fileId: input.fileId,
    versionNumber: input.versionNumber,
    storageKey: input.storageKey,
    storageArea: input.storageArea,
    relativeStoragePath: input.relativeStoragePath,
    storedFilename: input.storedFilename,
    originalFilename: input.originalFilename,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    extension: input.extension,
    checksumSha256: input.checksumSha256,
    uploadedBy: input.uploadedBy,
    uploadedAt,
    versionNote: input.versionNote ?? '',
    restoredFromVersionId: input.restoredFromVersionId ?? null,
    processingStatus: 'ready',
    label: 'draft',
    // A newly written version is the current one. The caller still has to demote the others
    // and repoint the file, which is why this is not the whole operation.
    isCurrent: true,
    storageProvider: input.storageProvider ?? 'local',
    // Only set together, and only by a caller that has already written the object in Drive:
    // recording a Drive id without the migration and sync state would leave a row that reads
    // as un-migrated while its bytes are remote.
    ...(input.googleDriveFileId
      ? {
          googleDriveFileId: input.googleDriveFileId,
          googleDriveParentId: input.googleDriveParentId ?? null,
          googleDriveRevisionId: input.googleDriveRevisionId ?? null,
          googleDriveMd5: input.googleDriveMd5 ?? null,
          googleDriveWebViewLink: input.googleDriveWebViewLink ?? null,
          migrationStatus: 'verified' as const,
          migratedAt: now,
          syncStatus: 'synced' as const,
          lastSyncedAt: now,
          // No local copy was ever written for a server-side copy, so there is nothing to
          // retain and nothing to fall back to.
          localCopyState: 'deleted' as const,
        }
      : {}),
    createdAt: now,
    updatedAt: now,
  });
}

export async function create(input: CreateVersionInput): Promise<VersionRecord> {
  const db = await getD1();
  const id = input.id ?? newId();
  await withBatch(db, [buildCreateVersionStatement(db, { ...input, id })]);

  const created = await findById(id);
  if (!created) {
    // The insert reported success and the row is not there. Not survivable, and not something
    // to paper over with a synthesized record.
    throw new ConflictError('The version was written but could not be read back');
  }
  return created;
}

/**
 * The statements that make one version current and demote the rest — built, not executed.
 *
 * Three, in this order:
 *
 *   1. every *other* version of the file stops being current
 *   2. every other version still labelled the plain working draft becomes `superseded`
 *   3. this version becomes current
 *
 * Step 2 deliberately does not touch `approved`, `final` or `changes_requested`: a superseded
 * approval stays visibly approved in the history, because "which version did they sign?" must
 * remain answerable forever. This mirrors the Mongo implementation statement for statement.
 */
export function buildSetCurrentStatements(
  db: Database,
  fileId: string,
  versionId: string,
): BatchItem<'sqlite'>[] {
  const now = nowIso();
  const others = and(eq(fileVersions.fileId, fileId), sql`${fileVersions.id} <> ${versionId}`)!;

  return [
    db
      .update(fileVersions)
      .set({ isCurrent: false, updatedAt: now })
      .where(and(others, eq(fileVersions.isCurrent, true))),
    db
      .update(fileVersions)
      .set({ label: 'superseded', updatedAt: now })
      .where(and(others, eq(fileVersions.label, 'draft'))),
    db
      .update(fileVersions)
      .set({ isCurrent: true, updatedAt: now })
      .where(eq(fileVersions.id, versionId)),
  ];
}

export async function setCurrent(fileId: string, versionId: string): Promise<void> {
  if (!fileId || !versionId) return;
  const db = await getD1();
  await withBatch(db, buildSetCurrentStatements(db, fileId, versionId));
}

/**
 * Translates the typed patch to columns.
 *
 * Written as an explicit field-by-field mapping rather than a spread of the patch object: the
 * patch's keys happen to match the schema's property names today, and a silent rename on either
 * side would otherwise write nothing and report success.
 */
export function versionPatchColumns(patch: VersionPatch): Partial<typeof fileVersions.$inferInsert> {
  const columns: Partial<typeof fileVersions.$inferInsert> = {};

  if (patch.versionNote !== undefined) columns.versionNote = patch.versionNote;
  if (patch.label !== undefined) columns.label = patch.label;
  if (patch.processingStatus !== undefined) columns.processingStatus = patch.processingStatus;
  if (patch.previewStatus !== undefined) {
    columns.previewStatus = patch.previewStatus as typeof fileVersions.$inferInsert.previewStatus;
  }
  if (patch.previewKey !== undefined) columns.previewKey = patch.previewKey;

  if (patch.isApproved !== undefined) columns.isApproved = patch.isApproved;
  if (patch.approvedBy !== undefined) columns.approvedBy = patch.approvedBy;
  if (patch.approvedAt !== undefined) columns.approvedAt = toIso(patch.approvedAt);
  if (patch.approvedRevisionId !== undefined) columns.approvedRevisionId = patch.approvedRevisionId;
  if (patch.approvedContentModifiedAt !== undefined) {
    columns.approvedContentModifiedAt = toIso(patch.approvedContentModifiedAt);
  }
  if (patch.approvalSupersededAt !== undefined) {
    columns.approvalSupersededAt = toIso(patch.approvalSupersededAt);
  }
  if (patch.approvalSupersededReason !== undefined) {
    columns.approvalSupersededReason = patch.approvalSupersededReason;
  }

  if (patch.googleDriveRevisionId !== undefined) {
    columns.googleDriveRevisionId = patch.googleDriveRevisionId;
  }
  if (patch.googleDriveModifiedTime !== undefined) {
    columns.googleDriveModifiedTime = toIso(patch.googleDriveModifiedTime);
  }
  if (patch.googleDriveMd5 !== undefined) columns.googleDriveMd5 = patch.googleDriveMd5;
  if (patch.googleDriveWebViewLink !== undefined) {
    columns.googleDriveWebViewLink = patch.googleDriveWebViewLink;
  }

  if (patch.syncStatus !== undefined) columns.syncStatus = patch.syncStatus;
  if (patch.lastSyncedAt !== undefined) columns.lastSyncedAt = toIso(patch.lastSyncedAt);
  if (patch.localCopyState !== undefined) columns.localCopyState = patch.localCopyState;

  return columns;
}

export async function updateFlags(versionId: string, patch: VersionPatch): Promise<void> {
  if (!versionId) return;
  const columns = versionPatchColumns(patch);
  if (Object.keys(columns).length === 0) return;

  const db = await getD1();
  await db
    .update(fileVersions)
    .set({ ...columns, updatedAt: nowIso() })
    .where(eq(fileVersions.id, versionId));
}

/**
 * Records that a version's stored object disagrees with the database.
 *
 * Never deletes or hides the row: a file that has vanished from Drive still has metadata,
 * comments, reviews, approvals and an audit history that must survive, and it may still be
 * readable from the retained local copy. Marking it is what puts it in front of an
 * administrator; removing it would destroy the evidence.
 */
export async function markStorageConflict(versionId: string, reason: string): Promise<void> {
  if (!versionId) return;
  const db = await getD1();
  await db
    .update(fileVersions)
    .set({
      syncStatus: 'conflict',
      migrationFailureReason: reason.slice(0, 500),
      updatedAt: nowIso(),
    })
    .where(eq(fileVersions.id, versionId));
}

/**
 * ⚠️ Bypass: hard delete, from the retention purge.
 *
 * Returns rows that actually existed rather than `meta.changes`, which on this table counts
 * nothing extra today but would start to the moment anything cascades from `file_versions` —
 * and the number is reported as "versions purged".
 *
 * Deletes only metadata. The bytes are removed by the storage layer, which reads the locations
 * through `getStorageLocationsForFiles` *before* calling this.
 */
export async function purgeForFiles(fileIds: string[]): Promise<number> {
  const unique = [...new Set(fileIds.filter(Boolean))];
  if (unique.length === 0) return 0;
  const db = await getD1();

  let removed = 0;
  for (const page of chunk(unique)) {
    const present = await db
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .where(inArray(fileVersions.fileId, page));
    if (present.length === 0) continue;

    await db.delete(fileVersions).where(inArray(fileVersions.fileId, page));
    removed += present.length;
  }
  return removed;
}

export const d1FileVersionRepository: FileVersionRepository = {
  findById,
  listForFile,
  findCurrent,
  nextVersionNumber,
  getStorageLocation,
  getStorageLocationsForFiles,
  findByDriveFileId,
  listDriveBackedVersions,
  getApprovalBinding,
  listLiveRemoteApprovals,
  listStoredObjects,
  countSyncConflicts,
  countLiveRemoteApprovals,
  countSupersededApprovals,
  countStoredObjects,
  newId,
  create,
  setCurrent,
  updateFlags,
  markStorageConflict,
  purgeForFiles,
};
