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
import type { VersionPatch } from '@/server/repositories/file-version.repository.contract';

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
  await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(content), TEST_META);
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
      isApproved: true,
      label: 'approved',
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

    /**
     * Two layers now stop a version being repointed at different bytes.
     *
     * `VersionPatch` has no `storageKey` and no `checksumSha256`, so the ordinary way to
     * attempt this stopped compiling when the patch became typed — which is the better place
     * to catch it. The cast here defeats that deliberately, to prove the model's pre-hook is
     * still underneath it: the type is the fence, the hook is the last line of defence, and a
     * future caller reaching for `as unknown` must still be refused at runtime.
     */
    const bypassTyping = (fields: Record<string, unknown>) =>
      versionRepository.updateFlags(current!.id, fields as VersionPatch);

    await expect(bypassTyping({ storageKey: 'somewhere/else' })).rejects.toThrow(/immutable/i);
    await expect(bypassTyping({ checksumSha256: 'f'.repeat(64) })).rejects.toThrow(/immutable/i);
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

/**
 * A version id is not a capability.
 *
 * The version repository takes no `Actor` — on either engine — and says so in its contract:
 * `findById` "carries no authorization of its own". Nothing about migrating it to D1 changes
 * that, so the boundary has to hold one level up, and it is always the same two lines:
 *
 *     const context = await requireFile(actor, fileId, <permission>);
 *     if (!version || version.fileId !== fileId) throw new NotFoundError();
 *
 * The first line decides whether this actor may touch this *file*. The second refuses to let a
 * version id smuggle in a different one. Drop either and a guessed id becomes read access to
 * somebody else's research — permission checked on one object, bytes taken from another.
 *
 * Every service that accepts a caller-supplied version id is exercised below: `download` (which
 * serves the bytes), `restoreVersion` and `updateVersionNote` (which write), and
 * `listVersions` (which discloses the history). The four ways an actor can lose access to a
 * file — another organization, an explicit deny, a broken inheritance chain, an expired share —
 * are each pushed through them, because a version read that outlived any one of those would be
 * the disclosure the ACL exists to prevent.
 */
