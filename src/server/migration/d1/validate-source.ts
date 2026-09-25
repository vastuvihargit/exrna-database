/**
 * Is MongoDB in a state D1 can accept?
 *
 * Runs **before** anything is written, because every problem it looks for has the same shape:
 * a constraint D1 declares and MongoDB does not, which turns a data-quality issue that has been
 * harmless for a year into a batch abort during a write freeze.
 *
 * Read-only on MongoDB and it never touches D1. The output is the list a human reads while
 * deciding whether the cutover window is worth opening.
 */
import {
  FileModel,
  FileVersionModel,
  FolderModel,
  NotificationModel,
  ReviewModel,
  RoleModel,
  UserModel,
  UserRoleModel,
} from '@/server/db/models';
import type { Model, PipelineStage } from 'mongoose';
import { AUDIT_ACTIONS } from '@/server/db/models/audit-log.model';
import { AuditLogModel } from '@/server/db/models';
import { PERMISSIONS, SCOPE_TYPES } from '@/server/domain/permissions';
import { findAclConflicts, type AclEntryLike } from '@/server/permissions/acl-normalization';

/**
 * The query surface these helpers need.
 *
 * Mongoose's `Model` generics are per-collection, so a helper that takes several different
 * models has no single type to name. `Record<string, unknown>` is the honest one: every field
 * is addressed by string here anyway, because the whole point is to be schema-agnostic.
 */
type SourceModel = Model<Record<string, unknown>>;
const asSource = (model: unknown): SourceModel => model as SourceModel;


export interface SourceIssue {
  check: string;
  /** `blocker` aborts the batch it lands in. `advisory` migrates with a documented loss. */
  severity: 'blocker' | 'advisory';
  count: number;
  detail: string;
  sample: string[];
}

export interface SourceValidationReport {
  startedAt: string;
  finishedAt: string;
  issues: SourceIssue[];
  ok: boolean;
}

const SAMPLE = 20;

