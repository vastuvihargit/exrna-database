/**
 * Phase 3, module 9 — the D1 file-version repository and the atomic version write.
 *
 * The module shipped without a line of it having executed. This suite is that execution, and
 * two of its claims are the ones worth the harness:
 *
 * **Numbering cannot collide.** `nextVersionNumber()` is `MAX + 1` read outside any
 * transaction, so two uploads to the same file *will* propose the same number. The unique index
 * on `(file_id, version_number)` is the authority and the retry loop is the recovery, and the
 * concurrency test here forces both attempts to read the same number before either writes,
 * rather than hoping the scheduler interleaves them.
 *
 * **The two halves cannot separate.** "Which version is current" lives in
 * `files.current_version_id` *and* `file_versions.is_current`. Downloads read the pointer; the
 * history list reads the flag. A write that lands one without the other produces a file that
 * shows one thing and serves another, and nothing later notices. So every creation test ends at
 * `assertCurrentVersionInvariant`, and the two rollback tests poison each half in turn.
 *
 * ── How failures are injected ───────────────────────────────────────────────────────────
 *
 * By real constraint violation, never by mocking `withBatch`. `file_versions.uploaded_by` and
 * `files.current_version_id` are both real references, and the unique index on
 * `(file_id, version_number)` is real — so each poisoned batch fails the way production would,
 * and what the assertions observe is D1's own rollback.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { and, eq } from 'drizzle-orm';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting, getD1 } from '@/server/db/d1-context';
import { withBatch } from '@/server/db/d1';
import { files, fileVersions } from '@/server/db/schema/drive';
import {
  createVersionWithFile,
  versionMutationEngine,
  SplitDataSourceVersionError,
} from '@/server/db/d1-unit-of-work';
import * as folderRepository from '@/server/repositories/folder.repository.d1';
import * as fileRepository from '@/server/repositories/file.repository.d1';
import * as versionRepository from '@/server/repositories/file-version.repository.d1';
import { validateVersionGraph } from '@/server/repositories/file-version.validator.d1';
import {
  clearDataSourceOverrides,
  setDataSourceOverride,
} from '@/server/repositories/data-source';
import type { FolderRecord } from '@/server/repositories/folder.repository.contract';
import type { FileRecord } from '@/server/repositories/file.repository.contract';
import type {
  CreateVersionInput,
  VersionPatch,
} from '@/server/repositories/file-version.repository.contract';

const ORG = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';
const ALICE = '507f1f77bcf86cd799439031';
const GHOST_USER = 'user-that-does-not-exist';
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

async function file(folder: FolderRecord, name = 'sample.csv'): Promise<FileRecord> {
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
    checksumSha256: 'a'.repeat(64),
    createdBy: folder.ownerId,
  });
}

/** The version fields an upload supplies, minus the number the unit-of-work assigns. */
function versionFields(
  target: FileRecord,
  overrides: Partial<CreateVersionInput> = {},
): Omit<CreateVersionInput, 'versionNumber'> {
  const key = `originals/${target.id}/${overrides.storedFilename ?? crypto.randomUUID()}`;
  return {
    organizationId: target.organizationId,
    fileId: target.id,
    storageKey: key,
    storageArea: 'originals',
    relativeStoragePath: `originals/${key}`,
    storedFilename: key.split('/').pop()!,
    originalFilename: target.originalFilename,
    fileSize: 10,
    mimeType: 'text/csv',
    extension: 'csv',
    checksumSha256: 'b'.repeat(64),
    uploadedBy: ALICE,
    ...overrides,
  };
}

/** What the upload service patches onto the file alongside a new version. */
function fileFields(overrides: Record<string, unknown> = {}) {
  return {
    sizeBytes: 10,
    mimeType: 'text/csv',
    checksumSha256: 'b'.repeat(64),
    originalFilename: 'sample.csv',
    updatedBy: ALICE,
    versionCountDelta: 1,
    ...overrides,
  };
}

async function addVersion(target: FileRecord, overrides: Partial<CreateVersionInput> = {}) {
  return createVersionWithFile({
    version: versionFields(target, overrides),
    file: fileFields(),
  });
}

/* ------------------------------------------------------------------ invariants */

/**
 * The invariant the whole module exists to keep.
 *
 * Asserted after every creation, because the two representations of "current" are read by
 * different code paths — the pointer by a download, the flag by the history list — so a
 * disagreement is invisible from either one alone.
 */
async function assertCurrentVersionInvariant(fileId: string): Promise<string> {
  const db = await getD1();
  const currents = await db
    .select({ id: fileVersions.id })
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.isCurrent, true)));

  expect(currents, 'exactly one version may be current').toHaveLength(1);

  const stored = await fileRepository.findByIdInternal(fileId);
  expect(stored?.currentVersionId, 'files.current_version_id must name that version').toBe(
    currents[0]!.id,
  );
  return currents[0]!.id;
}

/**
 * Every message in an error's `cause` chain, joined.
 *
 * Drizzle reports the statement it failed on and hangs the driver's reason off `cause`, so
 * `toThrow(/FOREIGN KEY/)` matches nothing however true the constraint failure is.
 */
function causeChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' | ') || String(error);
}

async function versionRow(versionId: string) {
  const db = await getD1();
  const [row] = await db.select().from(fileVersions).where(eq(fileVersions.id, versionId)).limit(1);
  return row ?? null;
}

