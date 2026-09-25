/**
 * Does D1 now hold what MongoDB holds?
 *
 * Four questions, in increasing order of how much they would cost to get wrong:
 *
 *   1. **Counts.**        Are the same number of rows there?
 *   2. **Relationships.** Does every reference resolve, and does every invariant the schema
 *                         states actually hold in the data?
 *   3. **ACL.**           For a sample of resources, does D1 grant exactly what MongoDB grants —
 *                         same principals, same levels, same denials?
 *   4. **Search.**        Is every live file in the FTS index exactly once, and can it be found?
 *
 * A count comparison alone is the check that feels sufficient and is not: a migration that
 * copied every row and dropped every denial passes it.
 *
 * Everything here is **read-only** on both databases.
 */
import {
  ActivityModel,
  AlertStateModel,
  AppSettingModel,
  AuditLogModel,
  CommentModel,
  DepartmentModel,
  DriveSyncStateModel,
  ExperimentModel,
  FileModel,
  FileVersionModel,
  FolderModel,
  InventoryItemModel,
  LoginHistoryModel,
  NotificationModel,
  OrganizationModel,
  ProjectModel,
  RecentItemModel,
  ReviewModel,
  RoleModel,
  SavedSearchModel,
  SessionModel,
  StarModel,
  StockTransactionModel,
  UserModel,
  UserRoleModel,
} from '@/server/db/models';
import type { Model, PipelineStage } from 'mongoose';
import { PRINCIPAL_TYPES } from '@/server/domain/permissions';
import { resolveEntries, type AclEntryLike } from '@/server/permissions/acl-normalization';
import { toFtsQuery } from '@/server/repositories/fts-query';
import { oid, str } from './convert';
import { INTENTIONALLY_NOT_MIGRATED } from './registry';
import type { D1Gateway } from './types';

/**
 * The query surface these helpers need.
 *
 * Mongoose's `Model` generics are per-collection, so a helper that takes several different
 * models has no single type to name. `Record<string, unknown>` is the honest one: every field
 * is addressed by string here anyway, because the whole point is to be schema-agnostic.
 */
type SourceModel = Model<Record<string, unknown>>;
const asSource = (model: unknown): SourceModel => model as SourceModel;


export interface CountComparison {
  table: string;
  source: number;
  target: number;
  delta: number;
  ok: boolean;
  note?: string;
}

export interface Finding {
  check: string;
  severity: 'error' | 'warning';
  detail: string;
  sample: string[];
}

export interface VerificationReport {
  startedAt: string;
  finishedAt: string;
  target: string;
  counts: CountComparison[];
  findings: Finding[];
  aclSampled: number;
  ftsChecked: number;
  ok: boolean;
}

/**
 * Where each D1 table's expected row count comes from.
 *
 * Tables written from an embedded array have no MongoDB collection to count, so their expected
 * value is derived by summing the arrays. That is slower than a `countDocuments` and is the only
 * way the question can be asked at all — and it is exactly the direction a bug would go, because
 * an array that half-migrated produces the right number of parents and the wrong number of
 * children.
 */
type SourceCounter = () => Promise<number>;