describe('a version id is not a capability', () => {
  async function boundaryServices() {
    return {
      ...(await services()),
      downloadService: (await import('@/server/services/download.service')).downloadService,
      sharingService: (await import('@/server/services/sharing.service')).sharingService,
      folderService: (await import('@/server/services/folder.service')).folderService,
      driveService: (await import('@/server/services/drive.service')).driveService,
    };
  }

  async function drain(body: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of body as unknown as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** Two files owned by Alice, each with its own version, in one personal folder. */
  async function twoFiles(alice: Actor, label: string) {
    const { versionRepository } = await boundaryServices();
    const folderId = await personalFolder(alice, label);
    const mine = await upload(alice, folderId, 'mine.pdf', pdfOfSize(`${label}-mine`));
    const other = await upload(alice, folderId, 'other.pdf', pdfOfSize(`${label}-other`));
    return {
      folderId,
      mine,
      other,
      otherVersion: (await versionRepository.findCurrent(other.fileId))!,
    };
  }

  it('serves a version that belongs to the authorized file', async () => {
    if (skipUnlessDb()) return;
    const { downloadService } = await boundaryServices();
    const alice = await actorFor(fixture.users.scientistA);
    const { mine } = await twoFiles(alice, 'Boundary allowed');

    const stream = await downloadService.download(
      alice,
      mine.fileId,
      { versionId: mine.versionId },
      TEST_META,
    );

    expect(stream.versionId).toBe(mine.versionId);
    expect((await drain(stream.body)).byteLength).toBeGreaterThan(0);
  });

  /**
   * The critical case: the *file* is authorized and the *version* is not part of it.
   *
   * `requireFile` passes — Alice owns both files — so the only thing standing between the
   * caller and bytes from a different record is `version.fileId !== fileId`.
   */
  it('refuses a version id belonging to another file, on every service that takes one', async () => {
    if (skipUnlessDb()) return;
    const { downloadService, versionService } = await boundaryServices();
    const alice = await actorFor(fixture.users.scientistA);
    const { mine, otherVersion } = await twoFiles(alice, 'Boundary cross file');

    await expect(
      downloadService.download(alice, mine.fileId, { versionId: otherVersion.id }, TEST_META),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      versionService.updateVersionNote(alice, mine.fileId, otherVersion.id, 'mine now', TEST_META),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      versionService.restoreVersion(alice, mine.fileId, { versionId: otherVersion.id }, TEST_META),
    ).rejects.toMatchObject({ status: 404 });

    // Refused, not partially applied: the other file's version is exactly as it was.
    const { versionRepository } = await boundaryServices();
    const untouched = await versionRepository.findById(otherVersion.id);
    expect(untouched).toMatchObject({
      versionNote: otherVersion.versionNote,
      fileId: otherVersion.fileId,
      isCurrent: true,
    });
  });

  /**
   * An actor carrying every permission Alice has, in a different organization.
   *
   * Built by overriding the organization on a real actor rather than by seeding a second
   * company: what is being tested is that the *permission set* is not what grants access, so
   * the strongest version of the test keeps the permissions and changes only the tenant.
   */
  it('refuses a fully-privileged actor from another organization', async () => {
    if (skipUnlessDb()) return;
    const { fileService, downloadService, versionService } = await boundaryServices();
    const alice = await actorFor(fixture.users.scientistA);
    const { mine } = await twoFiles(alice, 'Boundary other org');

    const { Types } = await import('mongoose');
    const foreigner: Actor = {
      ...alice,
      userId: String(new Types.ObjectId()),
      organizationId: String(new Types.ObjectId()),
      email: 'chief@rival.com',
      name: 'Rival Chief',
    };

    await expect(fileService.listVersions(foreigner, mine.fileId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      downloadService.download(foreigner, mine.fileId, { versionId: mine.versionId }, TEST_META),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      versionService.updateVersionNote(foreigner, mine.fileId, mine.versionId, 'ours', TEST_META),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses somebody the file explicitly denies, even though they were shared it', async () => {
    if (skipUnlessDb()) return;
    const { fileService, downloadService, sharingService } = await boundaryServices();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);
    const { mine } = await twoFiles(alice, 'Boundary deny');

    await sharingService.share(
      alice,
      'file',
      mine.fileId,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'viewer' },
      TEST_META,
    );
    // The share works, so the denial below is what removes the access rather than its absence.
    expect(await fileService.listVersions(bob, mine.fileId)).toHaveLength(1);

    await sharingService.share(
      alice,
      'file',
      mine.fileId,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'viewer', deny: true },
      TEST_META,
    );

    await expect(fileService.listVersions(bob, mine.fileId)).rejects.toMatchObject({ status: 404 });
    await expect(
      downloadService.download(bob, mine.fileId, { versionId: mine.versionId }, TEST_META),
    ).rejects.toMatchObject({ status: 404 });
  });

  /**
   * Access to the folder is not access to the file once inheritance is broken.
   *
   * Bob keeps his grant on the parent folder throughout — so if the version read consulted the
   * folder chain alone, or cached the decision from the containing folder, this would still
   * succeed. It has to be the file's own ACL that decides, and after the break it says nothing
   * about Bob.
   */
  it('refuses across a broken inheritance boundary, while the parent folder stays shared', async () => {
    if (skipUnlessDb()) return;
    const { fileService, downloadService, sharingService, folderService, driveService } =
      await boundaryServices();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const root = await driveService.getMyDriveRoot(alice);
    const parent = await folderService.createFolder(
      alice,
      { name: 'Boundary inheritance', parentFolderId: root.id },
      TEST_META,
    );
    const uploaded = await upload(alice, parent.id, 'inherited.pdf', pdfOfSize('inherited'));

    await sharingService.share(
      alice,
      'folder',
      parent.id,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'viewer' },
      TEST_META,
    );
    expect(await fileService.listVersions(bob, uploaded.fileId)).toHaveLength(1);

    // Breaking inheritance copies Bob's grant down; revoking the copy is what cuts him off.
    await sharingService.setInheritance(alice, 'file', uploaded.fileId, false, TEST_META);
    await sharingService.revokeShare(alice, 'file', uploaded.fileId, 'user', bob.userId, TEST_META);

    await expect(fileService.listVersions(bob, uploaded.fileId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      downloadService.download(bob, uploaded.fileId, { versionId: uploaded.versionId }, TEST_META),
    ).rejects.toMatchObject({ status: 404 });

    // The folder itself is still his, which is what makes the refusal above meaningful.
    expect((await folderService.getFolder(bob, parent.id)).folder.id).toBe(parent.id);
  });

  /**
   * An expired share grants nothing — including the version history it once covered.
   *
   * Written straight onto the ACL because `sharingService.share` refuses a past expiry, which
   * is correct for the API and useless for reproducing a grant that has simply run out. This is
   * the state a legitimate time-boxed share reaches on its own the moment the clock passes it.
   */
  it('refuses a share that has expired', async () => {
    if (skipUnlessDb()) return;
    const { fileService, downloadService, fileRepository, versionService } =
      await boundaryServices();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);
    const { mine } = await twoFiles(alice, 'Boundary expiry');

    const grant = (expiresAt: Date) =>
      fileRepository.updateById(mine.fileId, {
        permissions: [
          {
            principalType: 'user' as const,
            principalId: bob.userId,
            accessLevel: 'editor' as const,
            deny: false,
            expiresAt,
            grantedBy: alice.userId,
          },
        ],
      });

    await grant(new Date(Date.now() + 3_600_000));
    expect(await fileService.listVersions(bob, mine.fileId)).toHaveLength(1);

    await grant(new Date(Date.now() - 1_000));

    await expect(fileService.listVersions(bob, mine.fileId)).rejects.toMatchObject({ status: 404 });
    await expect(
      downloadService.download(bob, mine.fileId, { versionId: mine.versionId }, TEST_META),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      versionService.updateVersionNote(bob, mine.fileId, mine.versionId, 'still mine', TEST_META),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * Facet counts describe the same population the results do.
 *
 * `searchFacets` is built from MongoDB aggregates, and Mongoose does not route `aggregate`
 * through the query middleware that applies the soft-delete filter — so the chips counted
 * trashed files while the result list beside them did not. A user reading "qpcr (2)" and
 * seeing one row is being told, accurately, that a second file exists.
 *
 * That is a disclosure as well as an inconsistency: the trashed file may have been trashed
 * *because* it should not have been there. The D1 implementation excluded them from the start;
 * this pins the corrected Mongo behaviour so the two engines cannot drift apart again.
 */
describe('facet counts agree with the results beside them', () => {
  it('stops counting a file once it is in the trash', async () => {
    if (skipUnlessDb()) return;
    const { searchService, fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await personalFolder(alice, 'Facet trash');
    const keep = await upload(alice, folderId, 'facet-keep.pdf', pdfOfSize('facet-keep'));
    const drop = await upload(alice, folderId, 'facet-drop.pdf', pdfOfSize('facet-drop'));

    const TAG = 'facet-consistency-probe';
    for (const file of [keep, drop]) {
      await fileService.updateFile(alice, file.fileId, { tags: [TAG] }, TEST_META);
    }

    const countFor = async (tag: string) =>
      (await searchService.facets(alice)).tags.find((entry) => entry.value === tag)?.count ?? 0;

    expect(await countFor(TAG)).toBe(2);

    await fileService.trashFile(alice, drop.fileId, TEST_META);

    // The chip and the result list now describe the same one file.
    expect(await countFor(TAG)).toBe(1);
    const results = await searchService.search(alice, query({ tags: [TAG] }));
    expect(results.files).toHaveLength(1);
    expect(results.totals.files).toBe(1);
  });

  /**
   * The category facet is a second aggregate with the same defect, and it is the one a user
   * sees without searching for anything — so it is worth its own assertion rather than
   * trusting that one fix covered both.
   */
  it('stops counting a trashed file in the category chips too', async () => {
    if (skipUnlessDb()) return;
    const { searchService, fileService } = await services();
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await personalFolder(bob, 'Facet category');
    const before = await searchService.facets(bob);
    const baseline =
      before.categories.find((entry) => entry.value === 'document')?.count ?? 0;

    const uploaded = await upload(bob, folderId, 'category-probe.pdf', pdfOfSize('category'));
    const withFile = await searchService.facets(bob);
    expect(withFile.categories.find((entry) => entry.value === 'document')?.count ?? 0).toBe(
      baseline + 1,
    );

    await fileService.trashFile(bob, uploaded.fileId, TEST_META);

    const after = await searchService.facets(bob);
    expect(after.categories.find((entry) => entry.value === 'document')?.count ?? 0).toBe(baseline);
  });
});