async function fileState(fileId: string) {
  const row = await fileRepository.findByIdInternal(fileId);
  return row
    ? {
        currentVersionId: row.currentVersionId,
        approvedVersionId: row.approvedVersionId,
        versionCount: row.versionCount,
      }
    : null;
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

/* ================================================================== numbering */

describe('version numbers run 1, 2, 3', () => {
  it('assigns sequential numbers and keeps the file in step', async () => {
    const target = await file(await root('root-a'));

    const first = await addVersion(target);
    expect(first.versionNumber).toBe(1);
    expect(await assertCurrentVersionInvariant(target.id)).toBe(first.versionId);

    const second = await addVersion(target);
    expect(second.versionNumber).toBe(2);

    const third = await addVersion(target);
    expect(third.versionNumber).toBe(3);

    expect(await versionRepository.nextVersionNumber(target.id)).toBe(4);
    expect((await fileState(target.id))?.versionCount).toBe(3);
    expect(await assertCurrentVersionInvariant(target.id)).toBe(third.versionId);

    // Newest first, which is the order the version list renders.
    const history = await versionRepository.listForFile(target.id);
    expect(history.map((entry) => entry.versionNumber)).toEqual([3, 2, 1]);
  });

  it('demotes the previous current version rather than leaving two', async () => {
    const target = await file(await root('root-a'));
    const first = await addVersion(target);
    const second = await addVersion(target);

    expect((await versionRow(first.versionId))?.isCurrent).toBe(false);
    expect((await versionRow(second.versionId))?.isCurrent).toBe(true);
    // The superseded plain draft is relabelled; nothing else about it changes.
    expect((await versionRow(first.versionId))?.label).toBe('superseded');
  });

  it('rejects a manually inserted duplicate (file_id, version_number)', async () => {
    const target = await file(await root('root-a'));
    await addVersion(target);

    const db = await getD1();
    await expect(
      withBatch(db, [
        versionRepository.buildCreateVersionStatement(db, {
          ...versionFields(target),
          id: 'manual-duplicate',
          versionNumber: 1,
        }),
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed/i);

    expect(await versionRow('manual-duplicate')).toBeNull();
    await assertCurrentVersionInvariant(target.id);
  });
});

/* ================================================================== concurrency */

describe('two uploads racing on the same file', () => {
  /**
   * Both attempts are made to read the same `nextVersionNumber` before either writes.
   *
   * Without the barrier this test would pass for the wrong reason: `await` boundaries usually
   * let the first insert land before the second reads, so the retry path would never run and
   * the assertion would prove only that sequential calls number sequentially. Holding both at
   * the read forces the collision the unique index exists for, and therefore forces the retry.
   */
  it('gives them different numbers, and leaves exactly one current', async () => {
    const target = await file(await root('root-a'));

    // The real read, captured before the spy so the wrapper can still reach it.
    const realNextNumber = versionRepository.nextVersionNumber;

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announceBothRead!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      announceBothRead = resolve;
    });

    let arrived = 0;
    const spy = vi
      .spyOn(versionRepository, 'nextVersionNumber')
      .mockImplementation(async (fileId: string) => {
        const value = await realNextNumber(fileId);
        arrived += 1;
        if (arrived === 2) announceBothRead();
        // Only the two first passes wait. A retry must be free to read the settled number,
        // otherwise the loser would deadlock against a barrier nobody will release again.
        if (arrived <= 2) await barrier;
        return value;
      });

    const first = addVersion(target);
    const second = addVersion(target);

    await bothRead;
    release();

    const results = await Promise.all([first, second]);
    spy.mockRestore();

    expect(arrived, 'the retry path ran — a third read means one attempt collided').toBeGreaterThan(
      2,
    );

    const numbers = results.map((result) => result.versionNumber).sort();
    expect(numbers, 'no vN/vN — the unique index refused the loser and the retry re-read').toEqual([
      1, 2,
    ]);

    const history = await versionRepository.listForFile(target.id);
    expect(history, 'both versions exist; neither attempt left an orphan').toHaveLength(2);
    expect((await fileState(target.id))?.versionCount).toBe(2);

    const current = await assertCurrentVersionInvariant(target.id);
    expect(results.map((result) => result.versionId)).toContain(current);
  });
});

/* ================================================================== atomicity */

describe('a version write is all-or-nothing', () => {
  /**
   * The version INSERT fails; the file half must not commit.
   *
   * `uploaded_by` references `users.id`, so a version attributed to a user who does not exist
   * fails at the database inside an otherwise valid batch — the same shape as a real failure,
   * and it exercises D1's rollback rather than a stub of it.
   */
  it('rolls the file half back when the version INSERT fails', async () => {
    const target = await file(await root('root-a'));
    const first = await addVersion(target);
    const before = await fileState(target.id);

    await expect(addVersion(target, { uploadedBy: GHOST_USER })).rejects.toThrow();

    expect(await fileState(target.id)).toEqual(before);
    expect((await versionRow(first.versionId))?.isCurrent, 'v1 is still current').toBe(true);
    expect(await versionRepository.listForFile(target.id)).toHaveLength(1);
    await assertCurrentVersionInvariant(target.id);
  });

  /**
   * The mirror image, and the more important one: the version INSERT is **valid** and would
   * have committed alone. Only the file-side statement fails.
   *
   * `files.current_version_id` has no foreign key, so the poison is applied to a column that
   * does: an extra `files` UPDATE in the same batch pointing `folder_id` at a folder that does
   * not exist. If the batch were not atomic, the new version row would survive it.
   */
  it('rolls the version half back when a FILE statement fails', async () => {
    const db = await getD1();
    const target = await file(await root('root-a'));
    const first = await addVersion(target);
    const before = await fileState(target.id);

    const doomedId = 'version-that-must-not-survive';
    const statements = [
      versionRepository.buildCreateVersionStatement(db, {
        ...versionFields(target),
        id: doomedId,
        versionNumber: 2,
      }),
      ...versionRepository.buildSetCurrentStatements(db, target.id, doomedId),
      ...((await fileRepository.planFileUpdate(db, target.id, {}, {
        currentVersionId: doomedId,
        versionCountDelta: 1,
      })) ?? []),
      // The poison, on the file half: `files.folder_id` references `folders.id`, so naming a
      // folder that does not exist fails this statement and nothing else.
      db
        .update(files)
        .set({ folderId: 'folder-does-not-exist' })
        .where(eq(files.id, target.id)),
    ];

    await expect(withBatch(db, statements)).rejects.toThrow();

    expect(await versionRow(doomedId), 'the version must not survive its file half').toBeNull();
    expect(await fileState(target.id)).toEqual(before);
    expect((await versionRow(first.versionId))?.isCurrent).toBe(true);
    await assertCurrentVersionInvariant(target.id);
  });
});

/* ================================================================== approvals */

describe('approval stays bound to the exact version', () => {
  it('leaves an approved v1 approved when v2 arrives', async () => {
    const target = await file(await root('root-a'));
    const first = await addVersion(target);

    const approvedAt = new Date('2026-02-01T10:00:00.000Z');
    await versionRepository.updateFlags(first.versionId, {
      isApproved: true,
      label: 'approved',
      approvedBy: ALICE,
      approvedAt,
      approvedRevisionId: 'rev-1',
    });
    await fileRepository.updateById(target.id, {
      approvedVersionId: first.versionId,
      approvalStatus: 'approved',
      reviewStatus: 'approved',
    });

    // A new version resets the *file's* approval, exactly as the upload service asks it to.
    await createVersionWithFile({
      version: versionFields(target),
      file: fileFields({
        reviewStatus: 'draft',
        approvalStatus: 'none',
        approvedVersionId: null,
      }),
    });

    const signed = await versionRepository.findById(first.versionId);
    expect(signed?.isApproved, 'the signature survives a later upload').toBe(true);
    expect(signed?.approvedBy).toBe(ALICE);
    expect(signed?.approvedAt?.toISOString()).toBe(approvedAt.toISOString());
    expect(signed?.isCurrent).toBe(false);
    // An approved version that is superseded stays visibly approved in the history.
    expect(signed?.label).toBe('approved');

    const binding = await versionRepository.getApprovalBinding(first.versionId);
    expect(binding?.approvedRevisionId).toBe('rev-1');

    const stored = await fileState(target.id);
    expect(stored?.approvedVersionId, 'the file no longer claims an approval').toBeNull();
    await assertCurrentVersionInvariant(target.id);
  });
});

/* ================================================================== restore */

describe('restoring an old version appends rather than rewinds', () => {
  it('writes v4 from v1 and leaves v1 untouched', async () => {
    const target = await file(await root('root-a'));
    const v1 = await addVersion(target, { checksumSha256: 'c'.repeat(64) });
    await addVersion(target);
    const v3 = await addVersion(target);

    const source = await versionRepository.findById(v1.versionId);

    // What `version.service.restoreVersion` composes, with the storage copy already done.
    const v4 = await createVersionWithFile({
      version: versionFields(target, {
        checksumSha256: source!.checksumSha256,
        originalFilename: source!.originalFilename,
        fileSize: source!.fileSize,
        restoredFromVersionId: source!.id,
        versionNote: `Restored from version ${source!.versionNumber}`,
      }),
      file: fileFields({ checksumSha256: source!.checksumSha256 }),
    });

    expect(v4.versionNumber, 'the next number, not a reused one').toBe(4);

    const restored = await versionRepository.findById(v4.versionId);
    expect(restored?.restoredFromVersionId).toBe(v1.versionId);
    expect(restored?.checksumSha256, 'same bytes, same checksum').toBe('c'.repeat(64));
    expect(restored?.isCurrent).toBe(true);

    const original = await versionRepository.findById(v1.versionId);
    expect(original, 'v1 is untouched').toMatchObject({
      versionNumber: 1,
      checksumSha256: 'c'.repeat(64),
      isCurrent: false,
    });
    expect((await versionRow(v3.versionId))?.isCurrent, 'v3 stops being current').toBe(false);

    expect((await versionRepository.listForFile(target.id)).map((v) => v.versionNumber)).toEqual([
      4, 3, 2, 1,
    ]);
    await assertCurrentVersionInvariant(target.id);
  });
});

/* ================================================================== immutability */

describe('a version cannot be repointed at different bytes', () => {
  it('ignores checksum and storage key handed to updateFlags at runtime', async () => {
    const target = await file(await root('root-a'));
    const created = await addVersion(target, { checksumSha256: 'd'.repeat(64) });
    const before = await versionRow(created.versionId);

    /**
     * `VersionPatch` has no `checksumSha256` and no `storageKey`, so this does not compile
     * without the cast — that is the first line of defence and the reason for the cast.
     *
     * What is asserted here is the second: `versionPatchColumns` maps a fixed list of fields
     * and silently drops anything else, so even a caller that defeats the type cannot write
     * those columns. A future refactor to a spread of the patch object would fail this test.
     */
    await versionRepository.updateFlags(created.versionId, {
      checksumSha256: 'f'.repeat(64),
      storageKey: 'somewhere/else',
      versionNote: 'this part is allowed',
    } as unknown as VersionPatch);

    const after = await versionRow(created.versionId);
    expect(after?.checksumSha256).toBe(before?.checksumSha256);
    expect(after?.storageKey).toBe(before?.storageKey);
    expect(after?.versionNote, 'the legitimate field still applied').toBe('this part is allowed');
  });

  it('lets a genuinely new version carry a different checksum', async () => {
    const target = await file(await root('root-a'));
    const first = await addVersion(target, { checksumSha256: 'd'.repeat(64) });
    const second = await addVersion(target, { checksumSha256: 'e'.repeat(64) });

    expect((await versionRepository.findById(first.versionId))?.checksumSha256).toBe('d'.repeat(64));
    expect((await versionRepository.findById(second.versionId))?.checksumSha256).toBe(
      'e'.repeat(64),
    );
  });
});

/* ================================================================== reads */

describe('the read surface', () => {
  it('resolves a version, its file list, its current version and its storage location', async () => {
    const target = await file(await root('root-a'));
    const created = await addVersion(target, { storedFilename: 'stored-name' });

    const byId = await versionRepository.findById(created.versionId);
    expect(byId).toMatchObject({ fileId: target.id, versionNumber: 1, uploadedBy: ALICE });
    expect(byId?.uploadedAt).toBeInstanceOf(Date);

    expect(await versionRepository.findById('no-such-version')).toBeNull();
    expect(await versionRepository.listForFile('no-such-file')).toEqual([]);

    const current = await versionRepository.findCurrent(target.id);
    expect(current?.id).toBe(created.versionId);

    const location = await versionRepository.getStorageLocation(created.versionId);
    expect(location).toMatchObject({
      provider: 'local',
      area: 'originals',
      mimeType: 'text/csv',
      size: 10,
      isGoogleNative: false,
      localCopyState: 'present',
    });
    expect(location?.key).toContain('stored-name');

    // The employee-facing record must not carry the key.
    expect(byId as unknown as Record<string, unknown>).not.toHaveProperty('storageKey');
  });

  it('returns storage locations for several files at once', async () => {
    const folder = await root('root-a');
    const one = await file(folder, 'one.csv');
    const two = await file(folder, 'two.csv');
    await addVersion(one);
    await addVersion(two);
    await addVersion(two);

    const locations = await versionRepository.getStorageLocationsForFiles([one.id, two.id]);
    expect(locations).toHaveLength(3);
    expect(await versionRepository.getStorageLocationsForFiles([])).toEqual([]);
  });

  it('counts stored objects, conflicts, live approvals and superseded ones', async () => {
    const target = await file(await root('root-a'));
    const a = await addVersion(target);
    const b = await addVersion(target);

    expect(await versionRepository.countStoredObjects()).toBe(2);
    expect(await versionRepository.countSyncConflicts()).toBe(0);

    await versionRepository.markStorageConflict(a.versionId, 'checksum disagreed with Drive');
    expect(await versionRepository.countSyncConflicts()).toBe(1);
    // Marking never removes the row — the evidence has to survive.
    expect(await versionRepository.findById(a.versionId)).not.toBeNull();

    await versionRepository.updateFlags(b.versionId, {
      isApproved: true,
      approvalSupersededAt: new Date(),
      approvalSupersededReason: 'content changed',
    });
    expect(await versionRepository.countSupersededApprovals()).toBe(1);
  });

  /**
   * `create` and `newId` are the two contract methods the unit-of-work does not go through.
   *
   * `createVersionWithFile` composes `buildCreateVersionStatement` directly, so nothing else in
   * this suite executes `create` — and it is still on the interface, still reachable, and still
   * the path a caller takes when it genuinely wants a version row and nothing else. Left
   * unexercised it could rot without a single test noticing.
   *
   * Note what it does *not* do: the file it belongs to is untouched. That is correct for this
   * method and is exactly why an upload must not use it.
   */
  it('writes a lone version row through create(), at an id minted in advance', async () => {
    const target = await file(await root('root-a'));
    await addVersion(target);
    const before = await fileState(target.id);

    const minted = versionRepository.newId();
    expect(minted).not.toBe(versionRepository.newId());

    const created = await versionRepository.create({
      ...versionFields(target),
      id: minted,
      versionNumber: 2,
      versionNote: 'written directly',
    });

    expect(created).toMatchObject({
      id: minted,
      fileId: target.id,
      versionNumber: 2,
      versionNote: 'written directly',
      uploadedBy: ALICE,
      // Every newly written version claims currency; demoting the rest is `setCurrent`'s job.
      isCurrent: true,
      isApproved: false,
      label: 'draft',
    });
    expect(created.createdAt).toBeInstanceOf(Date);

    expect(await versionRepository.findById(minted)).toMatchObject({ id: minted });
    // The file half is untouched, which is the whole reason `create` is not an upload.
    expect(await fileState(target.id)).toEqual(before);
  });

  it('pages stored objects by id', async () => {
    const target = await file(await root('root-a'));
    await addVersion(target);
    await addVersion(target);
    await addVersion(target);

    const firstPage = await versionRepository.listStoredObjects({ limit: 2 });
    expect(firstPage).toHaveLength(2);
    expect(firstPage[0]!.checksumSha256).toBe('b'.repeat(64));

    const secondPage = await versionRepository.listStoredObjects({
      limit: 2,
      afterId: firstPage[1]!.versionId,
    });
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]!.versionId).not.toBe(firstPage[0]!.versionId);
  });
});