const TABLE_SOURCES: Record<string, SourceCounter> = {
  organizations: () => OrganizationModel.countDocuments({}).setOptions({ withDeleted: true }),
  departments: () => DepartmentModel.countDocuments({}).setOptions({ withDeleted: true }),
  users: () => UserModel.countDocuments({}).setOptions({ withDeleted: true }),
  app_settings: () => AppSettingModel.countDocuments({}),
  roles: () => RoleModel.countDocuments({}).setOptions({ withDeleted: true }),
  user_roles: () => UserRoleModel.countDocuments({}),
  projects: () => ProjectModel.countDocuments({}).setOptions({ withDeleted: true }),
  experiments: () => ExperimentModel.countDocuments({}).setOptions({ withDeleted: true }),
  folders: () => FolderModel.countDocuments({}).setOptions({ withDeleted: true }),
  files: () => FileModel.countDocuments({}).setOptions({ withDeleted: true }),
  file_versions: () => FileVersionModel.countDocuments({}),
  comments: () => CommentModel.countDocuments({}).setOptions({ withDeleted: true }),
  reviews: () => ReviewModel.countDocuments({}),
  notifications: () => NotificationModel.countDocuments({}),
  audit_logs: () => AuditLogModel.countDocuments({}),
  sessions: () => SessionModel.countDocuments({}),
  login_history: () => LoginHistoryModel.countDocuments({}),
  activities: () => ActivityModel.countDocuments({}),
  stars: () => StarModel.countDocuments({}),
  recent_items: () => RecentItemModel.countDocuments({}),
  saved_searches: () => SavedSearchModel.countDocuments({}),
  inventory_items: () => InventoryItemModel.countDocuments({}).setOptions({ withDeleted: true }),
  stock_transactions: () => StockTransactionModel.countDocuments({}),
  drive_sync_states: () => DriveSyncStateModel.countDocuments({}),
  alert_states: () => AlertStateModel.countDocuments({}),

  // Child tables: the sum of the arrays they came from.
  project_members: () => sumArray(asSource(ProjectModel), 'memberUserIds'),
  experiment_collaborators: () => sumArray(asSource(ExperimentModel), 'collaboratorUserIds'),
  experiment_samples: () => sumArray(asSource(ExperimentModel), 'sampleIds'),
  comment_mentions: () => sumArray(asSource(CommentModel), 'mentionedUserIds'),
  review_reviewers: () => sumArray(asSource(ReviewModel), 'reviewerUserIds'),
  approvals: () => sumArray(asSource(ReviewModel), 'decisions'),
  folder_ancestors: () => sumArray(asSource(FolderModel), 'pathAncestors'),
  file_folder_ancestors: () => sumArray(asSource(FileModel), 'folderPathAncestors'),
  inventory_batches: () => sumArray(asSource(InventoryItemModel), 'batches'),
};

/**
 * `$size` summed across a collection.
 *
 * Deliberately an aggregate rather than a cursor: on the file corpus this is the difference
 * between a second and a walk of every document.
 *
 * There is no `$match`, and that is not an omission. Mongoose does not route `aggregate` through
 * the soft-delete middleware — the behaviour behind defect 5.3 — so this counts trashed rows
 * too, which is exactly right here: the migration copies them, so the comparison has to include
 * them. It is the one place where that middleware gap is the desired behaviour rather than a bug.
 */
async function sumArray(model: SourceModel, field: string): Promise<number> {
  const pipeline: PipelineStage[] = [
    { $group: { _id: null, total: { $sum: { $size: { $ifNull: ['$' + field, []] } } } } },
  ];
  const rows = (await model.aggregate(pipeline).exec()) as { total?: number }[];
  return rows[0]?.total ?? 0;
}

