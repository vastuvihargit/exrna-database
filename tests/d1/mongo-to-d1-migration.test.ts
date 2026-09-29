/**
 * Phase 9 — the MongoDB → D1 metadata migration.
 *
 * A migration is the one piece of code that runs once, against production, with a write freeze
 * open and no second chance. So the assertions here are aimed at the failures that would be
 * discovered *after* the cutover, when MongoDB has already been retired:
 *
 *   • **The ACL is resolved, not copied.** A principal with two entries — one of them a denial —
 *     must come out denied. Copying the array grants access nobody granted, and the count
 *     comparison a migration is usually judged by would not notice.
 *   • **An expired grant does not become a live one.**
 *   • **Search works.** The FTS insert trigger writes empty keywords by design, so a migration
 *     that relies on it produces a corpus searchable by filename and nothing else.
 *   • **The approval chain survives.** file → exact version → review → approval, with the
 *     approval on the version that was reviewed and not on the current one.
 *   • **The tree survives.** Parent pointers and the ancestor closure table agree.
 *   • **Trashed rows come across.** The Trash is a feature; a migration that dropped it presents
 *     the employee who trashed something yesterday with an empty Trash.
 *   • **Re-running changes nothing.** Which is what makes the final delta pass safe, and what
 *     makes a crash mid-run recoverable.
 *   • **A dry run writes nothing at all.**
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { Types } from 'mongoose';
import { startTestDb, stopTestDb, clearCollections } from '../helpers/test-db';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import {
  ActivityModel,
  AuditLogModel,
  CommentModel,
  DepartmentModel,
  ExperimentModel,
  FileModel,
  FileVersionModel,
  FolderModel,
  InventoryItemModel,
  NotificationModel,
  OrganizationModel,
  ProjectModel,
  ReviewModel,
  RoleModel,
  StarModel,
  StockTransactionModel,
  UserModel,
  UserRoleModel,
} from '@/server/db/models';
import { BindingGateway, DryRunGateway } from '@/server/migration/d1/gateway';
import type { D1Gateway } from '@/server/migration/d1/types';
import { runMigration, selectSteps } from '@/server/migration/d1/runner';
import { MIGRATION_STEPS } from '@/server/migration/d1/registry';
import { NO_DELTA } from '@/server/migration/d1/types';
import { validateSource } from '@/server/migration/d1/validate-source';
import { verifyMigration } from '@/server/migration/d1/verify';
import { toFtsQuery } from '@/server/repositories/fts-query';

let d1: D1Database;
let dbAvailable = false;

/**
 * The reset order spells the foreign keys out, because `users` and `departments` reference each
 * other and no single table order satisfies both. Same reasoning as every other D1 suite.
 */
const D1_RESET = [
  'DELETE FROM d1_migration_failures',
  'DELETE FROM d1_migration_runs',
  'DELETE FROM stock_transaction_documents',
  'DELETE FROM stock_transactions',
  'DELETE FROM inventory_item_documents',
  'DELETE FROM inventory_batches',
  'DELETE FROM inventory_items',
  'DELETE FROM saved_searches',
  'DELETE FROM recent_items',
  'DELETE FROM stars',
  'DELETE FROM activity_folders',
  'DELETE FROM activities',
  'DELETE FROM login_history',
  'DELETE FROM sessions',
  'DELETE FROM audit_logs',
  'DELETE FROM notifications',
  'DELETE FROM approvals',
  'DELETE FROM review_reviewers',
  'DELETE FROM reviews',
  'DELETE FROM comment_mentions',
  'DELETE FROM comments',
  'DELETE FROM resource_permissions',
  'DELETE FROM resource_tags',
  'DELETE FROM file_metadata',
  'DELETE FROM file_folder_ancestors',
  'UPDATE files SET current_version_id = NULL, approved_version_id = NULL',
  'DELETE FROM file_versions',
  'DELETE FROM files',
  'DELETE FROM folder_ancestors',
  'UPDATE folders SET parent_folder_id = NULL, trashed_with_folder_id = NULL',
  'DELETE FROM folders',
  'DELETE FROM experiment_samples',
  'DELETE FROM experiment_collaborators',
  'DELETE FROM experiments',
  'DELETE FROM project_members',
  'DELETE FROM projects',
  'DELETE FROM user_roles',
  'DELETE FROM role_scope_types',
  'DELETE FROM role_permissions',
  'DELETE FROM roles',
  'DELETE FROM app_settings',
  'DELETE FROM drive_sync_states',
  'DELETE FROM alert_states',
  'UPDATE departments SET head_user_id = NULL, created_by = NULL, parent_department_id = NULL',
  'DELETE FROM users',
  'DELETE FROM departments',
  'DELETE FROM organizations',
  'DELETE FROM files_fts',
  'DELETE FROM folders_fts',
  'DELETE FROM experiments_fts',
];