/* ================================================================== Drive ids */

describe('Drive ids belong to versions', () => {
  const driveFields = (driveId: string) => ({
    storageProvider: 'google_drive' as const,
    googleDriveFileId: driveId,
    googleDriveParentId: 'parent-1',
    googleDriveRevisionId: 'rev-1',
    googleDriveMd5: 'md5-1',
  });

  it('resolves a Drive id back to its version and file', async () => {
    const target = await file(await root('root-a'));
    const created = await addVersion(target, driveFields('drive-abc'));

    const found = await versionRepository.findByDriveFileId('drive-abc');
    expect(found).toMatchObject({
      versionId: created.versionId,
      fileId: target.id,
      versionNumber: 1,
      isCurrent: true,
      storageProvider: 'google_drive',
      googleDriveParentId: 'parent-1',
      googleDriveRevisionId: 'rev-1',
    });

    expect(await versionRepository.findByDriveFileId('drive-unknown')).toBeNull();
    expect(await versionRepository.findByDriveFileId('')).toBeNull();
  });

  it('refuses to insert a second version claiming the same Drive object', async () => {
    const folder = await root('root-a');
    const one = await file(folder, 'one.csv');
    const two = await file(folder, 'two.csv');
    await addVersion(one, driveFields('drive-shared'));

    await expect(addVersion(two, driveFields('drive-shared'))).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
    // The refused attempt left nothing behind on the second file.
    expect(await versionRepository.listForFile(two.id)).toEqual([]);
  });

  /**
   * The unique index makes a duplicate impossible to *insert*, but rows imported from MongoDB
   * were never constrained. Dropping the index reproduces exactly that pre-migration corruption
   * and proves the lookup refuses rather than picking one of the two.
   */
  it('fails loudly when pre-migration data holds two versions for one Drive id', async () => {
    const folder = await root('root-a');
    const one = await file(folder, 'one.csv');
    const two = await file(folder, 'two.csv');

    await d1.prepare('DROP INDEX ux_file_versions_drive_id').run();
    try {
      await addVersion(one, driveFields('drive-ambiguous'));
      await addVersion(two, driveFields('drive-ambiguous'));

      await expect(versionRepository.findByDriveFileId('drive-ambiguous')).rejects.toThrow(
        /more than one version/i,
      );
    } finally {
      // The duplicates have to go before the index can come back — recreating a unique index
      // over rows that violate it fails, which is the whole reason the corruption is only
      // reachable from an import in the first place.
      await d1.prepare("DELETE FROM file_versions WHERE google_drive_file_id = 'drive-ambiguous'").run();
      await d1
        .prepare(
          'CREATE UNIQUE INDEX ux_file_versions_drive_id ON file_versions (google_drive_file_id) WHERE google_drive_file_id IS NOT NULL',
        )
        .run();
    }
  });

  it('lists Drive-backed versions in id order, and only those', async () => {
    const folder = await root('root-a');
    const remote = await file(folder, 'remote.csv');
    const local = await file(folder, 'local.csv');
    await addVersion(remote, driveFields('drive-1'));
    await addVersion(local);

    const listed = await versionRepository.listDriveBackedVersions({ limit: 50 });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ fileId: remote.id, googleDriveFileId: 'drive-1' });
  });

  /**
   * A trashed file's version stays resolvable, and that is deliberate.
   *
   * `drive-sync.service.ts` reaches for `findByIdInternal(..., { includeDeleted: true })`
   * immediately after this lookup, with the comment "a Drive change names a version, and the
   * owning file may be trashed here without the change ceasing to be ours". If the lookup
   * filtered trashed files the feed would count those events as `unmanaged` and a removal from
   * Drive would never be recorded against the file it belongs to.
   *
   * The Mongo implementation queries `FileVersionModel` on `googleDriveFileId` alone, with no
   * join to `files` and no status predicate. This is that same behaviour, asserted rather than
   * inherited by accident.
   */
  it('still resolves a version whose file has been trashed, as the sync feed requires', async () => {
    const target = await file(await root('root-a'));
    const created = await addVersion(target, driveFields('drive-trashed'));

    await d1
      .prepare("UPDATE files SET status = 'trashed', deleted_at = ? WHERE id = ?")
      .bind(ISO, target.id)
      .run();

    expect(await versionRepository.findByDriveFileId('drive-trashed')).toMatchObject({
      versionId: created.versionId,
      fileId: target.id,
    });
    // And the reconcile sweep still has it on its work list, for the same reason.
    expect(
      (await versionRepository.listDriveBackedVersions({ limit: 50 })).map((e) => e.versionId),
    ).toEqual([created.versionId]);
    // The version's own reads are unaffected — trashing a file is not deleting its history.
    expect(await versionRepository.listForFile(target.id)).toHaveLength(1);
    expect((await versionRepository.findCurrent(target.id))?.id).toBe(created.versionId);
  });

  /**
   * The lookup takes no organization, and must not grow one.
   *
   * Every caller is the Drive change feed, which runs as no user across the whole Shared Drive
   * and learns which organization an event belongs to *from* the version it resolves. Scoping
   * the lookup by organization would require the caller to already know the answer.
   *
   * That is safe precisely because a Drive id is globally unique and the index enforces it —
   * the ambiguity test above is what stands behind this one.
   */
  it('resolves across organizations, because the change feed has none', async () => {
    const mine = await file(await root('root-a'), 'mine.csv');
    const theirs = await file(await root('root-b', ORG_B), 'theirs.csv');

    await addVersion(mine, driveFields('drive-org-a'));
    await addVersion(theirs, driveFields('drive-org-b'));

    expect(await versionRepository.findByDriveFileId('drive-org-b')).toMatchObject({
      fileId: theirs.id,
    });
    expect(await versionRepository.findByDriveFileId('drive-org-a')).toMatchObject({
      fileId: mine.id,
    });
  });

  it('lists live remote approvals and skips ones already known stale', async () => {
    const folder = await root('root-a');
    const live = await file(folder, 'live.csv');
    const stale = await file(folder, 'stale.csv');
    const liveVersion = await addVersion(live, driveFields('drive-live'));
    const staleVersion = await addVersion(stale, driveFields('drive-stale'));

    await versionRepository.updateFlags(liveVersion.versionId, { isApproved: true });
    await versionRepository.updateFlags(staleVersion.versionId, {
      isApproved: true,
      approvalSupersededAt: new Date(),
    });

    const work = await versionRepository.listLiveRemoteApprovals({ limit: 50 });
    expect(work.map((entry) => entry.versionId)).toEqual([liveVersion.versionId]);
    expect(await versionRepository.countLiveRemoteApprovals()).toBe(1);
  });
});