export async function validateSource(
  onProgress: (message: string) => void = () => undefined,
): Promise<SourceValidationReport> {
  const startedAt = new Date();
  const issues: SourceIssue[] = [];

  const add = (issue: SourceIssue) => {
    if (issue.count === 0) return;
    issues.push(issue);
    onProgress(`${issue.severity.toUpperCase()} ${issue.check}: ${issue.count}`);
  };

  /* ── uniqueness constraints D1 declares and MongoDB does not enforce identically ── */

  // `ux_users_email` is global in D1. MongoDB's is too, but a case difference passes there and
  // collides here only if the values are normalised — worth measuring rather than assuming.
  const duplicateEmails = await duplicates(asSource(UserModel), [{ $group: { _id: '$email' } }], 'email');
  add({
    check: 'duplicate-user-email',
    severity: 'blocker',
    count: duplicateEmails.length,
    detail: 'ux_users_email is unique across the whole table',
    sample: duplicateEmails.slice(0, SAMPLE),
  });

  const duplicateStorageKeys = await duplicates(
    asSource(FileVersionModel),
    [{ $group: { _id: '$storageKey' } }],
    'storageKey',
  );
  add({
    check: 'duplicate-storage-key',
    severity: 'blocker',
    count: duplicateStorageKeys.length,
    detail: 'ux_file_versions_storage_key is unique; two versions cannot share an address',
    sample: duplicateStorageKeys.slice(0, SAMPLE),
  });

  const duplicateDriveIds = await duplicates(
    asSource(FileVersionModel),
    [{ $match: { googleDriveFileId: { $type: 'string' } } }, { $group: { _id: '$googleDriveFileId' } }],
    'googleDriveFileId',
  );
  add({
    check: 'duplicate-drive-file-id',
    severity: 'blocker',
    count: duplicateDriveIds.length,
    detail:
      'ux_file_versions_drive_id is the guarantee against a retry uploading a second copy; ' +
      'two versions naming one Drive file breaks it',
    sample: duplicateDriveIds.slice(0, SAMPLE),
  });

  const duplicateDedupeKeys = await duplicates(
    asSource(NotificationModel),
    [{ $match: { dedupeKey: { $type: 'string' } } }, { $group: { _id: '$dedupeKey' } }],
    'dedupeKey',
  );
  add({
    check: 'duplicate-notification-dedupe-key',
    severity: 'blocker',
    count: duplicateDedupeKeys.length,
    detail: 'ux_notifications_dedupe_key is unique for non-null keys',
    sample: duplicateDedupeKeys.slice(0, SAMPLE),
  });

  /* ── invariants the D1 schema states as CHECK constraints ── */

  const badScopes = await UserRoleModel.find({
    $or: [
      { scopeType: 'company', scopeId: { $ne: null } },
      { scopeType: { $ne: 'company' }, scopeId: null },
      { scopeType: { $nin: [...SCOPE_TYPES] } },
    ],
  })
    .select({ _id: 1, scopeType: 1, scopeId: 1 })
    .limit(500)
    .lean()
    .exec();
  add({
    check: 'user-role-scope-invariant',
    severity: 'blocker',
    count: badScopes.length,
    detail:
      'migration 0003 puts the scope invariant in the database: company grants carry no scope ' +
      'id, every other scope requires one. These grants are skipped rather than guessed at',
    sample: badScopes.slice(0, SAMPLE).map((row) => String(row._id)),
  });

  /* ── open reviews: D1 allows one pending review per version ── */

  const duplicatePendingReviews = await duplicates(
    asSource(ReviewModel),
    [{ $match: { status: 'pending' } }, { $group: { _id: '$versionId' } }],
    'versionId',
  );
  add({
    check: 'multiple-pending-reviews-per-version',
    severity: 'blocker',
    count: duplicatePendingReviews.length,
    detail: 'ux_reviews_open_per_version allows one pending review per version',
    sample: duplicatePendingReviews.slice(0, SAMPLE),
  });

  /* ── enum values outside what the D1 CHECK constraints allow ── */

  const unknownActions = await AuditLogModel.distinct('action').exec();
  const badActions = (unknownActions as string[]).filter(
    (action) => !(AUDIT_ACTIONS as readonly string[]).includes(action),
  );
  add({
    check: 'unknown-audit-action',
    severity: 'blocker',
    count: badActions.length,
    detail:
      'audit_logs.action is constrained to the catalogue. A row outside it is reported as a ' +
      'failure rather than relabelled, because a relabelled audit row is evidence of something ' +
      'that did not happen',
    sample: badActions.slice(0, SAMPLE),
  });

  const rolePermissions = await RoleModel.distinct('permissions').exec();
  const badPermissions = (rolePermissions as string[]).filter(
    (permission) => !(PERMISSIONS as readonly string[]).includes(permission),
  );
  add({
    check: 'unknown-role-permission',
    severity: 'advisory',
    count: badPermissions.length,
    detail:
      'role_permissions.permission_key is a foreign key into the seeded catalogue. Unknown ' +
      'permissions are dropped, so the role ends up with fewer capabilities, never more',
    sample: badPermissions.slice(0, SAMPLE),
  });

  /* ── ACL entries that cannot survive the unique index unchanged ── */

  const aclConflicts = await countAclConflicts();
  add({
    check: 'acl-conflicts',
    severity: 'advisory',
    count: aclConflicts.count,
    detail:
      'a principal holding several entries on one resource. resolveEntries() picks one: expired ' +
      'entries contribute nothing, a live denial beats every allow, otherwise the strongest ' +
      'live allow wins. Run `npm run acl:validate` for the full resolution',
    sample: aclConflicts.sample,
  });

  /* ── references that would be dropped ── */

  const orphanFiles = await FileModel.aggregate([
    { $lookup: { from: 'folders', localField: 'folderId', foreignField: '_id', as: 'folder' } },
    { $match: { folder: { $size: 0 } } },
    { $project: { _id: 1 } },
    { $limit: 500 },
  ]).exec();
  add({
    check: 'file-without-folder',
    severity: 'blocker',
    count: orphanFiles.length,
    detail:
      'files.folder_id is NOT NULL and a foreign key. These files cannot be migrated, and ' +
      'putting them somewhere else would move research data under permissions it was never ' +
      'checked against',
    sample: orphanFiles.slice(0, SAMPLE).map((row: { _id: unknown }) => String(row._id)),
  });

  const orphanVersions = await FileVersionModel.aggregate([
    { $lookup: { from: 'files', localField: 'fileId', foreignField: '_id', as: 'file' } },
    { $match: { file: { $size: 0 } } },
    { $project: { _id: 1 } },
    { $limit: 500 },
  ]).exec();
  add({
    check: 'version-without-file',
    severity: 'blocker',
    count: orphanVersions.length,
    detail: 'file_versions.file_id is a foreign key; a version with no file cannot be written',
    sample: orphanVersions.slice(0, SAMPLE).map((row: { _id: unknown }) => String(row._id)),
  });

  /* ── data that would silently lose meaning ── */

  const versionsWithoutChecksum = await FileVersionModel.countDocuments({
    $or: [{ checksumSha256: null }, { checksumSha256: '' }],
  }).exec();
  add({
    check: 'version-without-checksum',
    severity: 'advisory',
    count: versionsWithoutChecksum,
    detail:
      'file_versions.checksum_sha256 is NOT NULL in D1 and becomes the empty string. A version ' +
      'with no checksum cannot have its bytes verified, which is what binds an approval',
    sample: [],
  });

  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    issues,
    ok: issues.every((issue) => issue.severity !== 'blocker'),
  };
}

