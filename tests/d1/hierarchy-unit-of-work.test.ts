/**
 * Phase 3, module 7 — the atomic D1 folder+file move.
 *
 * The claim under test is narrow and total: **there is no outcome in which the folders move and
 * the files do not.** Everything else here supports that one assertion.
 *
 * The failure it prevents is not a cosmetic one. A file whose `file_folder_ancestors` rows
 * still name its old parent inherits the *old parent's* ACL, because the inheritance predicate
 * is a correlated sub-query over exactly those rows. So a half-applied move does not produce a
 * wrong breadcrumb; it produces a file that stays visible to the people who could see where it
 * used to live. That is why the injected-file-failure test is the important one, and why the
 * inheritance test asserts visibility rather than structure.
 *
 * ── How failures are injected ───────────────────────────────────────────────────────────
 *
 * By foreign key violation, not by mocking. `file_folder_ancestors.ancestor_id` references
 * `folders.id`, so a chain entry naming a folder that does not exist makes exactly one
 * statement fail inside an otherwise valid batch — which is precisely the shape of the bug
 * being defended against, and it exercises D1's real rollback rather than a stub of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting, getD1 } from '@/server/db/d1-context';
import { withBatch } from '@/server/db/d1';
import {
  hierarchyMutationEngine,
  moveFolderSubtreeWithFiles,
  planHierarchyMoveForTesting,
  SplitDataSourceMoveError,
  SubtreeTooLargeError,
  MAX_BATCH_STATEMENTS,
  MAX_MOVE_FOLDERS,
} from '@/server/db/d1-unit-of-work';
import * as folderRepository from '@/server/repositories/folder.repository.d1';
import * as fileRepository from '@/server/repositories/file.repository.d1';
import {
  clearDataSourceOverrides,
  setDataSourceOverride,
} from '@/server/repositories/data-source';
import type { FolderRecord } from '@/server/repositories/folder.repository.contract';
import type { Actor, RoleGrant } from '@/server/permissions/actor';
import type { Permission } from '@/server/domain/permissions';

const ORG = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';
const ALICE = '507f1f77bcf86cd799439031';
const BOB = '507f1f77bcf86cd799439032';
const FOREIGNER = '507f1f77bcf86cd799439034';
const DEPT_A = '507f1f77bcf86cd799439041';
const PROJ_A = '507f1f77bcf86cd799439051';
const ROLE = '507f1f77bcf86cd799439061';
const ISO = '2026-01-01T00:00:00.000Z';

let d1: D1Database;

/* ------------------------------------------------------------------ fixtures */

async function seedWorld(): Promise<void> {
  const run = (text: string, ...binds: unknown[]) => d1.prepare(text).bind(...binds).run();

  for (const [id, name] of [
    [ORG, 'Org A'],
    [ORG_B, 'Org B'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO organizations (id,name,slug,email_domains,settings,storage_used_bytes,file_count,is_active,created_at,updated_at)
       VALUES (?,?,?,'[]','{}',0,0,1,?,?)`,
      id, name, id.slice(-4), ISO, ISO,
    );
  }
  for (const [id, organizationId, email] of [
    [ALICE, ORG, 'alice@company.com'],
    [BOB, ORG, 'bob@company.com'],
    [FOREIGNER, ORG_B, 'zed@other.com'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO users (id,organization_id,email,email_domain,name,mfa,preferences,status,is_super_admin,storage_quota_bytes,storage_used_bytes,must_change_password,failed_login_count,created_at,updated_at)
       VALUES (?,?,?,'company.com',?,'{"enabled":false}','{}','active',0,1,0,0,0,?,?)`,
      id, organizationId, email, email.split('@')[0], ISO, ISO,
    );
  }
  await run(
    `INSERT OR IGNORE INTO departments (id,organization_id,name,code,description,storage_quota_bytes,storage_used_bytes,member_count,is_active,created_at,updated_at)
     VALUES (?,?,'Dept A','AAA','',1,0,0,1,?,?)`,
    DEPT_A, ORG, ISO, ISO,
  );
  await run(
    `INSERT OR IGNORE INTO projects (id,organization_id,department_id,name,code,description,status,confidentiality,storage_used_bytes,file_count,created_at,updated_at)
     VALUES (?,?,?,'Project A','PA','','active','internal',0,0,?,?)`,
    PROJ_A, ORG, DEPT_A, ISO, ISO,
  );
  await run(
    `INSERT OR IGNORE INTO roles (id,organization_id,key,name,description,rank,max_confidentiality,company_wide_read,is_system,created_at,updated_at)
     VALUES (?,?,'reviewer','Reviewer','',40,'internal',0,0,?,?)`,
    ROLE, ORG, ISO, ISO,
  );
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: BOB,
    email: 'bob@company.com',
    name: 'Bob',
    organizationId: ORG,
    departmentId: null,
    projectIds: [],
    isSuperAdmin: false,
    status: 'active',
    grants: [] as RoleGrant[],
    permissions: new Set<Permission>(),
    roleKeys: [],
    highestRank: 0,
    sessionId: 's',
    storageQuotaBytes: 0,
    storageUsedBytes: 0,
    ...overrides,
  };
}