/* ================================================================== setCurrent */

describe('setCurrent on its own', () => {
  it('moves the flag without touching the file pointer', async () => {
    const target = await file(await root('root-a'));
    const first = await addVersion(target);
    const second = await addVersion(target);

    await versionRepository.setCurrent(target.id, first.versionId);

    expect((await versionRow(first.versionId))?.isCurrent).toBe(true);
    expect((await versionRow(second.versionId))?.isCurrent).toBe(false);

    /**
     * And the file still points at v2 — which is precisely why `setCurrent` is not the
     * operation an upload should use. On its own it moves one of the two representations of
     * "current" and leaves the other, producing the disagreement `createVersionWithFile`
     * exists to prevent. Pinned so that nobody reaches for it as a shortcut.
     */
    expect((await fileState(target.id))?.currentVersionId).toBe(second.versionId);
  });
});

/* ================================================================== purge */

describe('purge removes version metadata and nothing else', () => {
  it('deletes the versions of the named files, reporting real counts', async () => {
    const folder = await root('root-a');
    const doomed = await file(folder, 'doomed.csv');
    const kept = await file(folder, 'kept.csv');
    await addVersion(doomed);
    await addVersion(doomed);
    await addVersion(kept);

    // The storage layer reads the locations first; the repository never deletes bytes.
    const locations = await versionRepository.getStorageLocationsForFiles([doomed.id]);
    expect(locations).toHaveLength(2);

    expect(await versionRepository.purgeForFiles([doomed.id])).toBe(2);
    expect(await versionRepository.listForFile(doomed.id)).toEqual([]);
    expect(await versionRepository.listForFile(kept.id)).toHaveLength(1);

    expect(await versionRepository.purgeForFiles([doomed.id]), 'idempotent').toBe(0);
    expect(await versionRepository.purgeForFiles([])).toBe(0);
  });

  /**
   * A restored version points at the version it was copied from, and both are purged together.
   *
   * `file_versions.restored_from_version_id` references `file_versions.id` with `ON DELETE no
   * action`, so this is the one side-reference that is *live on D1 today* — the others
   * (`approvals`, `comments`, `reviews`, `upload_sessions`) belong to modules still on MongoDB.
   * SQLite checks foreign keys per row, so a delete that removed v1 while v4 still referenced it
   * would be refused. That it is not tells us the whole set goes in one statement.
   */
  it('purges a restore chain whole, rather than tripping on its own reference', async () => {
    const target = await file(await root('root-a'), 'chained.csv');
    const v1 = await addVersion(target);
    await addVersion(target);
    await addVersion(target, { restoredFromVersionId: v1.versionId });

    expect(await versionRepository.purgeForFiles([target.id])).toBe(3);
    expect(await versionRepository.listForFile(target.id)).toEqual([]);

    const dangling = await d1
      .prepare(
        `SELECT count(*) AS n FROM file_versions v
         WHERE v.restored_from_version_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM file_versions p WHERE p.id = v.restored_from_version_id)`,
      )
      .first<{ n: number }>();
    expect(dangling?.n, 'no version points at a purged ancestor').toBe(0);
  });

  /**
   * The reference is enforced, not merely declared.
   *
   * Proven by purging one file while a *different* file's version still names one of its rows —
   * a state the product cannot reach, since restore is always same-file, but the only way to
   * show the constraint is real rather than decorative. The refusal is the guarantee that a
   * purge can never leave a dangling pointer behind on this table.
   */
  it('refuses to purge a version another row still references', async () => {
    const folder = await root('root-a');
    const source = await file(folder, 'source.csv');
    const borrower = await file(folder, 'borrower.csv');

    const origin = await addVersion(source);
    await addVersion(borrower, { restoredFromVersionId: origin.versionId });

    /**
     * Asserted through the cause chain, not the message.
     *
     * Drizzle reports `Failed query: delete from "file_versions" …` and hangs the driver's own
     * `FOREIGN KEY constraint failed` off `cause`. Matching only the top-level message would
     * pass for *any* failed delete — a syntax error would satisfy it — so the reason has to be
     * read out of the chain for this test to be about the constraint at all.
     */
    const refusal = await versionRepository
      .purgeForFiles([source.id])
      .then(() => null, (error: unknown) => error);

    expect(refusal, 'the purge must be refused').not.toBeNull();
    expect(causeChain(refusal)).toMatch(/FOREIGN KEY constraint failed/i);
    // Refused, not half-done: the version it would have removed is still there.
    expect(await versionRepository.listForFile(source.id)).toHaveLength(1);
  });

  it('leaves no version behind pointing at a purged file', async () => {
    const folder = await root('root-a');
    const target = await file(folder, 'doomed.csv');
    await addVersion(target);

    await versionRepository.purgeForFiles([target.id]);
    const problems = await validateVersionGraph(ORG);
    expect(problems.filter((problem) => problem.kind === 'missing_parent_file')).toEqual([]);
  });
});

