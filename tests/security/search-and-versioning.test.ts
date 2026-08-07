/**
 * Search and versioning — the two Phase 6 promises that are dangerous to get wrong.
 *
 * Search is the largest disclosure surface in the platform: it is the one place a user
 * can ask a question about files they were never shown. The cases below prove the answer
 * never mentions those files, in the row list *or* the total.
 *
 * Versioning's promise is the opposite kind: nothing is ever lost. Restore must append,
 * never rewind, and an approved version must survive whatever happens afterwards.
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
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    fileService: (await import('@/server/services/file.service')).fileService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    searchService: (await import('@/server/services/search.service')).searchService,
    versionService: (await import('@/server/services/version.service')).versionService,
    versionRepository: await import('@/server/repositories/file-version.repository'),
    fileRepository: await import('@/server/repositories/file.repository'),
    storage: (await import('@/server/storage')).getStorageProvider(),
  };
}

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\n%%EOF\n'),
]);

function pdfOfSize(marker: string): Buffer {
  return Buffer.concat([PDF_BYTES, Buffer.from(`% ${marker}\n`)]);
}

async function personalFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getMyDriveRoot(actor);
  const folder = await folderService.createFolder(actor, { name, parentFolderId: root.id }, TEST_META);
  return folder.id;
}

async function departmentFolder(actor: Actor, departmentId: string, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getDepartmentRoot(actor, departmentId);
  const folder = await folderService.createFolder(actor, { name, parentFolderId: root.id }, TEST_META);
  return folder.id;
}

async function upload(
  actor: Actor,
  folderId: string,
  filename: string,
  content: Buffer,
  extra: { targetFileId?: string; versionNote?: string } = {},
) {
  const { uploadService } = await services();
  const ticket = await uploadService.authorizeUpload(
    actor,
    { folderId, filename, size: content.byteLength, ...extra },
    TEST_META,
  );
  await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(content));
  return uploadService.finalize(actor, ticket.sessionId, TEST_META);
}

/** The full criteria object the search schema produces, with everything defaulted. */
function query(overrides: Record<string, unknown> = {}) {
  return {
    page: 1,
    pageSize: 25,
    scope: 'all' as const,
    includeArchived: false,
    sort: 'relevance' as const,
    order: 'desc' as const,
    ...overrides,
  } as Parameters<Awaited<ReturnType<typeof services>>['searchService']['search']>[1];
}