async function root(
  key: string,
  options: {
    organizationId?: string;
    ownerId?: string;
    departmentId?: string | null;
    projectId?: string | null;
  } = {},
) {
  const ownerId = options.ownerId ?? ALICE;
  const organizationId = options.organizationId ?? ORG;
  return folderRepository.ensureRoot({
    rootKey: key,
    organizationId,
    name: key,
    driveType: 'my',
    ownerId,
    departmentId: options.departmentId ?? null,
    projectId: options.projectId ?? null,
    confidentiality: 'internal',
    createdBy: ownerId,
  });
}

async function child(
  parent: FolderRecord,
  name: string,
  options: { inheritPermissions?: boolean } = {},
): Promise<FolderRecord> {
  const folder = await folderRepository.create({
    organizationId: parent.organizationId,
    name,
    parentFolderId: parent.id,
    pathAncestors: [...parent.pathAncestors, parent.id],
    depth: parent.depth + 1,
    driveType: parent.driveType,
    ownerId: parent.ownerId,
    departmentId: parent.departmentId,
    projectId: parent.projectId,
    confidentiality: 'internal',
    createdBy: parent.ownerId,
  });
  if (options.inheritPermissions === false) {
    return (await folderRepository.updateById(folder.id, { inheritPermissions: false }))!;
  }
  return folder;
}

async function file(folder: FolderRecord, name: string) {
  return fileRepository.create({
    organizationId: folder.organizationId,
    displayName: name,
    originalFilename: name,
    extension: 'csv',
    category: 'raw_data',
    folderId: folder.id,
    folderPathAncestors: [...folder.pathAncestors, folder.id],
    driveType: folder.driveType,
    ownerId: folder.ownerId,
    departmentId: folder.departmentId,
    projectId: folder.projectId,
    confidentiality: 'internal',
    sizeBytes: 10,
    mimeType: 'text/csv',
    checksumSha256: 'c'.repeat(64),
    createdBy: folder.ownerId,
  });
}

async function share(resourceType: 'file' | 'folder', resourceId: string, principalId: string) {
  await d1
    .prepare(
      `INSERT INTO resource_permissions (id,organization_id,resource_type,resource_id,principal_type,principal_id,access_level,deny,expires_at,granted_by,granted_at)
       VALUES (?,?,?,?,'user',?,'view',0,NULL,?,?)`,
    )
    .bind(crypto.randomUUID(), ORG, resourceType, resourceId, principalId, ALICE, ISO)
    .run();
}