/* ================================================================== providers */

describe('version writes never span two databases', () => {
  it('selects D1 when files and versions are both on D1', () => {
    setDataSourceOverride('files', 'd1');
    setDataSourceOverride('fileVersions', 'd1');
    expect(versionMutationEngine()).toBe('d1');
  });

  it('selects Mongo when both are on Mongo', () => {
    setDataSourceOverride('files', 'mongo');
    setDataSourceOverride('fileVersions', 'mongo');
    expect(versionMutationEngine()).toBe('mongo');
  });

  it('refuses when files are on D1 and versions are not', () => {
    setDataSourceOverride('files', 'd1');
    setDataSourceOverride('fileVersions', 'mongo');
    expect(() => versionMutationEngine()).toThrow(SplitDataSourceVersionError);
  });

  it('refuses when versions are on D1 and files are not', () => {
    setDataSourceOverride('files', 'mongo');
    setDataSourceOverride('fileVersions', 'd1');
    expect(() => versionMutationEngine()).toThrow(SplitDataSourceVersionError);
  });

  it('names both flags in the refusal, and refuses before writing anything', async () => {
    const target = await file(await root('root-a'));
    const before = await fileState(target.id);

    setDataSourceOverride('files', 'd1');
    setDataSourceOverride('fileVersions', 'mongo');

    try {
      versionMutationEngine();
      throw new Error('should have refused');
    } catch (error) {
      const refusal = error as SplitDataSourceVersionError;
      expect(refusal).toBeInstanceOf(SplitDataSourceVersionError);
      expect(refusal.status).toBe(409);
      expect(JSON.stringify(refusal.details)).toContain('DATA_SOURCE_FILE_VERSIONS=mongo');
      expect(JSON.stringify(refusal.details)).toContain('DATA_SOURCE_FILES=d1');
    }

    clearDataSourceOverrides();
    expect(await fileState(target.id)).toEqual(before);
    expect(await versionRepository.listForFile(target.id)).toEqual([]);
  });
});