async function targetCount(gateway: D1Gateway, table: string): Promise<number> {
  const rows = await gateway.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Relationship and invariant checks, expressed as queries that must return **no rows**.
 *
 * A check that returns rows names the exact records to look at, which is the difference between
 * "the migration has a problem" and "these four files point at a folder that is not there".
 */
const INTEGRITY_CHECKS: {
  name: string;
  severity: 'error' | 'warning';
  detail: string;
  sql: string;
}[] = [
  {
    name: 'files-without-folder',
    severity: 'error',
    detail: 'files whose folder_id does not resolve',
    sql: 'SELECT f.id FROM files f LEFT JOIN folders d ON d.id = f.folder_id WHERE d.id IS NULL LIMIT 20',
  },
  {
    name: 'versions-without-file',
    severity: 'error',
    detail: 'file_versions whose file_id does not resolve',
    sql: 'SELECT v.id FROM file_versions v LEFT JOIN files f ON f.id = v.file_id WHERE f.id IS NULL LIMIT 20',
  },
  {
    name: 'current-version-dangling',
    severity: 'error',
    detail: 'files whose current_version_id names a version that is not there',
    sql:
      'SELECT f.id FROM files f LEFT JOIN file_versions v ON v.id = f.current_version_id ' +
      'WHERE f.current_version_id IS NOT NULL AND v.id IS NULL LIMIT 20',
  },
  {
    name: 'approved-version-dangling',
    severity: 'error',
    detail: 'files whose approved_version_id names a version that is not there',
    sql:
      'SELECT f.id FROM files f LEFT JOIN file_versions v ON v.id = f.approved_version_id ' +
      'WHERE f.approved_version_id IS NOT NULL AND v.id IS NULL LIMIT 20',
  },
  {
    name: 'current-version-wrong-file',
    severity: 'error',
    detail: 'files whose current version belongs to a different file',
    sql:
      'SELECT f.id FROM files f JOIN file_versions v ON v.id = f.current_version_id ' +
      'WHERE v.file_id <> f.id LIMIT 20',
  },
  {
    name: 'multiple-current-versions',
    severity: 'error',
    detail: 'files carrying more than one is_current version',
    sql:
      'SELECT file_id FROM file_versions WHERE is_current = 1 GROUP BY file_id ' +
      'HAVING COUNT(*) > 1 LIMIT 20',
  },
  {
    name: 'approval-not-on-reviewed-version',
    severity: 'error',
    detail: 'approvals bound to a version other than the one their review names',
    sql:
      'SELECT a.id FROM approvals a JOIN reviews r ON r.id = a.review_id ' +
      'WHERE a.version_id <> r.version_id LIMIT 20',
  },
  {
    name: 'review-version-dangling',
    severity: 'error',
    detail: 'reviews whose version_id does not resolve',
    sql:
      'SELECT r.id FROM reviews r LEFT JOIN file_versions v ON v.id = r.version_id ' +
      'WHERE v.id IS NULL LIMIT 20',
  },
  {
    name: 'user-role-scope-invariant',
    severity: 'error',
    detail: 'role grants violating the company/scope invariant migration 0003 enforces',
    sql:
      "SELECT id FROM user_roles WHERE (scope_type = 'company' AND scope_id IS NOT NULL) " +
      "OR (scope_type <> 'company' AND (scope_id IS NULL OR scope_id = '')) LIMIT 20",
  },
  {
    name: 'duplicate-resource-permission',
    severity: 'error',
    detail: 'more than one ACL entry for the same principal on the same resource',
    sql:
      'SELECT resource_id FROM resource_permissions ' +
      'GROUP BY resource_type, resource_id, principal_type, principal_id HAVING COUNT(*) > 1 LIMIT 20',
  },
  {
    name: 'folder-ancestor-dangling',
    severity: 'error',
    detail: 'ancestor rows naming a folder that is not there',
    sql:
      'SELECT a.folder_id FROM folder_ancestors a LEFT JOIN folders f ON f.id = a.ancestor_id ' +
      'WHERE f.id IS NULL LIMIT 20',
  },
  {
    name: 'folder-parent-not-deepest-ancestor',
    severity: 'warning',
    detail:
      'folders whose parent_folder_id is not the deepest row in their ancestor list — the tree ' +
      'and the closure table disagree, which makes breadcrumbs and subtree queries differ',
    sql:
      'SELECT f.id FROM folders f WHERE f.parent_folder_id IS NOT NULL AND f.parent_folder_id <> ' +
      '(SELECT a.ancestor_id FROM folder_ancestors a WHERE a.folder_id = f.id ORDER BY a.depth DESC LIMIT 1) LIMIT 20',
  },
  {
    name: 'fts-duplicate-rows',
    severity: 'error',
    detail: 'files indexed more than once, which returns them once per stale copy',
    sql: 'SELECT file_id FROM files_fts GROUP BY file_id HAVING COUNT(*) > 1 LIMIT 20',
  },
  {
    name: 'fts-missing-live-file',
    severity: 'error',
    detail: 'live files absent from the search index',
    sql:
      'SELECT f.id FROM files f LEFT JOIN files_fts x ON x.file_id = f.id ' +
      'WHERE f.deleted_at IS NULL AND x.file_id IS NULL LIMIT 20',
  },
  {
    name: 'fts-indexes-trashed-file',
    severity: 'error',
    detail: 'trashed files present in the search index, which leaks them into search results',
    sql:
      'SELECT f.id FROM files f JOIN files_fts x ON x.file_id = f.id ' +
      'WHERE f.deleted_at IS NOT NULL LIMIT 20',
  },
  {
    name: 'orphan-organization-reference',
    severity: 'error',
    detail: 'files whose organization_id does not resolve',
    sql:
      'SELECT f.id FROM files f LEFT JOIN organizations o ON o.id = f.organization_id ' +
      'WHERE o.id IS NULL LIMIT 20',
  },
];

export interface VerifyOptions {
  gateway: D1Gateway;
  /** How many ACL-bearing resources to compare in full. 0 disables the check. */
  aclSample?: number;
  /** How many files to search for by name. 0 disables the check. */
  ftsSample?: number;
  onProgress?: (message: string) => void;
}

export async function verifyMigration(options: VerifyOptions): Promise<VerificationReport> {
  const { gateway } = options;
  const log = options.onProgress ?? (() => undefined);
  const startedAt = new Date();
  const counts: CountComparison[] = [];
  const findings: Finding[] = [];

  for (const [table, counter] of Object.entries(TABLE_SOURCES)) {
    const [source, target] = await Promise.all([counter(), targetCount(gateway, table)]);
    counts.push({ table, source, target, delta: target - source, ok: target === source });
    log(`${table}: mongo ${source}, d1 ${target}`);
  }

  for (const [table, reason] of Object.entries(INTENTIONALLY_NOT_MIGRATED)) {
    // Reported rather than silently absent: "0 rows and that is correct" and "0 rows and nobody
    // noticed" look identical in a count table.
    const target = await targetCount(gateway, table).catch(() => 0);
    counts.push({ table, source: 0, target, delta: target, ok: true, note: reason });
  }

  for (const check of INTEGRITY_CHECKS) {
    const rows = await gateway.query<Record<string, string>>(check.sql);
    if (rows.length === 0) continue;
    findings.push({
      check: check.name,
      severity: check.severity,
      detail: check.detail,
      sample: rows.map((row) => String(Object.values(row)[0])),
    });
    log(`FINDING ${check.name}: ${rows.length} row(s)`);
  }

  const aclSampled = await compareAcls(gateway, options.aclSample ?? 200, findings);
  const ftsChecked = await checkSearchable(gateway, options.ftsSample ?? 25, findings);

  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    target: gateway.label,
    counts,
    findings,
    aclSampled,
    ftsChecked,
    ok: counts.every((count) => count.ok) && findings.every((f) => f.severity !== 'error'),
  };
}