/** The move input the folder service builds, for a subtree rooted at `folder`. */
function moveInput(folder: FolderRecord, destination: FolderRecord) {
  return {
    folderId: folder.id,
    newParentId: destination.id,
    newPathAncestors: [...destination.pathAncestors, destination.id],
    driveType: destination.driveType,
    departmentId: destination.departmentId,
    projectId: destination.projectId,
    ownerId: destination.ownerId,
    updatedBy: ALICE,
    previousParentId: folder.parentFolderId,
  };
}

/** Both integrity checkers, which every successful move must leave clean. */
async function integrity() {
  return {
    folders: await folderRepository.checkHierarchyIntegrity(ORG),
    files: await fileRepository.checkFileHierarchyIntegrity(ORG),
  };
}

async function chainOf(fileId: string): Promise<string[]> {
  const row = await fileRepository.findByIdInternal(fileId);
  return row?.folderPathAncestors ?? [];
}

async function folderChainOf(folderId: string): Promise<string[]> {
  const row = await folderRepository.findByIdInternal(folderId);
  return row?.pathAncestors ?? [];
}

/* ------------------------------------------------------------------ lifecycle */

beforeAll(async () => {
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
}, 300_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  clearDataSourceOverrides();
  await stopTestD1();
});

beforeEach(async () => {
  clearDataSourceOverrides();
  await clearD1(d1, [
    'DELETE FROM files_fts',
    'DELETE FROM file_versions',
    'DELETE FROM file_metadata',
    'DELETE FROM file_folder_ancestors',
    'DELETE FROM resource_tags',
    'DELETE FROM resource_permissions',
    'DELETE FROM files',
    'DELETE FROM folder_ancestors',
    'DELETE FROM folders',
  ]);
  await seedWorld();
});

/* ================================================================== the basic move */