/* ================================================================== validator */

describe('the migration validator reports and never repairs', () => {
  it('finds nothing wrong with a healthy graph', async () => {
    const target = await file(await root('root-a'));
    await addVersion(target);
    await addVersion(target);

    expect(await validateVersionGraph(ORG)).toEqual([]);
  });

  /**
   * Every check is fed the corruption it exists for.
   *
   * The constraints have to be dropped to create most of these, which is the point: this is
   * what MongoDB's data looks like arriving at a database that enforces them, and the validator
   * is how that is discovered before a migration window rather than during one.
   */
  it('reports duplicates, orphans, cross-file pointers, gaps and mismatches', async () => {
    const folder = await root('root-a');
    const target = await file(folder, 'one.csv');
    const other = await file(folder, 'two.csv');
    const first = await addVersion(target);
    const otherVersion = await addVersion(other);

    await d1.prepare('DROP INDEX ux_file_versions_number').run();
    try {
      // Duplicate (file_id, version_number), and a second row marked current on the same file.
      await d1
        .prepare(
          `INSERT INTO file_versions (id,organization_id,file_id,version_number,storage_key,storage_area,
             original_filename,file_size,mime_type,extension,checksum_sha256,uploaded_by,uploaded_at,
             version_note,processing_status,label,is_current,is_approved,preview_status,storage_provider,
             migration_status,sync_status,local_copy_state,is_google_native,created_at,updated_at)
           VALUES ('dup-1',?,?,1,'k/dup-1','originals','one.csv',10,'text/csv','csv',?,?,?,'','ready','draft',1,0,'none','local','not_started','not_required','present',0,?,?)`,
        )
        .bind(ORG, target.id, 'b'.repeat(64), ALICE, ISO, ISO, ISO)
        .run();

      // A gap: `other` jumps from v1 to v5.
      await d1
        .prepare(
          `INSERT INTO file_versions (id,organization_id,file_id,version_number,storage_key,storage_area,
             original_filename,file_size,mime_type,extension,checksum_sha256,uploaded_by,uploaded_at,
             version_note,processing_status,label,is_current,is_approved,preview_status,storage_provider,
             migration_status,sync_status,local_copy_state,is_google_native,created_at,updated_at)
           VALUES ('gap-1',?,?,5,'k/gap-1','originals','two.csv',10,'text/csv','csv',?,?,?,'','ready','draft',0,0,'none','local','not_started','not_required','present',0,?,?)`,
        )
        .bind(ORG, other.id, 'b'.repeat(64), ALICE, ISO, ISO, ISO)
        .run();

      // A version with no checksum at all.
      await d1
        .prepare("UPDATE file_versions SET checksum_sha256 = '' WHERE id = ?")
        .bind(first.versionId)
        .run();

      // The file points at a version belonging to a different file.
      await d1
        .prepare('UPDATE files SET current_version_id = ?, approved_version_id = ? WHERE id = ?')
        .bind(otherVersion.versionId, otherVersion.versionId, target.id)
        .run();

      const problems = await validateVersionGraph();
      const kinds = new Set(problems.map((problem) => problem.kind));

      expect(kinds).toContain('duplicate_version_number');
      expect(kinds).toContain('missing_checksum');
      expect(kinds).toContain('current_version_of_other_file');
      expect(kinds).toContain('approved_version_of_other_file');
      expect(kinds).toContain('version_number_gap');
      expect(kinds).toContain('multiple_current_versions');

      // Read-only: the corruption is still exactly as it was left, and a second run says the
      // same thing rather than a shorter list.
      const after = await d1
        .prepare('SELECT count(*) AS n FROM file_versions')
        .first<{ n: number }>();
      expect(after?.n).toBe(4);
      const reread = await validateVersionGraph();
      expect(reread.length, 'a second run reports the same problems').toBe(problems.length);
    } finally {
      await d1.prepare("DELETE FROM file_versions WHERE id IN ('dup-1','gap-1')").run();
      await d1
        .prepare(
          'CREATE UNIQUE INDEX ux_file_versions_number ON file_versions (file_id, version_number)',
        )
        .run();
    }
  });

  /**
   * The orphan check cannot be provoked on D1, and that is the finding.
   *
   * `file_versions.file_id` references `files.id`, so a version whose file is missing is not
   * insertable and its parent is not deletable while it exists — both attempts below are
   * refused by the database. MongoDB enforced neither, which is exactly why
   * `missing_parent_file` is in the validator: it is aimed at a *copy of the Mongo corpus*
   * loaded before the constraints are in force, not at a healthy D1.
   *
   * Asserting the refusal rather than faking the corruption keeps this honest — the check is
   * covered by reading its SQL, and what is proven here is that live D1 cannot reach the state.
   */
  it('cannot even construct an orphaned version on D1, because the foreign key refuses', async () => {
    const target = await file(await root('root-a'));
    await addVersion(target);

    await expect(
      d1
        .prepare(
          `INSERT INTO file_versions (id,organization_id,file_id,version_number,storage_key,storage_area,
             original_filename,file_size,mime_type,extension,checksum_sha256,uploaded_by,uploaded_at,
             version_note,processing_status,label,is_current,is_approved,preview_status,storage_provider,
             migration_status,sync_status,local_copy_state,is_google_native,created_at,updated_at)
           VALUES ('orphan-1',?,'file-that-vanished',9,'k/orphan','originals','x.csv',10,'text/csv','csv',?,?,?,'','ready','draft',0,0,'none','local','not_started','not_required','present',0,?,?)`,
        )
        .bind(ORG, 'b'.repeat(64), ALICE, ISO, ISO, ISO)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);

    await expect(
      d1.prepare('DELETE FROM files WHERE id = ?').bind(target.id).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);

    expect(await validateVersionGraph(ORG)).toEqual([]);
  });

  /**
   * The remaining four checks, each fed the corruption it exists for.
   *
   * `duplicate_drive_id` needs the partial unique index dropped, for the same reason as the
   * ambiguity test above: the index makes it uninsertable, and the validator's whole job is to
   * find the rows that arrive from a database which had no such index.
   *
   * The two dangling-pointer checks need no index dropped at all — `files.current_version_id`
   * and `files.approved_version_id` carry **no foreign key**, precisely because a version of
   * *another* file would satisfy one. That is why they are validator checks rather than
   * constraints, and why a pointer at a version that was never written is reachable here.
   */
  it('reports duplicate Drive ids, dangling pointers and a file with no current version', async () => {
    const folder = await root('root-a');
    const one = await file(folder, 'one.csv');
    const two = await file(folder, 'two.csv');
    const orphaned = await file(folder, 'orphaned.csv');
    await addVersion(orphaned);

    await d1.prepare('DROP INDEX ux_file_versions_drive_id').run();
    try {
      await addVersion(one, {
        storageProvider: 'google_drive',
        googleDriveFileId: 'drive-claimed-twice',
      });
      await addVersion(two, {
        storageProvider: 'google_drive',
        googleDriveFileId: 'drive-claimed-twice',
      });

      // No foreign key stands in the way of either of these.
      await d1
        .prepare(
          "UPDATE files SET current_version_id = 'version-never-written', approved_version_id = 'approval-never-written' WHERE id = ?",
        )
        .bind(orphaned.id)
        .run();
      // And a file whose versions all forgot they were current.
      await d1
        .prepare('UPDATE file_versions SET is_current = 0 WHERE file_id = ?')
        .bind(one.id)
        .run();

      const kinds = new Set((await validateVersionGraph()).map((problem) => problem.kind));
      expect(kinds).toContain('duplicate_drive_id');
      expect(kinds).toContain('dangling_current_version');
      expect(kinds).toContain('dangling_approved_version');
      expect(kinds).toContain('no_current_version');
    } finally {
      await d1
        .prepare("DELETE FROM file_versions WHERE google_drive_file_id = 'drive-claimed-twice'")
        .run();
      await d1
        .prepare(
          'CREATE UNIQUE INDEX ux_file_versions_drive_id ON file_versions (google_drive_file_id) WHERE google_drive_file_id IS NOT NULL',
        )
        .run();
    }
  });

  it('reports a version filed under a different organization from its file', async () => {
    const target = await file(await root('root-a'));
    const created = await addVersion(target);

    await d1
      .prepare('UPDATE file_versions SET organization_id = ? WHERE id = ?')
      .bind(ORG_B, created.versionId)
      .run();

    const problems = await validateVersionGraph();
    expect(problems.map((problem) => problem.kind)).toContain('organization_mismatch');
  });
});