describe('search does not disclose what the viewer cannot open', () => {
  it('never returns another employee’s personal-drive file, by name or by count', async () => {
    if (skipUnlessDb()) return;
    const { searchService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await personalFolder(alice, 'Alice search private');
    await upload(alice, folderId, 'unobtainium-synthesis.pdf', pdfOfSize('alice-private'));

    // Alice finds her own file.
    const hers = await searchService.search(alice, query({ q: 'unobtainium' }));
    expect(hers.files.map((file) => file.displayName)).toContain('unobtainium-synthesis.pdf');

    // Bob, in another department, learns nothing — including from the total.
    const his = await searchService.search(bob, query({ q: 'unobtainium' }));
    expect(his.files).toHaveLength(0);
    expect(his.totals.files).toBe(0);
  });

  it('keeps a restricted file out of a colleague’s results even inside their own department', async () => {
    if (skipUnlessDb()) return;
    const { searchService, fileService } = await services();
    const head = await actorFor(fixture.users.deptAHead);
    const newcomer = await actorFor(fixture.users.noRole);

    const folderId = await departmentFolder(head, fixture.departments.molbio, 'Restricted search');
    const uploaded = await upload(head, folderId, 'embargoed-results.pdf', pdfOfSize('embargo'));

    await fileService.updateFile(
      head,
      uploaded.fileId,
      { confidentiality: 'restricted' },
      TEST_META,
    );

    // `restricted` is never reachable by clearance alone — it needs an explicit grant,
    // which the newcomer does not have.
    const results = await searchService.search(newcomer, query({ q: 'embargoed' }));
    expect(results.files).toHaveLength(0);
    expect(results.totals.files).toBe(0);
  });

  it('finds a file by sample ID without the searcher knowing its folder', async () => {
    if (skipUnlessDb()) return;
    const { searchService, fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const deep = await personalFolder(alice, 'Sample lookup');
    const uploaded = await upload(alice, deep, 'plate-readout.csv', Buffer.from('a,b\n1,2\n'));

    await fileService.updateFile(
      alice,
      uploaded.fileId,
      { metadata: { sampleId: 'S-4471', experimentCode: 'EXP-2026-014' } },
      TEST_META,
    );

    // Exact-match metadata filter, no text term at all.
    const byFilter = await searchService.search(alice, query({ sampleId: 'S-4471' }));
    expect(byFilter.files.map((file) => file.id)).toContain(uploaded.fileId);

    // And through the text index, which names metadata.sampleId explicitly.
    const byText = await searchService.search(alice, query({ q: 'S-4471' }));
    expect(byText.files.map((file) => file.id)).toContain(uploaded.fileId);
  });

  it('returns nothing rather than everything when no criteria are supplied', async () => {
    if (skipUnlessDb()) return;
    const { searchService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const results = await searchService.search(alice, query());
    expect(results.empty).toBe(true);
    expect(results.files).toHaveLength(0);
  });
});

describe('research metadata', () => {
  it('refuses a field that is not in the allow-list', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Metadata allow-list');
    const uploaded = await upload(alice, folderId, 'notes.txt', Buffer.from('hello'));

    await expect(
      fileService.updateFile(alice, uploaded.fileId, { metadata: { $where: '1' } }, TEST_META),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      fileService.updateFile(
        alice,
        uploaded.fileId,
        { metadata: { 'a.b': 'nested' } },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects a value that does not match the field’s declared type', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Metadata types');
    const uploaded = await upload(alice, folderId, 'typed.txt', Buffer.from('hello'));

    await expect(
      fileService.updateFile(
        alice,
        uploaded.fileId,
        { metadata: { documentType: 'not-a-listed-option' } },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      fileService.updateFile(
        alice,
        uploaded.fileId,
        { metadata: { researchDate: 'the fourteenth' } },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('clears an annotation when it is set to empty, rather than storing a blank', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Metadata clearing');
    const uploaded = await upload(alice, folderId, 'clearable.txt', Buffer.from('hello'));

    await fileService.updateFile(alice, uploaded.fileId, { metadata: { sampleId: 'S-1' } }, TEST_META);
    const withValue = await fileService.getFile(alice, uploaded.fileId);
    expect(withValue.metadata.sampleId).toBe('S-1');

    await fileService.updateFile(alice, uploaded.fileId, { metadata: { sampleId: '' } }, TEST_META);
    const cleared = await fileService.getFile(alice, uploaded.fileId);
    expect('sampleId' in cleared.metadata).toBe(false);
  });

  it('lets an owner raise a classification without holding that clearance', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await personalFolder(alice, 'Classify upward');
    const uploaded = await upload(alice, folderId, 'sensitive.txt', Buffer.from('hello'));

    // Raising only removes reach. Blocking it would mean someone who spots data that is
    // more sensitive than its folder implied cannot lock it down.
    const restricted = await fileService.updateFile(
      alice,
      uploaded.fileId,
      { confidentiality: 'restricted' },
      TEST_META,
    );
    expect(restricted.confidentiality).toBe('restricted');
  });

  it('refuses a declassification from someone who cannot manage the file’s access', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();
    const head = await actorFor(fixture.users.deptAHead);
    const newcomer = await actorFor(fixture.users.noRole);

    const folderId = await departmentFolder(head, fixture.departments.molbio, 'Declassify guard');
    const uploaded = await upload(head, folderId, 'guarded.txt', Buffer.from('hello'));
    await fileService.updateFile(head, uploaded.fileId, { confidentiality: 'confidential' }, TEST_META);

    // Downgrading hands the file to everyone with department scope in one request, so it
    // needs the same permission that governs sharing.
    await expect(
      fileService.updateFile(
        newcomer,
        uploaded.fileId,
        { confidentiality: 'public_internal' },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: expect.any(Number) });
  });

  it('deduplicates tags case-insensitively', async () => {
    if (skipUnlessDb()) return;
    const { fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Tag dedupe');
    const uploaded = await upload(alice, folderId, 'tagged.txt', Buffer.from('hello'));

    const updated = await fileService.updateFile(
      alice,
      uploaded.fileId,
      { tags: ['qPCR', 'qpcr', 'QPCR', 'plate3'] },
      TEST_META,
    );

    expect(updated.tags).toHaveLength(2);
    expect(updated.tags.map((tag) => tag.toLowerCase()).sort()).toEqual(['plate3', 'qpcr']);
  });
});

describe('version restore appends rather than rewinds', () => {
  it('creates a new version with new bytes, leaving the original untouched', async () => {
    if (skipUnlessDb()) return;
    const { versionService, versionRepository, fileService, storage } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Restore appends');

    const v1 = await upload(alice, folderId, 'protocol.pdf', pdfOfSize('v1'));
    await upload(alice, folderId, 'protocol.pdf', pdfOfSize('v2'), { targetFileId: v1.fileId });

    const beforeRestore = await versionRepository.listForFile(v1.fileId);
    expect(beforeRestore).toHaveLength(2);

    const original = beforeRestore.find((version) => version.versionNumber === 1)!;
    const restored = await versionService.restoreVersion(
      alice,
      v1.fileId,
      { versionId: original.id },
      TEST_META,
    );

    // A third version, not a flag flipped on the first.
    expect(restored.versionNumber).toBe(3);
    expect(restored.isCurrent).toBe(true);
    expect(restored.restoredFromVersionId).toBe(original.id);
    expect(restored.checksumSha256).toBe(original.checksumSha256);

    const after = await versionRepository.listForFile(v1.fileId);
    expect(after).toHaveLength(3);
    expect(after.find((version) => version.versionNumber === 1)).toBeTruthy();

    // Distinct physical keys: "every version must have a different storage key".
    const originalLocation = await versionRepository.getStorageLocation(original.id);
    const restoredLocation = await versionRepository.getStorageLocation(restored.id);
    expect(originalLocation!.key).not.toBe(restoredLocation!.key);
    expect(await storage.fileExists(originalLocation!.key, originalLocation!.area)).toBe(true);
    expect(await storage.fileExists(restoredLocation!.key, restoredLocation!.area)).toBe(true);

    const file = await fileService.getFile(alice, v1.fileId);
    expect(file.currentVersionId).toBe(restored.id);
    expect(file.versionCount).toBe(3);
  });

  it('refuses to restore the version that is already current', async () => {
    if (skipUnlessDb()) return;
    const { versionService, versionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Restore current');

    const uploaded = await upload(alice, folderId, 'single.pdf', pdfOfSize('only'));
    const current = await versionRepository.findCurrent(uploaded.fileId);

    await expect(
      versionService.restoreVersion(alice, uploaded.fileId, { versionId: current!.id }, TEST_META),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a version id belonging to a different file', async () => {
    if (skipUnlessDb()) return;
    const { versionService, versionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Restore cross-file');

    const first = await upload(alice, folderId, 'one.pdf', pdfOfSize('one'));
    const second = await upload(alice, folderId, 'two.pdf', pdfOfSize('two'));

    const otherVersion = await versionRepository.findCurrent(second.fileId);

    await expect(
      versionService.restoreVersion(
        alice,
        first.fileId,
        { versionId: otherVersion!.id },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('resets the review cycle, because the file’s content changed', async () => {
    if (skipUnlessDb()) return;
    const { versionService, versionRepository, fileService, fileRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Restore resets review');

    const uploaded = await upload(alice, folderId, 'approved.pdf', pdfOfSize('r1'));
    await upload(alice, folderId, 'approved.pdf', pdfOfSize('r2'), { targetFileId: uploaded.fileId });

    const versions = await versionRepository.listForFile(uploaded.fileId);
    const first = versions.find((version) => version.versionNumber === 1)!;

    // Simulate the state Phase 8 produces: the current version is signed off.
    await fileRepository.updateById(uploaded.fileId, {
      approvalStatus: 'approved',
      reviewStatus: 'approved',
    });
    await versionRepository.updateFlags(versions[0]!.id, {
      $set: { isApproved: true, label: 'approved' },
    });

    await versionService.restoreVersion(alice, uploaded.fileId, { versionId: first.id }, TEST_META);

    const file = await fileService.getFile(alice, uploaded.fileId);
    expect(file.approvalStatus).toBe('none');
    expect(file.reviewStatus).toBe('draft');
    expect(file.approvedVersionId).toBeNull();

    // The version that was approved keeps its own record — that is what makes
    // "which bytes did they sign?" answerable after the fact.
    const stillApproved = (await versionRepository.listForFile(uploaded.fileId)).find(
      (version) => version.id === versions[0]!.id,
    );
    expect(stillApproved!.isApproved).toBe(true);
    expect(stillApproved!.label).toBe('approved');
  });

  it('refuses a restore from someone who cannot upload versions to the file', async () => {
    if (skipUnlessDb()) return;
    const { versionService, versionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await personalFolder(alice, 'Restore permission');
    const uploaded = await upload(alice, folderId, 'private.pdf', pdfOfSize('p1'));
    await upload(alice, folderId, 'private.pdf', pdfOfSize('p2'), { targetFileId: uploaded.fileId });

    const versions = await versionRepository.listForFile(uploaded.fileId);
    const first = versions.find((version) => version.versionNumber === 1)!;

    await expect(
      versionService.restoreVersion(bob, uploaded.fileId, { versionId: first.id }, TEST_META),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('stored versions stay immutable', () => {
  it('rejects an update to any field other than the mutable review flags', async () => {
    if (skipUnlessDb()) return;
    const { versionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Immutability');

    const uploaded = await upload(alice, folderId, 'frozen.pdf', pdfOfSize('frozen'));
    const current = await versionRepository.findCurrent(uploaded.fileId);

    // The model's pre-hook is the last line of defence: even a direct repository call
    // cannot repoint a version at different bytes.
    await expect(
      versionRepository.updateFlags(current!.id, { $set: { storageKey: 'somewhere/else' } }),
    ).rejects.toThrow(/immutable/i);

    await expect(
      versionRepository.updateFlags(current!.id, { $set: { checksumSha256: 'f'.repeat(64) } }),
    ).rejects.toThrow(/immutable/i);
  });

  it('allows a version note to be corrected', async () => {
    if (skipUnlessDb()) return;
    const { versionService, versionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const folderId = await personalFolder(alice, 'Note correction');

    const uploaded = await upload(alice, folderId, 'noted.pdf', pdfOfSize('noted'));
    const current = await versionRepository.findCurrent(uploaded.fileId);

    const updated = await versionService.updateVersionNote(
      alice,
      uploaded.fileId,
      current!.id,
      'Corrected: run performed on the Tuesday, not the Monday',
      TEST_META,
    );

    expect(updated.versionNote).toContain('Corrected');
  });
});
