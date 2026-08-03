/**
 * Folder and drive behaviour that a permission matrix on paper does not prove.
 *
 * The cases here are the ones that corrupt data or leak it if they are wrong:
 * circular moves, subtree consistency after a move, cross-department isolation,
 * personal-drive privacy, and trash/restore fidelity.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';

let db: TestDb;
let fixture: Fixture;

function skipUnlessDb(): boolean {
  if (db.available) return false;
  expect(db.reason, 'in-memory MongoDB unavailable').toBeTruthy();
  return true;
}

beforeAll(async () => {
  db = await startTestDb();
  if (db.available) fixture = await seedFixture();
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

async function services() {
  return {
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    folderRepository: await import('@/server/repositories/folder.repository'),
  };
}

describe('personal drives', () => {
  it('creates one root per employee and reuses it', async () => {
    if (skipUnlessDb()) return;
    const { driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const first = await driveService.getMyDriveRoot(alice);
    const second = await driveService.getMyDriveRoot(alice);

    expect(first.id).toBe(second.id);
    expect(first.driveType).toBe('my');
    expect(first.isSystem).toBe(true);
    // No department: this is what keeps department-scoped roles out of a personal drive.
    expect(first.departmentId).toBeNull();
  });

  it('keeps one employee out of another employee’s personal drive', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const head = await actorFor(fixture.users.deptAHead);

    const root = await driveService.getMyDriveRoot(alice);
    const personal = await folderService.createFolder(
      alice,
      { name: 'Alice private notes', parentFolderId: root.id },
      TEST_META,
    );

    // The department head manages Alice's department but not her personal drive.
    await expect(folderService.getFolder(head, personal.id)).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });

  it('lets the owner create folders in their own drive without a matching role scope', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService } = await services();
    const newcomer = await actorFor(fixture.users.noRole);

    const root = await driveService.getMyDriveRoot(newcomer);
    const folder = await folderService.createFolder(
      newcomer,
      { name: 'First folder', parentFolderId: root.id },
      TEST_META,
    );

    expect(folder.name).toBe('First folder');
    expect(folder.ownerId).toBe(newcomer.userId);
  });
});

describe('department drives', () => {
  it('refuses a department drive to an employee from another department', async () => {
    if (skipUnlessDb()) return;
    const { driveService } = await services();
    const bob = await actorFor(fixture.users.scientistB); // ANCHEM

    await expect(
      driveService.getDepartmentRoot(bob, fixture.departments.molbio),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('hides another department’s folders from the child listing', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const molbioRoot = await driveService.getDepartmentRoot(alice, fixture.departments.molbio);
    await folderService.createFolder(
      alice,
      { name: 'Confidential assay data', parentFolderId: molbioRoot.id, confidentiality: 'confidential' },
      TEST_META,
    );

    // Bob cannot even open the parent, which is the point: he never reaches the listing.
    await expect(folderService.listChildFolders(bob, molbioRoot.id, {
      page: 1,
      pageSize: 25,
      sort: 'name',
      order: 'asc',
    })).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/) });
  });
});

describe('folder structure', () => {
  it('refuses two folders with the same name in one parent', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const root = await driveService.getMyDriveRoot(alice);

    const parent = await folderService.createFolder(
      alice,
      { name: 'Duplicates test', parentFolderId: root.id },
      TEST_META,
    );
    await folderService.createFolder(alice, { name: 'Protocols', parentFolderId: parent.id }, TEST_META);

    // Case-insensitive: "protocols" and "Protocols" are the same folder to a human.
    await expect(
      folderService.createFolder(alice, { name: 'protocols', parentFolderId: parent.id }, TEST_META),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses to rename or delete a drive root', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const root = await driveService.getMyDriveRoot(alice);

    await expect(folderService.renameFolder(alice, root.id, 'Not my drive', TEST_META)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(folderService.trashFolder(alice, root.id, TEST_META)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('moving folders', () => {
  it('refuses to move a folder into itself or into its own descendant', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const root = await driveService.getMyDriveRoot(alice);

    const outer = await folderService.createFolder(alice, { name: 'Cycle outer', parentFolderId: root.id }, TEST_META);
    const middle = await folderService.createFolder(alice, { name: 'Cycle middle', parentFolderId: outer.id }, TEST_META);
    const inner = await folderService.createFolder(alice, { name: 'Cycle inner', parentFolderId: middle.id }, TEST_META);

    await expect(folderService.moveFolder(alice, outer.id, outer.id, TEST_META)).rejects.toMatchObject({
      code: 'CIRCULAR_MOVE',
    });
    await expect(folderService.moveFolder(alice, outer.id, inner.id, TEST_META)).rejects.toMatchObject({
      code: 'CIRCULAR_MOVE',
    });
  });

  it('rewrites the ancestor path of every descendant when a folder moves', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService, folderRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const root = await driveService.getMyDriveRoot(alice);

    const source = await folderService.createFolder(alice, { name: 'Move source', parentFolderId: root.id }, TEST_META);
    const child = await folderService.createFolder(alice, { name: 'Move child', parentFolderId: source.id }, TEST_META);
    const grandchild = await folderService.createFolder(
      alice,
      { name: 'Move grandchild', parentFolderId: child.id },
      TEST_META,
    );
    const destination = await folderService.createFolder(
      alice,
      { name: 'Move destination', parentFolderId: root.id },
      TEST_META,
    );

    await folderService.moveFolder(alice, source.id, destination.id, TEST_META);

    const movedGrandchild = await folderRepository.findById(grandchild.id);
    expect(movedGrandchild).not.toBeNull();
    // root → destination → source → child, in that order.
    expect(movedGrandchild!.pathAncestors).toEqual([root.id, destination.id, source.id, child.id]);
    expect(movedGrandchild!.depth).toBe(4);

    // And the breadcrumb the user sees agrees with the stored path.
    const trail = await folderService.getBreadcrumbs(alice, grandchild.id);
    expect(trail.map((entry) => entry.name)).toEqual([
      'My Drive',
      'Move destination',
      'Move source',
      'Move child',
      'Move grandchild',
    ]);
  });
});

describe('trash and restore', () => {
  it('trashes the whole subtree and restores exactly what it swept in', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService, folderRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const root = await driveService.getMyDriveRoot(alice);

    const parent = await folderService.createFolder(alice, { name: 'Trash parent', parentFolderId: root.id }, TEST_META);
    const child = await folderService.createFolder(alice, { name: 'Trash child', parentFolderId: parent.id }, TEST_META);

    const { affected } = await folderService.trashFolder(alice, parent.id, TEST_META);
    expect(affected).toBe(2);

    // Gone from normal reads…
    expect(await folderRepository.findById(child.id)).toBeNull();
    // …but still there, flagged.
    const trashedChild = await folderRepository.findById(child.id, { includeDeleted: true });
    expect(trashedChild?.deletedAt).toBeTruthy();
    expect(trashedChild?.trashedWithFolderId).toBe(parent.id);

    await folderService.restoreFolder(alice, parent.id, TEST_META);
    expect(await folderRepository.findById(child.id)).not.toBeNull();
  });

  it('lists only what the user deleted themselves, not the subtree that followed', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const root = await driveService.getMyDriveRoot(alice);

    const parent = await folderService.createFolder(alice, { name: 'Trash list parent', parentFolderId: root.id }, TEST_META);
    await folderService.createFolder(alice, { name: 'Trash list child', parentFolderId: parent.id }, TEST_META);
    await folderService.trashFolder(alice, parent.id, TEST_META);

    const trash = await folderService.listTrash(alice, { page: 1, pageSize: 50 });
    const names = trash.items.map((item) => item.name);
    expect(names).toContain('Trash list parent');
    expect(names).not.toContain('Trash list child');
  });

  it('refuses to restore a folder whose parent is still in the trash', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const root = await driveService.getMyDriveRoot(alice);

    const parent = await folderService.createFolder(alice, { name: 'Orphan parent', parentFolderId: root.id }, TEST_META);
    const child = await folderService.createFolder(alice, { name: 'Orphan child', parentFolderId: parent.id }, TEST_META);
    await folderService.trashFolder(alice, parent.id, TEST_META);

    await expect(folderService.restoreFolder(alice, child.id, TEST_META)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('copying folders', () => {
  it('copies the subtree without carrying the original’s sharing', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService, folderRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const root = await driveService.getMyDriveRoot(alice);

    const source = await folderService.createFolder(alice, { name: 'Copy source', parentFolderId: root.id }, TEST_META);
    await folderService.createFolder(alice, { name: 'Copy inner', parentFolderId: source.id }, TEST_META);

    // Share the original with the whole ANCHEM department.
    await folderRepository.updateById(source.id, {
      $set: {
        permissions: [
          {
            principalType: 'department',
            principalId: fixture.departments.anchem,
            accessLevel: 'viewer',
            deny: false,
          },
        ],
      },
    });

    const destination = await folderService.createFolder(
      alice,
      { name: 'Copy destination', parentFolderId: root.id },
      TEST_META,
    );
    const copy = await folderService.copyFolder(alice, source.id, destination.id, TEST_META);

    expect(copy.permissions).toEqual([]);

    const descendants = await folderRepository.listDescendants(copy.id);
    expect(descendants.map((folder) => folder.name)).toEqual(['Copy inner']);
  });

  it('renames a copy that would collide with an existing folder', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const root = await driveService.getMyDriveRoot(alice);

    const parent = await folderService.createFolder(alice, { name: 'Collision parent', parentFolderId: root.id }, TEST_META);
    const source = await folderService.createFolder(alice, { name: 'Assays', parentFolderId: parent.id }, TEST_META);

    const copy = await folderService.copyFolder(alice, source.id, parent.id, TEST_META);
    expect(copy.name).toBe('Assays (2)');
  });
});

describe('starred items', () => {
  it('keeps stars private to the person who set them', async () => {
    if (skipUnlessDb()) return;
    const { folderService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const admin = await actorFor(fixture.users.companyAdmin);

    const root = await driveService.getMyDriveRoot(alice);
    const folder = await folderService.createFolder(alice, { name: 'Star target', parentFolderId: root.id }, TEST_META);
    await folderService.setStarred(alice, folder.id, true);

    const aliceStars = await folderService.listStarred(alice);
    expect(aliceStars.map((item) => item.id)).toContain(folder.id);

    const adminStars = await folderService.listStarred(admin);
    expect(adminStars.map((item) => item.id)).not.toContain(folder.id);
  });
});