/**
 * Values appearing more than once under a grouping.
 *
 * The pipeline is passed in rather than the field, because several of these need a `$match`
 * first — a partial unique index in MongoDB constrains a subset, and comparing the whole
 * collection would report conflicts that do not exist.
 */
async function duplicates(
  model: SourceModel,
  pipeline: PipelineStage[],
  label: string,
): Promise<string[]> {
  const grouping = pipeline[pipeline.length - 1] as { $group: Record<string, unknown> };
  const counted: PipelineStage[] = [
    ...pipeline.slice(0, -1),
    { $group: { ...grouping.$group, n: { $sum: 1 } } } as PipelineStage,
    { $match: { n: { $gt: 1 }, _id: { $ne: null } } },
    { $limit: 500 },
  ];
  const rows = (await model.aggregate(counted).exec()) as { _id: unknown }[];
  return rows.map((row) => `${label}=${String(row._id)}`);
}

async function countAclConflicts(): Promise<{ count: number; sample: string[] }> {
  let count = 0;
  const sample: string[] = [];
  const now = Date.now();

  for (const [kind, model] of [
    ['folder', asSource(FolderModel)],
    ['file', asSource(FileModel)],
  ] as const) {
    const cursor = model
      .find({ 'permissions.1': { $exists: true } })
      .setOptions({ withDeleted: true })
      .select({ _id: 1, permissions: 1 })
      .lean()
      .cursor();

    for await (const document of cursor) {
      const entries = ((document.permissions as unknown[]) ?? []).map((item) => {
        const entry = item as Record<string, unknown>;
        return {
          principalType: String(entry.principalType ?? ''),
          principalId: String(entry.principalId ?? ''),
          accessLevel: String(entry.accessLevel ?? ''),
          deny: entry.deny === true,
          expiresAt: entry.expiresAt instanceof Date ? entry.expiresAt : null,
        } satisfies AclEntryLike;
      });
      const conflicts = findAclConflicts(entries, now);
      if (conflicts.length === 0) continue;
      count += conflicts.length;
      if (sample.length < SAMPLE) sample.push(`${kind} ${String(document._id)}`);
    }
  }

  return { count, sample };
}
