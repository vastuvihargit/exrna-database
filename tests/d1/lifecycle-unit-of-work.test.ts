/**
 * Phase 3, module 8 — atomic D1 trash, restore and archive across folders and files.
 *
 * The claim is the same shape as module 7's, applied to the three remaining cascading
 * operations: **there is no outcome in which the folders change lifecycle state and the files do
 * not.** Everything here supports that.
 *
 * The consequence of a half-applied sweep is milder than a half-applied move — these write
 * `status`, `deleted_at` and `trashed_with_folder_id`, not the closure table, so nothing
 * mis-inherits an ACL. What it does produce is a folder in the trash whose files still read as
 * active: `listTrashed` and the folder listing disagree, the files stay in search, and a restore
 * afterwards cannot tell which files it was supposed to bring back, because
 * `trashed_with_folder_id` was never written. That last one is the reason this matters — a
 * failure here corrupts the *record of what happened*, which the restore depends on.
 *
 * ── How failures are injected ───────────────────────────────────────────────────────────
 *
 * By foreign key violation, not by mocking, exactly as in module 7. `files.deleted_by` and
 * `folders.deleted_by` reference `users.id`, so a sweep attributed to a user who does not exist
 * makes one half fail inside an otherwise valid batch, and D1's real rollback is what the
 * assertions then observe.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { eq, sql } from 'drizzle-orm';
import { setD1BindingForTesting, getD1 } from '@/server/db/d1-context';
import { withBatch } from '@/server/db/d1';
import { files, folders } from '@/server/db/schema/drive';
import {
  hierarchyMutationEngine,
  restoreFolderSubtreeWithFiles,
  setFolderSubtreeStatusWithFiles,
  trashFolderSubtreeWithFiles,
  SplitDataSourceHierarchyError,
  type HierarchyOperation,
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
  await run(
    `INSERT OR IGNORE INTO users (id,organization_id,email,email_domain,name,mfa,preferences,status,is_super_admin,storage_quota_bytes,storage_used_bytes,must_change_password,failed_login_count,created_at,updated_at)
     VALUES (?,?,'alice@company.com','company.com','Alice','{"enabled":false}','{}','active',0,1,0,0,0,?,?)`,
    ALICE, ORG, ISO, ISO,
  );
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: ALICE,
    email: 'alice@company.com',
    name: 'Alice',
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

async function root(key: string, organizationId = ORG): Promise<FolderRecord> {
  return folderRepository.ensureRoot({
    rootKey: `${key}:${organizationId}`,
    organizationId,
    name: key,
    driveType: 'my',
    ownerId: ALICE,
    departmentId: null,
    projectId: null,
    confidentiality: 'internal',
    createdBy: ALICE,
  });
}

async function child(parent: FolderRecord, name: string): Promise<FolderRecord> {
  return folderRepository.create({
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

/**
 * Seeds many files directly, in batches, because `create()` one at a time is far too slow to
 * reach the thousand-file scale this suite needs to exercise.
 *
 * Writes the `file_folder_ancestors` rows too, exactly as `create()` would — otherwise
 * `checkFileHierarchyIntegrity` would report every one of them and the size test would be
 * asserting against a deliberately broken fixture.
 */
async function seedFilesInBulk(folder: FolderRecord, howMany: number): Promise<void> {
  const chain = [...folder.pathAncestors, folder.id];
  // Files per batch. Each file costs 1 + `chain.length` statements, so this stays well inside
  // any batch limit while keeping the number of round trips down — the round trips are what
  // make this fixture expensive.
  const CHUNK = 150;

  for (let start = 0; start < howMany; start += CHUNK) {
    const statements: D1PreparedStatement[] = [];

    for (let index = start; index < Math.min(start + CHUNK, howMany); index += 1) {
      const id = `bulk-file-${index}`;
      statements.push(
        d1
          .prepare(
            `INSERT INTO files (id,organization_id,display_name,display_name_lower,original_filename,
               extension,category,folder_id,drive_type,owner_id,department_id,project_id,version_count,
               size_bytes,mime_type,confidentiality,review_status,approval_status,status,
               inherit_permissions,download_count,created_by,storage_provider,has_google_native_content,
               created_at,updated_at)
             VALUES (?,?,?,?,?,'csv','raw_data',?,'my',?,NULL,NULL,0,10,'text/csv','internal','draft','none','active',1,0,?,'local',0,?,?)`,
          )
          .bind(
            id, ORG, `${id}.csv`, `${id}.csv`, `${id}.csv`, folder.id, ALICE, ALICE, ISO, ISO,
          ),
      );
      chain.forEach((ancestorId, depth) => {
        statements.push(
          d1
            .prepare(
              'INSERT INTO file_folder_ancestors (file_id, ancestor_id, depth) VALUES (?,?,?)',
            )
            .bind(id, ancestorId, depth),
        );
      });
    }

    await d1.batch(statements);
  }
}