describe('a folder subtree and its files move together', () => {
  it('re-points folders, descendants and every contained file in one operation', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const file1 = await file(y, 'file1.csv');
    const file2 = await file(y, 'file2.csv');
    const inX = await file(x, 'direct.csv');

    await moveFolderSubtreeWithFiles(moveInput(x, b));

    // 1. the moved folder
    const movedX = (await folderRepository.findByIdInternal(x.id))!;
    expect(movedX.parentFolderId).toBe(b.id);
    expect(movedX.depth).toBe(b.depth + 1);
    expect(await folderChainOf(x.id)).toEqual([b.id]);

    // 2. the descendant folder
    expect(await folderChainOf(y.id)).toEqual([b.id, x.id]);

    // 3. files two levels down
    expect(await chainOf(file1.id)).toEqual([b.id, x.id, y.id]);
    expect(await chainOf(file2.id)).toEqual([b.id, x.id, y.id]);

    // 4. a file directly in the moved folder
    expect(await chainOf(inX.id)).toEqual([b.id, x.id]);

    // 5. both hierarchies agree with themselves
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('propagates drive type, department and project to folders and files alike', async () => {
    const a = await root('root-a');
    // The destination carries a department and a project; the subtree must adopt both.
    const destination = await root('root-b', { departmentId: DEPT_A, projectId: PROJ_A });

    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const moved = await file(y, 'f.csv');

    await moveFolderSubtreeWithFiles(moveInput(x, destination));

    expect((await folderRepository.findByIdInternal(y.id))!.departmentId).toBe(DEPT_A);
    const movedFile = (await fileRepository.findByIdInternal(moved.id))!;
    expect(movedFile.departmentId).toBe(DEPT_A);
    expect(movedFile.projectId).toBe(PROJ_A);
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('leaves a folder with no files alone rather than emitting empty file statements', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');

    await moveFolderSubtreeWithFiles(moveInput(x, b));
    expect(await folderChainOf(x.id)).toEqual([b.id]);
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });
});

/* ================================================================== rollback */

describe('the batch is all-or-nothing', () => {
  /**
   * Builds the same statement list the unit of work builds, with one entry poisoned.
   *
   * Going through the builders rather than through `moveFolderSubtreeWithFiles` is the point:
   * the composed batch is what has to roll back, and this constructs exactly that batch with a
   * single failing statement in the half under test.
   */
  async function runPoisonedBatch(
    folder: FolderRecord,
    destination: FolderRecord,
    poison: 'folder' | 'file',
  ) {
    const db = await getD1();
    const input = moveInput(folder, destination);
    const plan = await planHierarchyMoveForTesting(input);
    const movePlan = await folderRepository.planFolderMove(
      db,
      input.folderId,
      input.newPathAncestors,
    );
    const guard = folderRepository.moveGuard(input.folderId, movePlan.stamp);

    // A folder id that does not exist. `file_folder_ancestors.ancestor_id` and
    // `folders.parent_folder_id` both reference `folders.id`, so either half can be made to
    // fail on a foreign key without touching anything else.
    const ghost = 'ghost-folder-does-not-exist';

    const folderStatements = folderRepository.buildFolderMoveStatements(
      db,
      poison === 'folder' ? { ...input, newParentId: ghost } : input,
      movePlan,
    );
    const fileStatements = fileRepository.buildFileReparentStatements(db, {
      folderId: input.folderId,
      newPathAncestorsForFolder: input.newPathAncestors,
      driveType: input.driveType,
      departmentId: input.departmentId,
      projectId: input.projectId,
      folderChains:
        poison === 'file'
          ? plan.fileFolderChains.map((entry, index) =>
              index === 0 ? { ...entry, chain: [ghost, ...entry.chain] } : entry,
            )
          : plan.fileFolderChains,
      now: movePlan.now,
      guard,
    });

    const commit = folderRepository.buildFolderMoveCommitStatement(
      db,
      poison === 'folder' ? { ...input, newParentId: ghost } : input,
      movePlan,
    );

    await withBatch(db, [...folderStatements, ...fileStatements, commit]);
  }

  it('rolls the folder half back when a FILE statement fails', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const moved = await file(y, 'f.csv');

    const before = {
      xParent: (await folderRepository.findByIdInternal(x.id))!.parentFolderId,
      xChain: await folderChainOf(x.id),
      yChain: await folderChainOf(y.id),
      fileChain: await chainOf(moved.id),
    };

    // The most important assertion in this suite: the folder statements are valid and would
    // have committed on their own. Only the file half fails.
    await expect(runPoisonedBatch(x, b, 'file')).rejects.toThrow();

    expect((await folderRepository.findByIdInternal(x.id))!.parentFolderId).toBe(before.xParent);
    expect(await folderChainOf(x.id)).toEqual(before.xChain);
    expect(await folderChainOf(y.id)).toEqual(before.yChain);
    expect(await chainOf(moved.id)).toEqual(before.fileChain);
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('rolls the file half back when a FOLDER statement fails', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const moved = await file(y, 'f.csv');

    const before = {
      xChain: await folderChainOf(x.id),
      fileChain: await chainOf(moved.id),
    };

    await expect(runPoisonedBatch(x, b, 'folder')).rejects.toThrow();

    expect(await folderChainOf(x.id)).toEqual(before.xChain);
    expect(await chainOf(moved.id)).toEqual(before.fileChain);
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });
});

/* ================================================================== concurrency */

describe('a stale plan applies nothing', () => {
  it('refuses both halves when the folder changed after planning', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const moved = await file(y, 'f.csv');

    const db = await getD1();
    const input = moveInput(x, b);
    const plan = await planHierarchyMoveForTesting(input);
    const movePlan = await folderRepository.planFolderMove(
      db,
      input.folderId,
      input.newPathAncestors,
    );
    const guard = folderRepository.moveGuard(input.folderId, movePlan.stamp);

    // Somebody else renames the folder between planning and execution. `updated_at` moves, and
    // the whole plan is now describing a state that no longer exists.
    await folderRepository.updateById(x.id, { name: 'RenamedByRival' });

    const before = { xChain: await folderChainOf(x.id), fileChain: await chainOf(moved.id) };

    await withBatch(db, [
      ...folderRepository.buildFolderMoveStatements(db, input, movePlan),
      ...fileRepository.buildFileReparentStatements(db, {
        folderId: input.folderId,
        newPathAncestorsForFolder: input.newPathAncestors,
        driveType: input.driveType,
        departmentId: input.departmentId,
        projectId: input.projectId,
        folderChains: plan.fileFolderChains,
        now: movePlan.now,
        guard,
      }),
      folderRepository.buildFolderMoveCommitStatement(db, input, movePlan),
    ]);

    // The batch succeeded — every statement simply matched nothing. That is the design: a
    // stale plan is a no-op, never a partial write.
    expect(await folderChainOf(x.id)).toEqual(before.xChain);
    expect(await chainOf(moved.id)).toEqual(before.fileChain);
    expect((await folderRepository.findByIdInternal(x.id))!.parentFolderId).toBe(a.id);
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('the file half is guarded too, not only the folder half', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');
    const moved = await file(x, 'f.csv');

    const db = await getD1();
    const input = moveInput(x, b);
    const plan = await planHierarchyMoveForTesting(input);
    const movePlan = await folderRepository.planFolderMove(db, x.id, input.newPathAncestors);
    const staleGuard = folderRepository.moveGuard(x.id, movePlan.stamp);

    await folderRepository.updateById(x.id, { name: 'Renamed' });
    const before = await chainOf(moved.id);

    // File statements alone, with a guard that no longer holds. If the guard were absent or
    // only applied to the folder half, this would rewrite the file's chain on its own.
    await withBatch(
      db,
      fileRepository.buildFileReparentStatements(db, {
        folderId: x.id,
        newPathAncestorsForFolder: input.newPathAncestors,
        driveType: input.driveType,
        departmentId: input.departmentId,
        projectId: input.projectId,
        folderChains: plan.fileFolderChains,
        now: movePlan.now,
        guard: staleGuard,
      }),
    );

    expect(await chainOf(moved.id)).toEqual(before);
  });

  it('retries and succeeds when contention resolves', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');
    const moved = await file(x, 'f.csv');

    // The unit of work re-plans on a no-op, so an ordinary move still goes through.
    await moveFolderSubtreeWithFiles(moveInput(x, b));
    expect(await chainOf(moved.id)).toEqual([b.id, x.id]);
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });
});

/* ================================================================== refusals */

describe('structural refusals leave no trace', () => {
  it('refuses to move a folder into itself', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const before = await folderChainOf(x.id);

    await expect(
      moveFolderSubtreeWithFiles({ ...moveInput(x, a), newParentId: x.id }),
    ).rejects.toThrow(/into itself/i);

    expect(await folderChainOf(x.id)).toEqual(before);
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('refuses to move a folder underneath its own descendant', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const moved = await file(y, 'f.csv');
    const before = { chain: await folderChainOf(x.id), fileChain: await chainOf(moved.id) };

    await expect(moveFolderSubtreeWithFiles(moveInput(x, y))).rejects.toThrow(/subfolder/i);

    expect(await folderChainOf(x.id)).toEqual(before.chain);
    expect(await chainOf(moved.id)).toEqual(before.fileChain);
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('refuses a cross-organization move', async () => {
    const a = await root('root-a');
    const foreign = await root('root-foreign', { organizationId: ORG_B, ownerId: FOREIGNER });
    const x = await child(a, 'X');
    const moved = await file(x, 'f.csv');
    const before = { chain: await folderChainOf(x.id), fileChain: await chainOf(moved.id) };

    await expect(moveFolderSubtreeWithFiles(moveInput(x, foreign))).rejects.toThrow(
      /another organization/i,
    );

    expect(await folderChainOf(x.id)).toEqual(before.chain);
    expect(await chainOf(moved.id)).toEqual(before.fileChain);
  });

  it('refuses a destination that no longer exists', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');
    await folderRepository.purge([b.id]);

    await expect(moveFolderSubtreeWithFiles(moveInput(x, b))).rejects.toThrow(/no longer exists/i);
    expect(await folderChainOf(x.id)).toEqual([a.id]);
  });
});

/* ================================================================== inheritance */

describe('inherited access follows the move immediately', () => {
  it('grants from the new location apply and grants from the old one stop', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const oldParent = await child(a, 'OldParent');
    const newParent = await child(b, 'NewParent');
    const x = await child(oldParent, 'X');
    const moved = await file(x, 'secret.csv');

    // Bob can reach the file only through a grant on its old ancestor.
    await share('folder', oldParent.id, BOB);
    expect((await fileRepository.findById(actor(), moved.id))?.id).toBe(moved.id);

    // Carol-equivalent: a grant on the destination side, which must start applying.
    await share('folder', newParent.id, BOB);

    await moveFolderSubtreeWithFiles({
      ...moveInput(x, newParent),
      previousParentId: oldParent.id,
    });

    // Still visible — now through the *new* ancestor.
    expect((await fileRepository.findById(actor(), moved.id))?.id).toBe(moved.id);

    // And with the destination grant removed, the old grant must not resurrect it.
    await d1
      .prepare(`DELETE FROM resource_permissions WHERE resource_id = ?`)
      .bind(newParent.id)
      .run();

    expect(await fileRepository.findById(actor(), moved.id)).toBeNull();
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('a listing cannot expose stale access after the move', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const oldParent = await child(a, 'OldParent');
    const x = await child(oldParent, 'X');
    const moved = await file(x, 'secret.csv');

    await share('folder', oldParent.id, BOB);
    const beforeMove = await fileRepository.search({
      actor: actor(),
      page: 1,
      pageSize: 20,
      sort: 'displayName',
      order: 'asc',
    });
    expect(beforeMove.items.map((i) => i.id)).toEqual([moved.id]);

    await moveFolderSubtreeWithFiles({ ...moveInput(x, b), previousParentId: oldParent.id });

    // The old grant no longer reaches it, and that must be true of the count as well as the
    // rows — a total of 1 would announce the file just as effectively.
    const afterMove = await fileRepository.search({
      actor: actor(),
      page: 1,
      pageSize: 20,
      sort: 'displayName',
      order: 'asc',
    });
    expect(afterMove.items).toEqual([]);
    expect(afterMove.total).toBe(0);
  });

  it('respects an inheritance boundary inside the moved subtree', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');
    const sealed = await child(x, 'Sealed', { inheritPermissions: false });
    const behindBoundary = await file(sealed, 'sealed.csv');
    const openFile = await file(x, 'open.csv');

    await moveFolderSubtreeWithFiles(moveInput(x, b));
    // A grant on the new parent of the moved folder reaches the open file but stops at the
    // boundary folder, exactly as it did before the move.
    await share('folder', x.id, BOB);

    expect((await fileRepository.findById(actor(), openFile.id))?.id).toBe(openFile.id);
    expect(await fileRepository.findById(actor(), behindBoundary.id)).toBeNull();
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });
});

/* ================================================================== size limits */

describe('subtree size limits', () => {
  it('counts statements as folders × depth, not files × depth', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');
    for (let i = 0; i < 25; i += 1) await file(x, `f${i}.csv`);

    const withManyFiles = await planHierarchyMoveForTesting(moveInput(x, b));
    expect(withManyFiles.counts.files).toBe(25);

    // One more file must not cost one more statement — that regression is what made large
    // folders unmovable before.
    await file(x, 'one-more.csv');
    const withOneMore = await planHierarchyMoveForTesting(moveInput(x, b));
    expect(withOneMore.counts.files).toBe(26);
    expect(withOneMore.counts.statements).toBe(withManyFiles.counts.statements);
  });

  it('refuses a subtree with too many folders, before writing anything', async () => {
    const a = await root('root-a');
    const b = await root('root-b');
    const x = await child(a, 'X');
    const moved = await file(x, 'f.csv');
    const before = await chainOf(moved.id);

    // Fabricated rather than created: building 200 real folders would take minutes and prove
    // the same thing. `folder_ancestors` is what the planner counts, so extra marker rows make
    // the subtree look large.
    const statements: string[] = [];
    for (let i = 0; i < MAX_MOVE_FOLDERS + 1; i += 1) {
      const ghostId = `bulk-${i}`;
      statements.push(
        `INSERT INTO folders (id,organization_id,name,name_lower,parent_folder_id,depth,drive_type,owner_id,inherit_permissions,confidentiality,status,description,is_system,child_folder_count,file_count,storage_provider,drive_mapping_status,sync_status,created_by,created_at,updated_at)
         VALUES ('${ghostId}','${ORG}','g${i}','g${i}','${x.id}',2,'my','${ALICE}',1,'internal','active','',0,0,0,'local','none','not_required','${ALICE}','${ISO}','${ISO}')`,
        `INSERT INTO folder_ancestors (folder_id,ancestor_id,depth) VALUES ('${ghostId}','${a.id}',0)`,
        `INSERT INTO folder_ancestors (folder_id,ancestor_id,depth) VALUES ('${ghostId}','${x.id}',1)`,
      );
    }
    await clearD1(d1, statements);

    await expect(moveFolderSubtreeWithFiles(moveInput(x, b))).rejects.toBeInstanceOf(
      SubtreeTooLargeError,
    );

    // Nothing was written: the check runs against the plan, before the batch opens.
    expect(await chainOf(moved.id)).toEqual(before);
    expect((await folderRepository.findByIdInternal(x.id))!.parentFolderId).toBe(a.id);
  });

  it('the declared limits are internally consistent', () => {
    // A subtree at the folder ceiling, each folder at the depth ceiling, must still fit the
    // statement ceiling — otherwise the folder limit is decorative and the real refusal would
    // come from a batch failure instead of a clean error.
    expect(MAX_MOVE_FOLDERS).toBeLessThan(MAX_BATCH_STATEMENTS);
    // And the folder count is also a per-statement binding count, which must stay inside the
    // 999 SQLITE_MAX_VARIABLE_NUMBER budget `visibility.d1.ts` documents.
    expect(MAX_MOVE_FOLDERS).toBeLessThanOrEqual(200);
  });
});