/**
 * Compares the resolved ACL of a sample of resources, entry by entry.
 *
 * This is the check the count comparison cannot make. A migration that dropped every `deny`
 * entry produces identical counts for `folders` and `files`, a `resource_permissions` count that
 * is *plausibly* lower because resolution collapses duplicates, and a database in which people
 * can read what they were explicitly denied.
 *
 * Both sides are resolved by `resolveEntries()` — the same function the migration used and the
 * same one `scripts/validate-acl-uniqueness.ts` previews with — so this compares the *result of
 * the rules* against what was written, not one implementation of the rules against another.
 */
async function compareAcls(
  gateway: D1Gateway,
  sampleSize: number,
  findings: Finding[],
): Promise<number> {
  if (sampleSize <= 0) return 0;

  const mismatches: string[] = [];
  let sampled = 0;
  const now = Date.now();

  for (const [resourceType, model] of [
    ['folder', asSource(FolderModel)],
    ['file', asSource(FileModel)],
  ] as const) {
    const documents = await model
      .find({ 'permissions.0': { $exists: true } })
      .setOptions({ withDeleted: true })
      .select({ _id: 1, permissions: 1 })
      .limit(Math.ceil(sampleSize / 2))
      .lean()
      .exec();

    for (const document of documents as unknown as Record<string, unknown>[]) {
      sampled += 1;
      const resourceId = oid(document._id);
      if (!resourceId) continue;

      const expected = new Map<string, string>();
      const byPrincipal = new Map<string, AclEntryLike[]>();
      for (const item of (document.permissions as unknown[]) ?? []) {
        const entry = item as Record<string, unknown>;
        const principalType = str(entry.principalType);
        const principalId = oid(entry.principalId);
        if (!principalId || !(PRINCIPAL_TYPES as readonly string[]).includes(principalType)) continue;
        const key = `${principalType}:${principalId}`;
        const list = byPrincipal.get(key) ?? [];
        list.push({
          principalType,
          principalId,
          accessLevel: str(entry.accessLevel),
          deny: entry.deny === true,
          expiresAt: entry.expiresAt instanceof Date ? entry.expiresAt : null,
        });
        byPrincipal.set(key, list);
      }
      for (const [key, entries] of byPrincipal) {
        const resolved = resolveEntries(entries, now);
        if (!resolved) continue;
        expected.set(key, `${resolved.accessLevel}:${resolved.deny === true ? 'deny' : 'allow'}`);
      }

      const rows = await gateway.query<{
        principal_type: string;
        principal_id: string;
        access_level: string;
        deny: number;
      }>(
        'SELECT principal_type, principal_id, access_level, deny FROM resource_permissions ' +
          'WHERE resource_type = ? AND resource_id = ?',
        [resourceType, resourceId],
      );

      const actual = new Map<string, string>();
      for (const row of rows) {
        actual.set(
          `${row.principal_type}:${row.principal_id}`,
          `${row.access_level}:${Number(row.deny) === 1 ? 'deny' : 'allow'}`,
        );
      }

      for (const [key, value] of expected) {
        const found = actual.get(key);
        if (found !== value) {
          mismatches.push(`${resourceType} ${resourceId} ${key}: expected ${value}, got ${found ?? 'nothing'}`);
        }
      }
      for (const key of actual.keys()) {
        if (!expected.has(key)) {
          // An entry D1 has and MongoDB does not is the worst direction: it is access the
          // migration created.
          mismatches.push(`${resourceType} ${resourceId} ${key}: present in D1 only`);
        }
      }
    }
  }

  if (mismatches.length > 0) {
    findings.push({
      check: 'acl-comparison',
      severity: 'error',
      detail: `${mismatches.length} ACL entries differ between MongoDB and D1`,
      sample: mismatches.slice(0, 20),
    });
  }
  return sampled;
}