/** The input the folder service builds for a sweep of `folder`. */
function sweepInput(folder: FolderRecord) {
  return { folderId: folder.id, userId: ALICE, parentFolderId: folder.parentFolderId };
}

/* ------------------------------------------------------------------ observation */

/**
 * Read straight from the table rather than through `findByIdInternal`.
 *
 * `archived_at` is not on `FolderRecord` — it is the column that distinguishes the folder the
 * user archived from the descendants that merely followed it, and that distinction is exactly
 * what these tests need to see.
 */
async function folderState(folderId: string) {
  const row = await d1
    .prepare(
      'SELECT status, deleted_at, trashed_with_folder_id, archived_at FROM folders WHERE id = ?',
    )
    .bind(folderId)
    .first<{
      status: string;
      deleted_at: string | null;
      trashed_with_folder_id: string | null;
      archived_at: string | null;
    }>();
  return row
    ? {
        status: row.status,
        trashed: row.deleted_at !== null,
        trashedWith: row.trashed_with_folder_id,
        archivedAt: row.archived_at !== null,
      }
    : null;
}

async function fileState(fileId: string) {
  const row = await fileRepository.findByIdInternal(fileId, { includeDeleted: true });
  return row
    ? { status: row.status, trashed: row.deletedAt !== null, trashedWith: row.trashedWithFolderId }
    : null;
}