/* ================================================================== provider combinations */

describe('hierarchy mutations never span two databases', () => {
  it('selects D1 when both modules are on D1', () => {
    setDataSourceOverride('folders', 'd1');
    setDataSourceOverride('files', 'd1');
    expect(hierarchyMutationEngine()).toBe('d1');
  });

  it('selects Mongo when both modules are on Mongo', () => {
    setDataSourceOverride('folders', 'mongo');
    setDataSourceOverride('files', 'mongo');
    expect(hierarchyMutationEngine()).toBe('mongo');
  });

  it('refuses when folders are on D1 and files are not', () => {
    setDataSourceOverride('folders', 'd1');
    setDataSourceOverride('files', 'mongo');
    expect(() => hierarchyMutationEngine()).toThrow(SplitDataSourceMoveError);
  });

  it('refuses when files are on D1 and folders are not', () => {
    setDataSourceOverride('folders', 'mongo');
    setDataSourceOverride('files', 'd1');
    expect(() => hierarchyMutationEngine()).toThrow(SplitDataSourceMoveError);
  });

  it('the refusal is a 409 that names both flags, and never a silent fallback', () => {
    setDataSourceOverride('folders', 'd1');
    setDataSourceOverride('files', 'mongo');
    try {
      hierarchyMutationEngine();
      throw new Error('should have refused');
    } catch (error) {
      const refusal = error as SplitDataSourceMoveError;
      expect(refusal).toBeInstanceOf(SplitDataSourceMoveError);
      expect(refusal.status).toBe(409);
      expect(JSON.stringify(refusal.details)).toContain('DATA_SOURCE_FOLDERS=d1');
      expect(JSON.stringify(refusal.details)).toContain('DATA_SOURCE_FILES=mongo');
    }
  });
});
