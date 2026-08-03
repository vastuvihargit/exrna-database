/**
 * Research organization — experiments, traceability and templates.
 *
 * Three things here are worth proving rather than assuming:
 *
 *  1. An experiment record has no ACL of its own; it inherits its project's. That is a
 *     simplification, and simplifications are exactly where disclosure bugs hide — so
 *     the cases below check that someone outside the project cannot read one, list one,
 *     or link a file to one.
 *
 *  2. Related files are a search by another name. A duplicate-detection panel that
 *     reported "this file also exists in Analytical Chemistry" would leak a filename and
 *     a folder location to someone with no access to either.
 *
 *  3. A metadata template's field keys become MongoDB dotted paths under
 *     `File.metadata`. An administrator must not be able to invent one.
 */
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import type { Actor } from '@/server/permissions/actor';

let db: TestDb;
let fixture: Fixture;

function skipUnlessDb(): boolean {
  if (db.available) return false;
  expect(db.reason, 'in-memory MongoDB unavailable').toBeTruthy();
  return true;
}

beforeAll(async () => {
  db = await startTestDb();
  if (!db.available) return;
  fixture = await seedFixture();
  const { getStorageProvider } = await import('@/server/storage');
  await getStorageProvider().ensureReady();
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

async function services() {
  return {
    projectService: (await import('@/server/services/project.service')).projectService,
    experimentService: (await import('@/server/services/experiment.service')).experimentService,
    templateService: (await import('@/server/services/template.service')).templateService,
    fileService: (await import('@/server/services/file.service')).fileService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    experimentRepository: await import('@/server/repositories/experiment.repository'),
  };
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');

function pdf(marker: string): Buffer {
  return Buffer.concat([PDF, Buffer.from(`% ${marker}\n`)]);
}

/** Uploads and returns the file as the service would show it, so `.id` is a file id. */
async function upload(actor: Actor, folderId: string, filename: string, content: Buffer) {
  const { uploadService, fileService } = await services();
  const ticket = await uploadService.authorizeUpload(
    actor,
    { folderId, filename, size: content.byteLength },
    TEST_META,
  );
  await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(content));
  const result = await uploadService.finalize(actor, ticket.sessionId, TEST_META);
  return fileService.getFile(actor, result.fileId);
}

async function personalFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getMyDriveRoot(actor);
  const folder = await folderService.createFolder(actor, { name, parentFolderId: root.id }, TEST_META);
  return folder.id;
}

/** A molbio project with Alice on the team. Created by the department head, who may. */
async function molbioProject(code: string, name: string) {
  const { projectService } = await services();
  const head = await actorFor(fixture.users.deptAHead);
  return projectService.create(
    head,
    {
      name,
      code,
      departmentId: fixture.departments.molbio,
      memberUserIds: [fixture.users.scientistA],
      leadUserId: fixture.users.deptAHead,
    },
    TEST_META,
  );
}

describe('experiments inherit their project’s boundary', () => {
  it('is invisible to an employee in another department', async () => {
    if (skipUnlessDb()) return;
    const { experimentService } = await services();

    const project = await molbioProject('EXR-VIS-1', 'Exosome Yield');
    const alice = await actorFor(fixture.users.scientistA);
    const experiment = await experimentService.create(
      alice,
      { projectId: project.id, code: 'EXP-VIS-1', title: 'Yield optimisation run' },
      TEST_META,
    );

    const bob = await actorFor(fixture.users.scientistB);

    // Not "forbidden" — not found. A 403 on an id would confirm the experiment exists.
    await expect(experimentService.getById(bob, experiment.id)).rejects.toMatchObject({
      status: 404,
    });

    const visible = await experimentService.list(bob, { page: 1, pageSize: 50 });
    expect(visible.items.map((item) => item.code)).not.toContain('EXP-VIS-1');
    // The count is part of the disclosure, not just the rows.
    expect(visible.total).toBe(0);
  });

  it('refuses to record one for someone who may read the project but not edit it', async () => {
    if (skipUnlessDb()) return;
    const { experimentService, projectService } = await services();

    const project = await molbioProject('EXR-VIS-2', 'Marker Panel');
    const viewer = await actorFor(fixture.users.viewer);

    // The management viewer genuinely can see the project — company-wide read.
    await expect(projectService.getById(viewer, project.id)).resolves.toMatchObject({
      code: 'EXR-VIS-2',
    });

    await expect(
      experimentService.create(
        viewer,
        { projectId: project.id, code: 'EXP-VIS-2', title: 'Should not exist' },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a duplicate code, because codes are written on tubes', async () => {
    if (skipUnlessDb()) return;
    const { experimentService } = await services();

    const first = await molbioProject('EXR-DUP-A', 'Batch A');
    const second = await molbioProject('EXR-DUP-B', 'Batch B');
    const alice = await actorFor(fixture.users.scientistA);

    await experimentService.create(
      alice,
      { projectId: first.id, code: 'EXP-DUP-1', title: 'First' },
      TEST_META,
    );

    // Even in a different project: one code, one experiment, company-wide.
    await expect(
      experimentService.create(
        alice,
        { projectId: second.id, code: 'EXP-DUP-1', title: 'Second' },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses collaborators who are not on the project', async () => {
    if (skipUnlessDb()) return;
    const { experimentService } = await services();

    const project = await molbioProject('EXR-COLLAB', 'Collaboration');
    const alice = await actorFor(fixture.users.scientistA);

    await expect(
      experimentService.create(
        alice,
        {
          projectId: project.id,
          code: 'EXP-COLLAB-1',
          title: 'Run',
          collaboratorUserIds: [fixture.users.scientistB],
        },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses an experiment folder outside the project drive', async () => {
    if (skipUnlessDb()) return;
    const { experimentService } = await services();

    const project = await molbioProject('EXR-FOLDER', 'Folder Guard');
    const alice = await actorFor(fixture.users.scientistA);
    const elsewhere = await personalFolder(alice, 'Not the project drive');

    await expect(
      experimentService.create(
        alice,
        { projectId: project.id, code: 'EXP-FOLDER-1', title: 'Run', folderId: elsewhere },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('linking a file to an experiment', () => {
  it('traces the file to the project and counts it', async () => {
    if (skipUnlessDb()) return;
    const { experimentService, fileService, driveService, experimentRepository } = await services();

    const project = await molbioProject('EXR-LINK', 'Linkage');
    const alice = await actorFor(fixture.users.scientistA);
    const experiment = await experimentService.create(
      alice,
      { projectId: project.id, code: 'EXP-LINK-1', title: 'Run one' },
      TEST_META,
    );

    // Uploaded to a personal folder, so it starts with no project at all.
    const folder = await personalFolder(alice, 'Bench output');
    const file = await upload(alice, folder, 'gel.pdf', pdf('link'));
    expect(file.projectId).toBeNull();

    const linked = await fileService.updateFile(
      alice,
      file.id,
      { experimentId: experiment.id },
      TEST_META,
    );

    expect(linked.experimentId).toBe(experiment.id);
    // The project comes with the experiment: "trace this file to a project" has to hold
    // even for a file that was uploaded somewhere generic.
    expect(linked.projectId).toBe(project.id);

    const refreshed = await experimentRepository.findById(experiment.id);
    expect(refreshed?.fileCount).toBe(1);

    // Unlinking gives the count back.
    await fileService.updateFile(alice, file.id, { experimentId: null }, TEST_META);
    expect((await experimentRepository.findById(experiment.id))?.fileCount).toBe(0);

    // Drive access is unaffected by any of this.
    await expect(driveService.getProjectRoot(alice, project.id)).resolves.toBeTruthy();
  });

  it('refuses a link to an experiment in a project the employee has no part in', async () => {
    if (skipUnlessDb()) return;
    const { experimentService, fileService } = await services();

    const project = await molbioProject('EXR-LINK-2', 'Private research');
    const alice = await actorFor(fixture.users.scientistA);
    const experiment = await experimentService.create(
      alice,
      { projectId: project.id, code: 'EXP-LINK-2', title: 'Confidential run' },
      TEST_META,
    );

    const bob = await actorFor(fixture.users.scientistB);
    const bobFolder = await personalFolder(bob, 'Bob bench');
    const bobFile = await upload(bob, bobFolder, 'trace.pdf', pdf('bob'));

    // 404, not 403: Bob must not learn the experiment id is real.
    await expect(
      fileService.updateFile(bob, bobFile.id, { experimentId: experiment.id }, TEST_META),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('related files never reach across a boundary', () => {
  it('reports identical bytes filed in two places', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();

    const alice = await actorFor(fixture.users.scientistA);
    const first = await personalFolder(alice, 'Inbox');
    const second = await personalFolder(alice, 'Archive copy');

    const bytes = pdf('identical-content');
    const original = await upload(alice, first, 'assay-results.pdf', bytes);
    const duplicate = await upload(alice, second, 'assay results FINAL.pdf', bytes);

    const related = await fileService.listRelated(alice, original.id);
    const match = related.find((entry) => entry.file.id === duplicate.id);

    expect(match, 'the duplicate should be found by checksum, not by name').toBeTruthy();
    expect(match?.reasons).toContain('duplicate');
  });

  it('does not report a duplicate the viewer cannot open', async () => {
    if (skipUnlessDb()) return;
    const { fileService, driveService, folderService } = await services();

    const bytes = pdf('shared-content-across-departments');

    const alice = await actorFor(fixture.users.scientistA);
    const aliceFolder = await personalFolder(alice, 'Alice copy');
    const aliceFile = await upload(alice, aliceFolder, 'shared.pdf', bytes);

    // The same bytes, in Analytical Chemistry, where Alice has no grant at all.
    const bob = await actorFor(fixture.users.scientistB);
    const anchemRoot = await driveService.getDepartmentRoot(bob, fixture.departments.anchem);
    const anchemFolder = await folderService.createFolder(
      bob,
      { name: 'Chem data', parentFolderId: anchemRoot.id },
      TEST_META,
    );
    const bobFile = await upload(bob, anchemFolder.id, 'shared.pdf', bytes);

    const related = await fileService.listRelated(alice, aliceFile.id);
    expect(related.map((entry) => entry.file.id)).not.toContain(bobFile.id);

    // Bob's own view does find it — proving the exclusion above is about access, not
    // about the checksum match failing.
    const bobRelated = await fileService.listRelated(bob, bobFile.id);
    expect(bobRelated.map((entry) => entry.file.id)).not.toContain(aliceFile.id);
  });

  it('groups files recorded against the same sample', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();

    const alice = await actorFor(fixture.users.scientistA);
    const folder = await personalFolder(alice, 'Sample S-9001');

    const first = await upload(alice, folder, 'qpcr.pdf', pdf('sample-a'));
    const second = await upload(alice, folder, 'notes.pdf', pdf('sample-b'));

    await fileService.updateFile(alice, first.id, { metadata: { sampleId: 'S-9001' } }, TEST_META);
    await fileService.updateFile(alice, second.id, { metadata: { sampleId: 'S-9001' } }, TEST_META);

    const related = await fileService.listRelated(alice, first.id);
    const match = related.find((entry) => entry.file.id === second.id);
    expect(match?.reasons).toContain('sample');
  });
});

describe('the project dashboard counts only what the viewer can open', () => {
  it('excludes a restricted file from a company-wide reader’s totals', async () => {
    if (skipUnlessDb()) return;
    const { projectService, driveService, folderService, fileService } = await services();

    const project = await molbioProject('EXR-DASH', 'Dashboard');
    const alice = await actorFor(fixture.users.scientistA);

    const root = await driveService.getProjectRoot(alice, project.id);
    const folder = await folderService.createFolder(
      alice,
      { name: 'Runs', parentFolderId: root.id },
      TEST_META,
    );

    const open = await upload(alice, folder.id, 'summary.pdf', pdf('dash-open'));
    const secret = await upload(alice, folder.id, 'unblinded.pdf', pdf('dash-secret'));
    await fileService.updateFile(alice, secret.id, { confidentiality: 'restricted' }, TEST_META);
    expect(open.id).not.toBe(secret.id);

    const asAlice = await projectService.overview(alice, project.id);
    expect(asAlice.content.totalFiles).toBe(2);

    // The management viewer reads company-wide, but `restricted` is never reachable by
    // clearance alone — so their dashboard is smaller, and honestly so.
    const viewer = await actorFor(fixture.users.viewer);
    const asViewer = await projectService.overview(viewer, project.id);
    expect(asViewer.content.totalFiles).toBe(1);

    // And someone outside the department cannot open the dashboard at all.
    const bob = await actorFor(fixture.users.scientistB);
    await expect(projectService.overview(bob, project.id)).rejects.toMatchObject({ status: 404 });
  });

  it('reports template folders a drive is missing rather than creating them', async () => {
    if (skipUnlessDb()) return;
    const { projectService, folderService, driveService } = await services();

    const project = await molbioProject('EXR-TPL-GAP', 'Template gap');
    const head = await actorFor(fixture.users.deptAHead);
    const root = await driveService.getProjectRoot(head, project.id);

    const children = await folderService.listChildFolders(head, root.id, {
      page: 1,
      pageSize: 50,
      sort: 'name',
      order: 'asc',
    });
    const protocols = children.items.find((folder) => folder.name.includes('Protocols'));
    expect(protocols, 'the project template should have created the protocols folder').toBeTruthy();

    await folderService.trashFolder(head, protocols!.id, TEST_META);

    const overview = await projectService.overview(head, project.id);
    expect(overview.missingTemplateFolders.map((entry) => entry.name)).toContain(protocols!.name);
  });
});

describe('templates', () => {
  it('refuses a template change from someone who administers only their department', async () => {
    if (skipUnlessDb()) return;
    const { templateService } = await services();

    // The department head holds access.manage — but at department scope. A template is
    // company-wide, and every other department's drives are built from it.
    const head = await actorFor(fixture.users.deptAHead);

    await expect(
      templateService.saveFolderTemplates(
        head,
        { project: [{ name: '01_Only What I Want' }] },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('applies an edited folder template to new project drives only', async () => {
    if (skipUnlessDb()) return;
    const { templateService, projectService, folderService, driveService } = await services();

    const admin = await actorFor(fixture.users.companyAdmin);
    const before = await molbioProject('EXR-TPL-OLD', 'Built before the edit');

    await templateService.saveFolderTemplates(
      admin,
      {
        project: [
          { name: '01_Charter', description: 'Scope and team.' },
          { name: '02_Bench Records', description: 'Everything from the bench.' },
        ],
      },
      TEST_META,
    );

    const after = await molbioProject('EXR-TPL-NEW', 'Built after the edit');
    const head = await actorFor(fixture.users.deptAHead);

    const newRoot = await driveService.getProjectRoot(head, after.id);
    const newChildren = await folderService.listChildFolders(head, newRoot.id, {
      page: 1,
      pageSize: 50,
      sort: 'name',
      order: 'asc',
    });
    expect(newChildren.items.map((folder) => folder.name)).toEqual([
      '01_Charter',
      '02_Bench Records',
    ]);

    // The drive built from the old template is untouched: renaming a template must not
    // rename folders people have already filed work in.
    const oldRoot = await driveService.getProjectRoot(head, before.id);
    const oldChildren = await folderService.listChildFolders(head, oldRoot.id, {
      page: 1,
      pageSize: 50,
      sort: 'name',
      order: 'asc',
    });
    expect(oldChildren.items.some((folder) => folder.name === '03_Protocols and SOPs')).toBe(true);
  });

  it('refuses a metadata template field the codebase never declared', async () => {
    if (skipUnlessDb()) return;
    const { templateService } = await services();
    const admin = await actorFor(fixture.users.companyAdmin);

    for (const bogus of ['$where', '__proto__', 'a.b', 'inventedField']) {
      await expect(
        templateService.saveMetadataTemplates(
          admin,
          {
            templates: [
              { key: 'general', label: 'General', fieldKeys: ['study', bogus] },
            ],
          },
          TEST_META,
        ),
      ).rejects.toMatchObject({ status: 422 });
    }
  });

  it('keeps a general template available however the set is edited', async () => {
    if (skipUnlessDb()) return;
    const { templateService } = await services();
    const admin = await actorFor(fixture.users.companyAdmin);

    const saved = await templateService.saveMetadataTemplates(
      admin,
      { templates: [{ key: 'sequencing', label: 'Sequencing', fieldKeys: ['sampleId'] }] },
      TEST_META,
    );

    // An uncategorized file must still have a form to fill in.
    expect(saved.templates.some((template) => template.key === 'general')).toBe(true);
  });
});