/** Whether the file still has a row in the FTS index — the index, not a query predicate. */
async function indexed(fileId: string): Promise<boolean> {
  const row = await d1
    .prepare('SELECT count(*) AS n FROM files_fts WHERE file_id = ?')
    .bind(fileId)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

async function searchNames(
  text: string,
  options: { includeArchived?: boolean } = {},
): Promise<string[]> {
  const page = await fileRepository.search({
    actor: actor(),
    text,
    page: 1,
    pageSize: 50,
    sort: 'relevance',
    order: 'desc',
    ...options,
  });
  return page.items.map((item) => item.displayName);
}

async function integrity() {
  return {
    folders: await folderRepository.checkHierarchyIntegrity(ORG),
    files: await fileRepository.checkFileHierarchyIntegrity(ORG),
  };
}

async function childCount(folderId: string): Promise<number> {
  const row = await folderRepository.findByIdInternal(folderId, { includeDeleted: true });
  return row?.childFolderCount ?? -1;
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

/* ================================================================== trash */

describe('trashing a folder takes its subtree and files with it', () => {
  it('trashes an empty folder, and reports one folder and no files', async () => {
    const a = await root('root-a');
    const empty = await child(a, 'Empty');

    expect(await trashFolderSubtreeWithFiles(sweepInput(empty))).toEqual({
      folders: 1,
      files: 0,
    });
    expect(await folderState(empty.id)).toMatchObject({ status: 'trashed', trashed: true });
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('trashes a folder, its descendants and every file inside', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const direct = await file(x, 'direct.csv');
    const nested = await file(y, 'nested.csv');

    const counts = await trashFolderSubtreeWithFiles(sweepInput(x));

    expect(counts).toEqual({ folders: 2, files: 2 });
    expect(await folderState(x.id)).toMatchObject({
      status: 'trashed',
      trashed: true,
      // The folder the user acted on is not "swept in" by anything.
      trashedWith: null,
    });
    expect(await folderState(y.id)).toMatchObject({ trashed: true, trashedWith: x.id });
    expect(await fileState(direct.id)).toEqual({
      status: 'trashed',
      trashed: true,
      trashedWith: x.id,
    });
    expect(await fileState(nested.id)).toEqual({
      status: 'trashed',
      trashed: true,
      trashedWith: x.id,
    });
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('decrements the parent child count with the same batch', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    // Relative, because `create` does not maintain the counter — the service does, and this
    // batch is the half of it that belongs to the sweep.
    const before = await childCount(a.id);

    await trashFolderSubtreeWithFiles(sweepInput(x));

    expect(await childCount(a.id)).toBe(before - 1);
  });

  it('reports 1 for an already-trashed folder, and changes nothing further', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const only = await file(x, 'f.csv');
    await trashFolderSubtreeWithFiles(sweepInput(x));
    const after = await fileState(only.id);

    // The count has always been "descendants matched + 1", whether or not the folder itself
    // matched. Pinned rather than corrected: it reaches an audit entry.
    expect(await trashFolderSubtreeWithFiles(sweepInput(x))).toEqual({ folders: 1, files: 0 });
    expect(await fileState(only.id)).toEqual(after);
  });

  it('leaves another organization an identically shaped tree untouched', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const mine = await file(x, 'mine.csv');

    const foreignRoot = await root('root-foreign', ORG_B);
    const foreignChild = await child(foreignRoot, 'X');
    const theirs = await file(foreignChild, 'theirs.csv');

    await trashFolderSubtreeWithFiles(sweepInput(x));

    expect(await fileState(mine.id)).toMatchObject({ trashed: true });
    expect(await folderState(foreignChild.id)).toMatchObject({ trashed: false });
    expect(await fileState(theirs.id)).toMatchObject({ trashed: false });
  });
});

/* ================================================================== restore */

describe('restoring brings back exactly what the trash took', () => {
  it('restores the folder, its descendants and the files swept in with it', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const nested = await file(y, 'nested.csv');

    await trashFolderSubtreeWithFiles(sweepInput(x));
    const trashedCount = await childCount(a.id);
    const counts = await restoreFolderSubtreeWithFiles(sweepInput(x));

    expect(counts).toEqual({ folders: 2, files: 1 });
    expect(await folderState(x.id)).toMatchObject({ status: 'active', trashed: false });
    expect(await folderState(y.id)).toMatchObject({
      status: 'active',
      trashed: false,
      trashedWith: null,
    });
    expect(await fileState(nested.id)).toEqual({
      status: 'active',
      trashed: false,
      trashedWith: null,
    });
    expect(await childCount(a.id)).toBe(trashedCount + 1);
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  /**
   * The rule the whole `trashed_with_folder_id` column exists for.
   *
   * A file the user deleted on purpose must not come back because somebody later restored the
   * folder around it. It carries no `trashed_with_folder_id`, so the restore predicate does not
   * match it — which is also why a half-applied *trash* would be so damaging: the tag is what
   * the restore reads to tell the two cases apart.
   */
  it('leaves a file that was already in the trash before the folder was trashed', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const deliberate = await file(x, 'deliberate.csv');
    const sweptIn = await file(x, 'swept.csv');

    await fileRepository.setDeleted({ fileId: deliberate.id, deleted: true, userId: ALICE });
    await trashFolderSubtreeWithFiles(sweepInput(x));
    await restoreFolderSubtreeWithFiles(sweepInput(x));

    expect(await fileState(deliberate.id)).toMatchObject({ trashed: true });
    expect(await fileState(sweptIn.id)).toMatchObject({ trashed: false });
  });

  it('leaves a folder that was already in the trash before its parent was trashed', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const deliberate = await child(x, 'Deliberate');
    const sweptIn = await child(x, 'SweptIn');

    await folderRepository.setSubtreeDeleted({
      folderId: deliberate.id,
      deleted: true,
      userId: ALICE,
    });
    await trashFolderSubtreeWithFiles(sweepInput(x));
    await restoreFolderSubtreeWithFiles(sweepInput(x));

    expect(await folderState(deliberate.id)).toMatchObject({ trashed: true });
    expect(await folderState(sweptIn.id)).toMatchObject({ trashed: false });
  });
});

/* ================================================================== archive */

describe('archiving a folder carries its live files', () => {
  it('archives the subtree and every live file in it', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const nested = await file(y, 'nested.csv');

    const counts = await setFolderSubtreeStatusWithFiles({
      folderId: x.id,
      status: 'archived',
      userId: ALICE,
    });

    expect(counts).toEqual({ folders: 2, files: 1 });
    // `archived_at` marks the one folder the user archived, so the Archive view lists it and
    // not its whole subtree. Descendants change status only.
    expect(await folderState(x.id)).toMatchObject({ status: 'archived', archivedAt: true });
    expect(await folderState(y.id)).toMatchObject({ status: 'archived', archivedAt: false });
    expect(await fileState(nested.id)).toMatchObject({ status: 'archived', trashed: false });
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('unarchives the subtree and its files', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const only = await file(x, 'f.csv');

    await setFolderSubtreeStatusWithFiles({ folderId: x.id, status: 'archived', userId: ALICE });
    await setFolderSubtreeStatusWithFiles({ folderId: x.id, status: 'active', userId: ALICE });

    expect(await folderState(x.id)).toMatchObject({ status: 'active', archivedAt: false });
    expect(await fileState(only.id)).toMatchObject({ status: 'active' });
  });

  /** Archive and trash are separate lifecycles; archiving around a trashed file must not revive it. */
  it('does not change a trashed file, and does not un-trash it on unarchive', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const trashed = await file(x, 'trashed.csv');
    await fileRepository.setDeleted({ fileId: trashed.id, deleted: true, userId: ALICE });

    await setFolderSubtreeStatusWithFiles({ folderId: x.id, status: 'archived', userId: ALICE });
    expect(await fileState(trashed.id)).toMatchObject({ status: 'trashed', trashed: true });

    await setFolderSubtreeStatusWithFiles({ folderId: x.id, status: 'active', userId: ALICE });
    expect(await fileState(trashed.id)).toMatchObject({ status: 'trashed', trashed: true });
  });

  it('is idempotent for an already-archived subtree', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const only = await file(x, 'f.csv');

    await setFolderSubtreeStatusWithFiles({ folderId: x.id, status: 'archived', userId: ALICE });
    const again = await setFolderSubtreeStatusWithFiles({
      folderId: x.id,
      status: 'archived',
      userId: ALICE,
    });

    expect(again).toEqual({ folders: 1, files: 1 });
    expect(await fileState(only.id)).toMatchObject({ status: 'archived' });
  });
});