/**
 * Can a migrated file actually be found?
 *
 * The count and duplicate checks prove there is an index row per file. They do not prove it
 * contains anything: an FTS row whose columns are all empty strings satisfies both. So a sample
 * of files is searched for by a token from their own display name, through the same
 * `toFtsQuery` the repository uses — the query construction is part of what is being checked.
 */
async function checkSearchable(
  gateway: D1Gateway,
  sampleSize: number,
  findings: Finding[],
): Promise<number> {
  if (sampleSize <= 0) return 0;

  const rows = await gateway.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
    [sampleSize],
  );

  const notFound: string[] = [];
  for (const row of rows) {
    const match = toFtsQuery(row.display_name);
    // A name with no searchable word run — "***.dat" — is legitimately unfindable by text, and
    // the repository turns that into no results rather than no filter. Not a defect.
    if (!match) continue;

    const hits = await gateway.query<{ file_id: string }>(
      'SELECT file_id FROM files_fts WHERE files_fts MATCH ? AND file_id = ?',
      [match, row.id],
    );
    if (hits.length === 0) notFound.push(`${row.id} (${row.display_name})`);
  }

  if (notFound.length > 0) {
    findings.push({
      check: 'fts-not-searchable',
      severity: 'error',
      detail: 'files present in the index that cannot be found by their own name',
      sample: notFound.slice(0, 20),
    });
  }
  return rows.length;
}