const id = () => new Types.ObjectId();

interface Corpus {
  organizationId: Types.ObjectId;
  departmentId: Types.ObjectId;
  ownerId: Types.ObjectId;
  colleagueId: Types.ObjectId;
  deniedUserId: Types.ObjectId;
  projectId: Types.ObjectId;
  experimentId: Types.ObjectId;
  rootFolderId: Types.ObjectId;
  childFolderId: Types.ObjectId;
  trashedFolderId: Types.ObjectId;
  fileId: Types.ObjectId;
  trashedFileId: Types.ObjectId;
  versionOneId: Types.ObjectId;
  versionTwoId: Types.ObjectId;
  reviewId: Types.ObjectId;
  itemId: Types.ObjectId;
}

/**
 * A corpus small enough to reason about and shaped like the awkward parts of a real one:
 * a two-level folder tree, a trashed folder with a file inside it, a file with two versions of
 * which the *first* is approved, an ACL carrying a duplicate principal and an expired grant, and
 * an inventory item with two batches.
 */
async function seedMongo(): Promise<Corpus> {
  const organizationId = id();
  const departmentId = id();
  const ownerId = id();
  const colleagueId = id();
  const deniedUserId = id();
  const projectId = id();
  const experimentId = id();
  const rootFolderId = id();
  const childFolderId = id();
  const trashedFolderId = id();
  const fileId = id();
  const trashedFileId = id();
  const versionOneId = id();
  const versionTwoId = id();
  const reviewId = id();
  const itemId = id();

  await OrganizationModel.create({
    _id: organizationId,
    name: 'exRNA Labs',
    slug: 'exrna-labs',
    emailDomains: ['exrna.example'],
    settings: {
      defaultUserQuotaBytes: 1024,
      defaultDepartmentQuotaBytes: 4096,
      maxUploadBytes: 512,
    },
  });

  await DepartmentModel.create({
    _id: departmentId,
    organizationId,
    name: 'Molecular Biology',
    code: 'MOLBIO',
    storageQuotaBytes: 4096,
    headUserId: ownerId,
    createdBy: ownerId,
    rootFolderId,
  });

  for (const [userId, name, email] of [
    [ownerId, 'Ada Owner', 'ada@exrna.example'],
    [colleagueId, 'Bo Colleague', 'bo@exrna.example'],
    [deniedUserId, 'Cy Denied', 'cy@exrna.example'],
  ] as const) {
    await UserModel.create({
      _id: userId,
      organizationId,
      email,
      emailDomain: 'exrna.example',
      name,
      status: 'active',
      departmentId,
      storageQuotaBytes: 1024,
      // `select: false`. If the migration does not ask for it, the migrated user cannot log in.
      passwordHash: `argon2-${email}`,
      invitedBy: ownerId,
    });
  }

  const roleId = id();
  await RoleModel.create({
    _id: roleId,
    organizationId,
    key: 'scientist',
    name: 'Scientist',
    rank: 40,
    permissions: ['file.view', 'file.upload'],
    scopeTypes: ['department', 'project'],
  });
  await UserRoleModel.create({
    organizationId,
    userId: ownerId,
    roleId,
    scopeType: 'department',
    scopeId: departmentId,
  });
  await UserRoleModel.create({
    organizationId,
    userId: colleagueId,
    roleId,
    scopeType: 'company',
    scopeId: null,
  });

  await ProjectModel.create({
    _id: projectId,
    organizationId,
    departmentId,
    name: 'Exosome panel',
    code: 'EXR-2026-001',
    memberUserIds: [ownerId, colleagueId],
    tags: ['exosome', 'panel'],
    rootFolderId,
    createdBy: ownerId,
  });

  await ExperimentModel.create({
    _id: experimentId,
    organizationId,
    projectId,
    departmentId,
    code: 'EXP-2026-014',
    title: 'Plasma extraction run',
    objective: 'Compare yields across two kits',
    sampleIds: ['S-4471', 'S-4472'],
    tags: ['qpcr'],
    createdBy: ownerId,
  });

  await FolderModel.create({
    _id: rootFolderId,
    organizationId,
    name: 'Molecular Biology',
    nameLower: 'molecular biology',
    parentFolderId: null,
    pathAncestors: [],
    depth: 0,
    driveType: 'department',
    rootKey: `department:${departmentId.toHexString()}`,
    ownerId,
    departmentId,
    createdBy: ownerId,
    isSystem: true,
  });

  await FolderModel.create({
    _id: childFolderId,
    organizationId,
    name: 'Protocols',
    nameLower: 'protocols',
    parentFolderId: rootFolderId,
    pathAncestors: [rootFolderId],
    depth: 1,
    driveType: 'department',
    ownerId,
    departmentId,
    createdBy: ownerId,
    description: 'Standard operating procedures',
    permissions: [
      // The same principal twice, and the second one is a denial. A migration that copies the
      // array either aborts on the unique index or keeps the allow — which grants access.
      {
        principalType: 'user',
        principalId: deniedUserId,
        accessLevel: 'editor',
        deny: false,
        grantedBy: ownerId,
        grantedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        principalType: 'user',
        principalId: deniedUserId,
        accessLevel: 'viewer',
        deny: true,
        grantedBy: ownerId,
        grantedAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      // Expired: must not become a live grant.
      {
        principalType: 'user',
        principalId: colleagueId,
        accessLevel: 'editor',
        deny: false,
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        grantedBy: ownerId,
      },
    ],
  });

  await FolderModel.create({
    _id: trashedFolderId,
    organizationId,
    name: 'Old drafts',
    nameLower: 'old drafts',
    parentFolderId: rootFolderId,
    pathAncestors: [rootFolderId],
    depth: 1,
    driveType: 'department',
    ownerId,
    departmentId,
    createdBy: ownerId,
    deletedAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedBy: ownerId,
    trashedWithFolderId: rootFolderId,
  });

  await FileModel.create({
    _id: fileId,
    organizationId,
    displayName: 'Extraction protocol.pdf',
    displayNameLower: 'extraction protocol.pdf',
    originalFilename: 'Extraction protocol.pdf',
    extension: 'pdf',
    folderId: childFolderId,
    folderPathAncestors: [rootFolderId, childFolderId],
    driveType: 'department',
    ownerId,
    departmentId,
    projectId,
    experimentId,
    currentVersionId: versionTwoId,
    approvedVersionId: versionOneId,
    versionCount: 2,
    sizeBytes: 120,
    checksumSha256: 'b'.repeat(64),
    tags: ['protocol', 'qpcr'],
    metadata: { sampleId: 'S-4471', experimentCode: 'EXP-2026-014', description: 'Kit A run' },
    approvalStatus: 'approved',
    reviewStatus: 'approved',
    createdBy: ownerId,
    permissions: [
      {
        principalType: 'user',
        principalId: colleagueId,
        accessLevel: 'viewer',
        deny: false,
        grantedBy: ownerId,
      },
    ],
  });

  await FileModel.create({
    _id: trashedFileId,
    organizationId,
    displayName: 'Superseded draft.docx',
    displayNameLower: 'superseded draft.docx',
    originalFilename: 'Superseded draft.docx',
    extension: 'docx',
    folderId: trashedFolderId,
    folderPathAncestors: [rootFolderId, trashedFolderId],
    driveType: 'department',
    ownerId,
    departmentId,
    createdBy: ownerId,
    deletedAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedBy: ownerId,
    trashedWithFolderId: trashedFolderId,
  });

  for (const [versionId, versionNumber, approved] of [
    [versionOneId, 1, true],
    [versionTwoId, 2, false],
  ] as const) {
    await FileVersionModel.create({
      _id: versionId,
      organizationId,
      fileId,
      versionNumber,
      storageKey: `originals/${fileId.toHexString()}/${versionId.toHexString()}`,
      storageArea: 'originals',
      originalFilename: 'Extraction protocol.pdf',
      fileSize: 120,
      mimeType: 'application/pdf',
      extension: 'pdf',
      checksumSha256: (approved ? 'a' : 'b').repeat(64),
      uploadedBy: ownerId,
      isCurrent: versionNumber === 2,
      isApproved: approved,
      ...(approved ? { approvedBy: colleagueId, approvedAt: new Date('2026-07-01T00:00:00.000Z') } : {}),
    });
  }

  await ReviewModel.create({
    _id: reviewId,
    organizationId,
    fileId,
    // Bound to version 1 while version 2 is current. The approval must stay on version 1.
    versionId: versionOneId,
    versionNumber: 1,
    fileName: 'Extraction protocol.pdf',
    versionChecksum: 'a'.repeat(64),
    requestedBy: ownerId,
    requestedByName: 'Ada Owner',
    reviewerUserIds: [colleagueId],
    status: 'approved',
    closedAt: new Date('2026-07-01T00:00:00.000Z'),
    departmentId,
    projectId,
    decisions: [
      {
        reviewerUserId: colleagueId,
        reviewerName: 'Bo Colleague',
        reviewerEmail: 'bo@exrna.example',
        decision: 'approve',
        comment: 'Looks right',
        decidedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ],
  });

  await CommentModel.create({
    organizationId,
    fileId,
    versionId: versionOneId,
    versionNumber: 1,
    authorUserId: colleagueId,
    authorName: 'Bo Colleague',
    body: 'Check the incubation time',
    mentionedUserIds: [ownerId],
  });

  await NotificationModel.create({
    organizationId,
    userId: colleagueId,
    type: 'review.requested',
    actorUserId: ownerId,
    actorName: 'Ada Owner',
    entityType: 'file',
    entityId: fileId,
    entityLabel: 'Extraction protocol.pdf',
    message: 'Ada asked you to review Extraction protocol.pdf',
  });

  await AuditLogModel.create({
    organizationId,
    actorUserId: ownerId,
    actorEmail: 'ada@exrna.example',
    actorRoleKeys: ['scientist'],
    action: 'file.approve',
    entityType: 'file',
    entityId: fileId.toHexString(),
    entityLabel: 'Extraction protocol.pdf',
    ip: '10.0.0.1',
  });

  await ActivityModel.create({
    organizationId,
    actorUserId: ownerId,
    actorName: 'Ada Owner',
    action: 'file.upload',
    entityType: 'file',
    entityId: fileId,
    entityLabel: 'Extraction protocol.pdf',
    contextFolderIds: [rootFolderId, childFolderId],
    departmentId,
    projectId,
  });

  await StarModel.create({ userId: ownerId, organizationId, entityType: 'file', entityId: fileId });

  await InventoryItemModel.create({
    _id: itemId,
    organizationId,
    departmentId,
    name: 'Trizol reagent',
    code: 'RGT-0001',
    category: 'reagent',
    unit: 'mL',
    availableQuantity: 300,
    minimumStock: 100,
    stockState: 'ok',
    batches: [
      { batchNumber: 'B-1', quantity: 100, receivedBy: ownerId, receivedAt: new Date('2026-06-01T00:00:00.000Z') },
      { batchNumber: 'B-2', quantity: 200, receivedBy: ownerId, receivedAt: new Date('2026-07-01T00:00:00.000Z') },
    ],
    createdBy: ownerId,
  });

  await StockTransactionModel.create({
    organizationId,
    itemId,
    itemCode: 'RGT-0001',
    itemName: 'Trizol reagent',
    departmentId,
    action: 'added',
    quantity: 300,
    quantityDelta: 300,
    previousQuantity: 0,
    newQuantity: 300,
    unit: 'mL',
    batchNumber: 'B-1',
    performedBy: ownerId,
    performedByName: 'Ada Owner',
    performedAt: new Date('2026-06-01T00:00:00.000Z'),
  });

  return {
    organizationId,
    departmentId,
    ownerId,
    colleagueId,
    deniedUserId,
    projectId,
    experimentId,
    rootFolderId,
    childFolderId,
    trashedFolderId,
    fileId,
    trashedFileId,
    versionOneId,
    versionTwoId,
    reviewId,
    itemId,
  };
}

async function count(table: string): Promise<number> {
  const result = await d1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all<{ n: number }>();
  return Number(result.results?.[0]?.n ?? 0);
}

async function rows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await d1
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return (result.results ?? []) as T[];
}

async function migrate(): Promise<Awaited<ReturnType<typeof runMigration>>> {
  return runMigration({ gateway: new BindingGateway(d1), delta: NO_DELTA, pageSize: 50 });
}

beforeAll(async () => {
  const database = await startTestDb();
  dbAvailable = database.available;
  if (!dbAvailable) {
    throw new Error(`MongoDB is required for the migration suite: ${database.reason}`);
  }
  d1 = await startTestD1();
}, 300_000);

afterAll(async () => {
  await stopTestD1();
  await stopTestDb();
});

/**
 * Migration 0001 installs `RAISE(ABORT)` on `BEFORE DELETE` for the two append-only tables, so
 * resetting them means dropping those triggers and putting them straight back. Recreated in a
 * `finally` rather than in `afterEach`, so a test that throws cannot leave the tables mutable
 * for everything that follows it — the inventory and audit suites do the same thing.
 */
const APPEND_ONLY_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
   BEFORE DELETE ON audit_logs
   BEGIN SELECT RAISE(ABORT, 'Audit logs are append-only and cannot be modified or deleted'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_stock_transactions_no_delete
   BEFORE DELETE ON stock_transactions
   BEGIN SELECT RAISE(ABORT, 'Stock history is append-only and cannot be modified or deleted'); END;`,
];

beforeEach(async () => {
  await clearCollections();
  try {
    await d1.prepare('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete').run();
    await d1.prepare('DROP TRIGGER IF EXISTS trg_stock_transactions_no_delete').run();
    await clearD1(d1, D1_RESET);
  } finally {
    for (const trigger of APPEND_ONLY_TRIGGERS) await d1.prepare(trigger).run();
  }
});

describe('the migration registry', () => {
  it('declares a dependency order that is satisfiable in registry order', () => {
    const seen = new Set<string>();
    for (const step of MIGRATION_STEPS) {
      for (const requirement of step.requires) {
        expect(seen.has(requirement), `${step.name} requires ${requirement}`).toBe(true);
      }
      seen.add(step.name);
    }
  });

  it('refuses a partial run whose dependencies are missing', () => {
    // The useful moment to say "that will fail on a foreign key" is before anything is written,
    // not four hundred records into a batch that then rolls back.
    expect(() => selectSteps(['files'])).toThrow(/requires/);
    expect(() => selectSteps(['organizations'])).not.toThrow();
  });
});

describe('migrating a corpus', () => {
  let corpus: Corpus;

  beforeEach(async () => {
    corpus = await seedMongo();
  });

  it('reports no blocking issues in a well-formed source', async () => {
    const validation = await validateSource();
    const blockers = validation.issues.filter((issue) => issue.severity === 'blocker');
    expect(blockers, JSON.stringify(blockers, null, 2)).toEqual([]);
    // The duplicate-principal ACL is advisory, not blocking: the migration resolves it.
    expect(validation.issues.map((issue) => issue.check)).toContain('acl-conflicts');
  });

  it('copies every domain, preserving the MongoDB ids', async () => {
    const report = await migrate();
    expect(report.ok, JSON.stringify(report.steps.filter((s) => s.failed > 0), null, 2)).toBe(true);

    expect(await count('organizations')).toBe(1);
    expect(await count('departments')).toBe(1);
    expect(await count('users')).toBe(3);
    expect(await count('roles')).toBe(1);
    expect(await count('role_permissions')).toBe(2);
    expect(await count('user_roles')).toBe(2);
    expect(await count('projects')).toBe(1);
    expect(await count('project_members')).toBe(2);
    expect(await count('experiments')).toBe(1);
    expect(await count('experiment_samples')).toBe(2);
    expect(await count('folders')).toBe(3);
    expect(await count('files')).toBe(2);
    expect(await count('file_versions')).toBe(2);
    expect(await count('reviews')).toBe(1);
    expect(await count('approvals')).toBe(1);
    expect(await count('comments')).toBe(1);
    expect(await count('comment_mentions')).toBe(1);
    expect(await count('notifications')).toBe(1);
    expect(await count('audit_logs')).toBe(1);
    expect(await count('activities')).toBe(1);
    expect(await count('activity_folders')).toBe(2);
    expect(await count('stars')).toBe(1);
    expect(await count('inventory_items')).toBe(1);
    expect(await count('inventory_batches')).toBe(2);
    expect(await count('stock_transactions')).toBe(1);

    const [file] = await rows<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM files WHERE id = ?',
      corpus.fileId.toHexString(),
    );
    expect(file?.display_name).toBe('Extraction protocol.pdf');
  });

  it('keeps the password hash the schema hides from ordinary reads', async () => {
    await migrate();
    const [user] = await rows<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = ?',
      corpus.ownerId.toHexString(),
    );
    // A users table migrated without it looks complete and authenticates nobody — discovered at
    // the first login after cutover, with the rollback window running.
    expect(user?.password_hash).toBe('argon2-ada@exrna.example');
  });

  it('resolves a duplicated ACL principal to the denial, and drops the expired grant', async () => {
    await migrate();

    const entries = await rows<{ principal_id: string; access_level: string; deny: number }>(
      'SELECT principal_id, access_level, deny FROM resource_permissions ' +
        'WHERE resource_type = ? AND resource_id = ?',
      'folder',
      corpus.childFolderId.toHexString(),
    );

    // One row for the twice-listed principal, and it is the denial.
    const denied = entries.filter((entry) => entry.principal_id === corpus.deniedUserId.toHexString());
    expect(denied).toHaveLength(1);
    expect(Number(denied[0]?.deny)).toBe(1);

    // The expired editor grant contributes nothing at all.
    expect(entries.map((entry) => entry.principal_id)).not.toContain(
      corpus.colleagueId.toHexString(),
    );
  });

  it('rebuilds the folder tree and the ancestor closure table consistently', async () => {
    await migrate();

    const [child] = await rows<{ parent_folder_id: string | null }>(
      'SELECT parent_folder_id FROM folders WHERE id = ?',
      corpus.childFolderId.toHexString(),
    );
    expect(child?.parent_folder_id).toBe(corpus.rootFolderId.toHexString());

    const ancestors = await rows<{ ancestor_id: string; depth: number }>(
      'SELECT ancestor_id, depth FROM folder_ancestors WHERE folder_id = ? ORDER BY depth',
      corpus.childFolderId.toHexString(),
    );
    expect(ancestors).toEqual([{ ancestor_id: corpus.rootFolderId.toHexString(), depth: 0 }]);

    const fileAncestors = await rows<{ ancestor_id: string; depth: number }>(
      'SELECT ancestor_id, depth FROM file_folder_ancestors WHERE file_id = ? ORDER BY depth',
      corpus.fileId.toHexString(),
    );
    expect(fileAncestors.map((row) => row.ancestor_id)).toEqual([
      corpus.rootFolderId.toHexString(),
      corpus.childFolderId.toHexString(),
    ]);
  });

  it('brings the Trash across, including what it was trashed with', async () => {
    await migrate();

    const [folder] = await rows<{ deleted_at: string | null; trashed_with_folder_id: string | null }>(
      'SELECT deleted_at, trashed_with_folder_id FROM folders WHERE id = ?',
      corpus.trashedFolderId.toHexString(),
    );
    expect(folder?.deleted_at).not.toBeNull();
    // Restoring the ancestor must restore exactly the set that was trashed with it.
    expect(folder?.trashed_with_folder_id).toBe(corpus.rootFolderId.toHexString());

    const [trashedFile] = await rows<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM files WHERE id = ?',
      corpus.trashedFileId.toHexString(),
    );
    expect(trashedFile?.deleted_at).not.toBeNull();
  });

  it('keeps the approval on the version that was reviewed, not the current one', async () => {
    await migrate();

    const [approval] = await rows<{ version_id: string; reviewer_user_id: string }>(
      'SELECT version_id, reviewer_user_id FROM approvals',
    );
    expect(approval?.version_id).toBe(corpus.versionOneId.toHexString());
    expect(approval?.reviewer_user_id).toBe(corpus.colleagueId.toHexString());

    const [fileRow] = await rows<{ current_version_id: string; approved_version_id: string }>(
      'SELECT current_version_id, approved_version_id FROM files WHERE id = ?',
      corpus.fileId.toHexString(),
    );
    // The current version is v2 and the approved one is still v1. A new upload does not inherit
    // an approval, and neither does a migration.
    expect(fileRow?.current_version_id).toBe(corpus.versionTwoId.toHexString());
    expect(fileRow?.approved_version_id).toBe(corpus.versionOneId.toHexString());
  });

  it('makes migrated files findable by tag, sample id and description', async () => {
    await migrate();

    // The insert trigger writes empty keywords, so each of these fails unless the migration
    // rebuilt the index row itself. Queried through `toFtsQuery` — the same construction the
    // repository uses — because a bare `S-4471` is not a search term to FTS5, it is a column
    // filter, and passing raw employee input to MATCH is the defect fixed in FINAL-READINESS 5.2.
    for (const term of ['protocol', 'S-4471', 'EXP-2026-014']) {
      const hits = await rows<{ file_id: string }>(
        'SELECT file_id FROM files_fts WHERE files_fts MATCH ?',
        toFtsQuery(term),
      );
      expect(hits.map((hit) => hit.file_id), `searching for ${term}`).toContain(
        corpus.fileId.toHexString(),
      );
    }

    // And the trashed file is absent from the index entirely.
    const all = await rows<{ file_id: string }>('SELECT file_id FROM files_fts');
    expect(all.map((row) => row.file_id)).not.toContain(corpus.trashedFileId.toHexString());
  });

  it('makes an experiment findable by its sample id', async () => {
    await migrate();
    const hits = await rows<{ experiment_id: string }>(
      'SELECT experiment_id FROM experiments_fts WHERE experiments_fts MATCH ?',
      toFtsQuery('S-4472'),
    );
    expect(hits.map((hit) => hit.experiment_id)).toEqual([corpus.experimentId.toHexString()]);
  });

  it('passes its own verification pass', async () => {
    await migrate();
    const report = await verifyMigration({ gateway: new BindingGateway(d1) });

    const mismatched = report.counts.filter((entry) => !entry.ok);
    expect(mismatched, JSON.stringify(mismatched, null, 2)).toEqual([]);
    const errors = report.findings.filter((finding) => finding.severity === 'error');
    expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('changes nothing when it is run a second time', async () => {
    await migrate();
    const before = await snapshot();

    const second = await migrate();
    expect(second.ok).toBe(true);

    // Idempotence is what makes the final delta pass safe, and what makes a crash mid-run
    // recoverable by simply running it again.
    expect(await snapshot()).toEqual(before);
  });

  it('writes nothing at all in a dry run', async () => {
    const gateway = new DryRunGateway(new BindingGateway(d1));
    const report = await runMigration({ gateway, delta: NO_DELTA, pageSize: 50 });

    expect(report.dryRun).toBe(true);
    expect(report.totals.written).toBeGreaterThan(0);
    expect(gateway.statementsSeen).toBeGreaterThan(0);

    // Including its own checkpoint table: a dry run that left rows in `d1_migration_runs` would
    // make the next resumed run think it had already loaded something.
    expect(await count('organizations')).toBe(0);
    expect(await count('files')).toBe(0);
    expect(await count('d1_migration_runs')).toBe(0);
  });

  it('resumes an interrupted run without duplicating or skipping anything', async () => {
    const gateway = new BindingGateway(d1);
    // A run restricted to identity, as though the process had died after the users step.
    await runMigration({
      gateway,
      runId: 'run_partial',
      delta: NO_DELTA,
      steps: [
        'organizations',
        'departments',
        'users',
        'departments-backfill',
        'users-backfill',
      ],
    });
    expect(await count('users')).toBe(3);

    const resumed = await runMigration({
      gateway,
      runId: 'run_partial',
      resume: true,
      delta: NO_DELTA,
    });
    expect(resumed.ok).toBe(true);

    // The already-completed steps report as skipped, and everything downstream still lands —
    // which only works if the resumed run re-published the ids of the steps it skipped.
    const identity = resumed.steps.find((step) => step.step === 'users');
    expect(identity?.status).toBe('skipped');
    expect(await count('users')).toBe(3);
    expect(await count('files')).toBe(2);
    expect(await count('file_versions')).toBe(2);
  });

  it('records a record it cannot migrate instead of losing the batch it is in', async () => {
    // A star pointing at a file that is not there. It is not an error — the file may have been
    // purged — but it must be reported rather than written as a broken tile.
    await StarModel.create({
      userId: corpus.ownerId,
      organizationId: corpus.organizationId,
      entityType: 'file',
      entityId: id(),
    });

    const report = await migrate();
    const stars = report.steps.find((step) => step.step === 'stars');

    expect(stars?.written).toBe(1);
    expect(stars?.skipped).toBe(1);
    expect(stars?.skips[0]?.reason).toMatch(/was not migrated/);
    // The good star still landed.
    expect(await count('stars')).toBe(1);
  });

  it('applies a delta pass to a record whose parents did not change', async () => {
    await migrate();
    const since = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Only the file changes. Its organization, folder, owner and project were loaded by the bulk
    // pass and are not in the delta — the case the final pass exists for, and the one that fails
    // if reference checks only know about ids read in the current run.
    await FileModel.updateOne(
      { _id: corpus.fileId },
      { $set: { displayName: 'Extraction protocol v2.pdf', displayNameLower: 'extraction protocol v2.pdf' } },
    );
    const before = await snapshot();

    const report = await runMigration({
      gateway: new BindingGateway(d1),
      delta: { since },
      pageSize: 50,
    });
    expect(report.ok).toBe(true);

    const files = report.steps.find((step) => step.step === 'files');
    expect(files?.read).toBe(1);
    expect(files?.written).toBe(1);
    expect(files?.skipped).toBe(0);

    const [file] = await rows<{ display_name: string; folder_id: string; created_by: string }>(
      'SELECT display_name, folder_id, created_by FROM files WHERE id = ?',
      corpus.fileId.toHexString(),
    );
    expect(file).toEqual({
      display_name: 'Extraction protocol v2.pdf',
      folder_id: corpus.childFolderId.toHexString(),
      created_by: corpus.ownerId.toHexString(),
    });
    // Nothing else moved: a delta pass converges on the same shape as a full re-run.
    expect(await snapshot()).toEqual(before);
  });

  it('resumes a failed step from its last committed page, counting each record once', async () => {
    const inner = new BindingGateway(d1);
    let filePages = 0;
    // The database refuses the second page of files, as a dropped connection would.
    const flaky: D1Gateway = {
      dryRun: false,
      label: 'flaky',
      query: (sql, params) => inner.query(sql, params),
      async run(statements) {
        if (statements.some((statement) => statement.sql.startsWith('INSERT INTO files '))) {
          filePages += 1;
          if (filePages === 2) throw new Error('D1_ERROR: network connection lost');
        }
        return inner.run(statements);
      },
    };

    const first = await runMigration({ gateway: flaky, runId: 'run_flaky', delta: NO_DELTA, pageSize: 1 });
    expect(first.ok).toBe(false);
    const failed = first.steps.find((step) => step.step === 'files');
    expect(failed?.status).toBe('failed');

    const [checkpoint] = await rows<{ status: string; last_id: string | null; rows_read: number }>(
      "SELECT status, last_id, rows_read FROM d1_migration_runs WHERE id = 'run_flaky:files'",
    );
    // The first page committed, so the checkpoint keeps it — and does not count the refused one.
    expect(checkpoint?.status).toBe('failed');
    expect(checkpoint?.last_id).not.toBeNull();
    expect(checkpoint?.rows_read).toBe(1);

    const resumed = await runMigration({
      gateway: inner,
      runId: 'run_flaky',
      resume: true,
      delta: NO_DELTA,
      pageSize: 1,
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.steps.find((step) => step.step === 'files')?.read).toBe(2);
    expect(await count('files')).toBe(2);
    expect(await count('file_versions')).toBe(2);
  });
});

/** Everything that should be identical after a re-run. */
async function snapshot(): Promise<Record<string, number>> {
  const tables = [
    'organizations',
    'departments',
    'users',
    'user_auth_providers',
    'roles',
    'role_permissions',
    'user_roles',
    'projects',
    'project_members',
    'experiments',
    'experiment_samples',
    'folders',
    'folder_ancestors',
    'files',
    'file_folder_ancestors',
    'file_metadata',
    'resource_tags',
    'file_versions',
    'resource_permissions',
    'comments',
    'comment_mentions',
    'reviews',
    'review_reviewers',
    'approvals',
    'notifications',
    'audit_logs',
    'activities',
    'activity_folders',
    'stars',
    'inventory_items',
    'inventory_batches',
    'stock_transactions',
    'files_fts',
    'experiments_fts',
  ];
  const result: Record<string, number> = {};
  for (const table of tables) result[table] = await count(table);
  return result;
}