/* ================================================================== atomicity */

/**
 * Builds the composed batch the unit-of-work builds, with one extra statement in the named half
 * that violates a foreign key.
 *
 * ── Why the poison is a separate statement ──────────────────────────────────────────────
 *
 * The obvious injection — attribute the sweep to a user who does not exist — does nothing:
 * `deleted_by` is `text('deleted_by')` in `_shared.ts` with no `references()`, so there is no
 * constraint to violate. The columns that *do* carry a foreign key here are
 * `folders.parent_folder_id` and `files.trashed_with_folder_id`, both pointing at `folders.id`,
 * so the poison is a real write to the half under test naming a folder that does not exist.
 *
 * What that proves is the property that matters: the sweep's own statements are valid and would
 * have committed on their own, and one failure anywhere in the composed batch discards all of
 * them — folder half and file half alike.
 */
async function runPoisonedSweep(
  folder: FolderRecord,
  deleted: boolean,
  poison: 'folder' | 'file',
) {
  const db = await getD1();
  const now = ISO;
  const GHOST_FOLDER = 'ghost-folder-does-not-exist';

  const statements = [
    ...folderRepository.buildFolderSubtreeDeletedStatements(db, {
      folderId: folder.id,
      deleted,
      userId: ALICE,
      now,
    }),
    ...fileRepository.buildFileSubtreeDeletedStatements(db, {
      folderId: folder.id,
      deleted,
      userId: ALICE,
      now,
    }),
  ];

  statements.push(
    poison === 'folder'
      ? db.update(folders).set({ parentFolderId: GHOST_FOLDER }).where(eq(folders.id, folder.id))
      : db
          .update(files)
          .set({ trashedWithFolderId: GHOST_FOLDER })
          // Anywhere in the subtree, not only directly in this folder — the file under test
          // sits one level down in most of these cases.
          .where(
            sql`${files.id} IN (SELECT file_id FROM file_folder_ancestors WHERE ancestor_id = ${folder.id})`,
          ),
  );

  await withBatch(db, statements);
}

describe('a lifecycle sweep is all-or-nothing', () => {
  it('rolls the folder half back when the FILE statement fails', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const only = await file(y, 'f.csv');

    // The most important assertion here: the folder statements are valid and would have
    // committed on their own. Only the file half fails.
    await expect(runPoisonedSweep(x, true, 'file')).rejects.toThrow();

    expect(await folderState(x.id)).toMatchObject({ status: 'active', trashed: false });
    expect(await folderState(y.id)).toMatchObject({ status: 'active', trashed: false });
    expect(await fileState(only.id)).toMatchObject({ status: 'active', trashed: false });
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('rolls the file half back when a FOLDER statement fails', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const only = await file(x, 'f.csv');

    await expect(runPoisonedSweep(x, true, 'folder')).rejects.toThrow();

    expect(await folderState(x.id)).toMatchObject({ trashed: false });
    expect(await fileState(only.id)).toMatchObject({ trashed: false });
    expect(await integrity()).toEqual({ folders: [], files: [] });
  });

  it('rolls the whole restore back when the file half fails', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const y = await child(x, 'Y');
    const only = await file(y, 'f.csv');
    await trashFolderSubtreeWithFiles(sweepInput(x));

    await expect(runPoisonedSweep(x, false, 'file')).rejects.toThrow();

    // Everything is still in the trash, and still tagged with the deletion that swept it in —
    // so a later, valid restore can still find exactly this set.
    expect(await folderState(x.id)).toMatchObject({ trashed: true });
    expect(await folderState(y.id)).toMatchObject({ trashed: true, trashedWith: x.id });
    expect(await fileState(only.id)).toMatchObject({ trashed: true, trashedWith: x.id });

    expect(await restoreFolderSubtreeWithFiles(sweepInput(x))).toEqual({ folders: 2, files: 1 });
  });

  it('rolls an archive back when one half fails', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const only = await file(x, 'f.csv');
    const db = await getD1();

    await expect(
      withBatch(db, [
        ...folderRepository.buildFolderSubtreeStatusStatements(db, {
          folderId: x.id,
          status: 'archived',
          userId: ALICE,
          now: ISO,
        }),
        ...fileRepository.buildFileSubtreeStatusStatements(db, {
          folderId: x.id,
          status: 'archived',
          now: ISO,
        }),
        // A status change writes no column with a foreign key, so the failure is injected with
        // one that does: `folders.parent_folder_id` references `folders.id`.
        db
          .update(folders)
          .set({ parentFolderId: 'ghost-folder-does-not-exist' })
          .where(eq(folders.id, x.id)),
      ]),
    ).rejects.toThrow();

    expect(await folderState(x.id)).toMatchObject({ status: 'active' });
    expect(await fileState(only.id)).toMatchObject({ status: 'active' });
  });
});

/* ================================================================== the index */

describe('the full-text index follows the lifecycle', () => {
  it('drops a trashed file from the index and returns it on restore', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const only = await file(x, 'spectrogram.csv');

    expect(await indexed(only.id)).toBe(true);
    expect(await searchNames('spectrogram')).toEqual(['spectrogram.csv']);

    await trashFolderSubtreeWithFiles(sweepInput(x));

    // The index itself, not merely the query predicate: search cannot return what is not there.
    expect(await indexed(only.id)).toBe(false);
    expect(await searchNames('spectrogram')).toEqual([]);

    await restoreFolderSubtreeWithFiles(sweepInput(x));

    expect(await indexed(only.id)).toBe(true);
    expect(await searchNames('spectrogram')).toEqual(['spectrogram.csv']);
  });

  /**
   * Archive hides a file from search through a *predicate*, not by de-indexing it — and the two
   * are worth telling apart. `search()` adds `status != 'archived'` unless `includeArchived` is
   * asked for, so the same row is absent from a default search and present in an archive-aware
   * one. If the trigger had dropped it from `files_fts` instead, `includeArchived` would return
   * nothing and the Archive view would be silently empty.
   */
  it('keeps an archived file in the index, and lets the query decide', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');
    const only = await file(x, 'chromatogram.csv');

    await setFolderSubtreeStatusWithFiles({ folderId: x.id, status: 'archived', userId: ALICE });

    expect(await indexed(only.id)).toBe(true);
    expect(await fileState(only.id)).toMatchObject({ status: 'archived' });
    expect(await searchNames('chromatogram')).toEqual([]);
    expect(await searchNames('chromatogram', { includeArchived: true })).toEqual([
      'chromatogram.csv',
    ]);

    await setFolderSubtreeStatusWithFiles({ folderId: x.id, status: 'active', userId: ALICE });

    expect(await indexed(only.id)).toBe(true);
    expect(await searchNames('chromatogram')).toEqual(['chromatogram.csv']);
  });
});

/* ================================================================== scale */

describe('subtree size', () => {
  /**
   * The statement count is fixed, so a large folder is not a special case.
   *
   * This is not a micro-optimisation. The previous file half read the matching ids and bound
   * them into `WHERE id IN (...)`, one parameter per file; SQLite's default ceiling is 999, so
   * trashing a folder of a thousand files would have failed outright — and nothing said so.
   *
   * The count sits just above that ceiling rather than comfortably above it. Everything here is
   * a real round trip to a real D1, and this is by some way the most expensive fixture in the
   * suite; 1050 demonstrates the property exactly as well as 5000 would.
   */
  it('trashes and restores a folder holding more files than SQLite can bind', async () => {
    const a = await root('root-a');
    const x = await child(a, 'X');

    const many = 1050;
    await seedFilesInBulk(x, many);

    expect(await trashFolderSubtreeWithFiles(sweepInput(x))).toEqual({
      folders: 1,
      files: many,
    });
    expect(await restoreFolderSubtreeWithFiles(sweepInput(x))).toEqual({
      folders: 1,
      files: many,
    });
    expect(await integrity()).toEqual({ folders: [], files: [] });
  }, 300_000);
});

/* ================================================================== provider combinations */

describe('lifecycle mutations never span two databases', () => {
  const CASCADING: HierarchyOperation[] = ['move', 'trash', 'restore', 'archive', 'unarchive'];

  it('selects D1 for every cascading operation when both modules are on D1', () => {
    setDataSourceOverride('folders', 'd1');
    setDataSourceOverride('files', 'd1');
    for (const operation of CASCADING) {
      expect(hierarchyMutationEngine(operation)).toBe('d1');
    }
  });

  it('selects Mongo for every cascading operation when both modules are on Mongo', () => {
    setDataSourceOverride('folders', 'mongo');
    setDataSourceOverride('files', 'mongo');
    for (const operation of CASCADING) {
      expect(hierarchyMutationEngine(operation)).toBe('mongo');
    }
  });

  it('refuses every cascading operation when folders are on D1 and files are not', () => {
    setDataSourceOverride('folders', 'd1');
    setDataSourceOverride('files', 'mongo');
    for (const operation of CASCADING) {
      expect(() => hierarchyMutationEngine(operation)).toThrow(SplitDataSourceHierarchyError);
    }
  });

  it('refuses every cascading operation when files are on D1 and folders are not', () => {
    setDataSourceOverride('folders', 'mongo');
    setDataSourceOverride('files', 'd1');
    for (const operation of CASCADING) {
      expect(() => hierarchyMutationEngine(operation)).toThrow(SplitDataSourceHierarchyError);
    }
  });

  it('names the operation and both flags in the refusal, and never falls back silently', () => {
    setDataSourceOverride('folders', 'mongo');
    setDataSourceOverride('files', 'd1');
    try {
      hierarchyMutationEngine('trash');
      throw new Error('should have refused');
    } catch (error) {
      const refusal = error as SplitDataSourceHierarchyError;
      expect(refusal).toBeInstanceOf(SplitDataSourceHierarchyError);
      expect(refusal.status).toBe(409);
      expect(refusal.operation).toBe('trash');
      expect(JSON.stringify(refusal.details)).toContain('DATA_SOURCE_FOLDERS=mongo');
      expect(JSON.stringify(refusal.details)).toContain('DATA_SOURCE_FILES=d1');
    }
  });
});
