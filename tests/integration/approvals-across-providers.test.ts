/**
 * Phase 8 — an approval covers a state, not a name.
 *
 * Every approval in this system is pinned to a version, and while bytes lived on our own
 * disk that was a complete guarantee: a version's content is immutable there, so "approved"
 * could not quietly come to mean something else. Content in a Shared Drive has no such
 * property. A Google Doc can be rewritten by anyone who can open it, and *nothing in the
 * version record changes when it is* — same checksum, same size, same everything.
 *
 * So the claim under test is narrow and load-bearing: **an approved document that changes
 * stops claiming to be approved, and the record of who approved what survives that.** Both
 * halves matter. A system that quietly kept the badge would be lying; one that deleted the
 * approval to avoid lying would be destroying the evidence.
 *
 * The Google-native case is tested specifically rather than assumed to follow from the
 * binary one, because Drive treats the two differently in a way that would silently defeat
 * the naive implementation — see `getHeadRevision` in `drive-client.ts`.
 */
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import { FakeDriveClient } from '../helpers/fake-drive';
import type { Actor } from '@/server/permissions/actor';
import { DriveApiError } from '@/server/storage/google/drive-errors';
import { GoogleDriveObjectStore } from '@/server/storage/google/google-drive-object-store';
import type { DriveStorageConfig } from '@/server/storage/google/drive-config';
import { AuditLogModel } from '@/server/db/models/audit-log.model';
import { FileModel } from '@/server/db/models/file.model';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { NotificationModel } from '@/server/db/models/notification.model';
import { ReviewModel } from '@/server/db/models/review.model';
import { resetEnvCache } from '@/server/config/env';

let db: TestDb;
let fixture: Fixture;
let drive: FakeDriveClient;

const DRIVE_ROOT = 'root-folder';
const savedEnv = { ...process.env };

function skipUnlessDb(): boolean {
  if (db.available) return false;
  expect(db.reason, 'in-memory MongoDB unavailable').toBeTruthy();
  return true;
}

function driveConfig(): DriveStorageConfig {
  return {
    sharedDriveId: 'drive-company',
    rootFolderId: DRIVE_ROOT,
    serviceAccountEmail: 'sa@example.iam.gserviceaccount.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----',
    workspaceDomain: null,
    uploadChunkBytes: 256 * 1024,
    maxConcurrentTransfers: 4,
    requestTimeoutMs: 30_000,
    keySource: 'file',
  };
}

function enableDrive(): void {
  process.env.GOOGLE_DRIVE_STORAGE_ENABLED = 'true';
  process.env.DEFAULT_STORAGE_PROVIDER = 'google_drive';
  process.env.GOOGLE_SHARED_DRIVE_ID = 'drive-company';
  process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL = 'sa@example.iam.gserviceaccount.com';
  process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY =
    '-----BEGIN PRIVATE KEY-----\\nunused\\n-----END PRIVATE KEY-----';
  resetEnvCache();
}

/** Drive connected for migration, but new uploads still land locally. A real deployment state. */
function connectDriveButKeepUploadsLocal(): void {
  enableDrive();
  process.env.DEFAULT_STORAGE_PROVIDER = 'local';
  resetEnvCache();
}

async function services() {
  return {
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    reviewService: (await import('@/server/services/review.service')).reviewService,
    approvals: await import('@/server/services/approval-integrity.service'),
  };
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('1 0 obj<<>>endobj\n%%EOF\n')]);

function pdf(marker: string): Buffer {
  return Buffer.concat([PDF, Buffer.from(`% ${marker}\n`)]);
}

async function departmentFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getDepartmentRoot(actor, fixture.departments.molbio);
  const folder = await folderService.createFolder(actor, { name, parentFolderId: root.id }, TEST_META);
  return folder.id;
}

async function upload(actor: Actor, folderId: string, filename: string, content: Buffer) {
  const { uploadService } = await services();
  const ticket = await uploadService.authorizeUpload(
    actor,
    { folderId, filename, size: content.byteLength },
    TEST_META,
  );
  await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(content));
  return uploadService.finalize(actor, ticket.sessionId, TEST_META);
}

/**
 * Upload, submit, approve — the state every test here starts from.
 *
 * Alice owns and submits; Bob signs off. Rule 2 of the review design forbids approving your
 * own work, so this is the only shape a real approval can take.
 */
async function approvedFile(name: string): Promise<{
  fileId: string;
  versionId: string;
  reviewId: string;
  driveFileId: string | null;
}> {
  const { reviewService } = await services();
  const alice = await actorFor(fixture.users.scientistA);
  const bob = await actorFor(fixture.users.scientistB);

  const folder = await departmentFolder(alice, `Approvals ${name}`);
  const uploaded = await upload(alice, folder, `${name}.pdf`, pdf(name));

  const review = await reviewService.submitForReview(
    alice,
    uploaded.fileId,
    { reviewerUserIds: [fixture.users.scientistB] },
    TEST_META,
  );
  await reviewService.decide(bob, review.id, { decision: 'approve' }, TEST_META);

  const version = await FileVersionModel.findById(uploaded.versionId).lean();

  return {
    fileId: uploaded.fileId,
    versionId: uploaded.versionId,
    reviewId: review.id,
    driveFileId: version?.googleDriveFileId ?? null,
  };
}

beforeAll(async () => {
  db = await startTestDb();
  if (!db.available) return;
  fixture = await seedFixture();
  const { getStorageProvider } = await import('@/server/storage');
  await getStorageProvider().ensureReady();

  // Bob needs `review.approve` in Alice's department. The `reviewer` role deliberately does
  // not carry it — raising concerns and signing off are different rights.
  const roleRepository = await import('@/server/repositories/role.repository');
  await roleRepository.grantRole({
    organizationId: fixture.organizationId,
    userId: fixture.users.scientistB,
    roleId: fixture.roleIds.rd_head!,
    scopeType: 'department',
    scopeId: fixture.departments.molbio,
    grantedBy: fixture.users.superAdmin,
  });
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

beforeEach(async () => {
  drive = new FakeDriveClient();
  if (!db.available) return;

  const store = new GoogleDriveObjectStore(drive, driveConfig());
  const { getObjectStore, storageRegistry } = await import('@/server/storage');
  getObjectStore('local');
  storageRegistry.register({ objects: store, hierarchy: store });

  const { setGoogleDriveStorage } = await import('@/server/storage/google');
  setGoogleDriveStorage({ client: drive, store });

  enableDrive();
});

afterEach(async () => {
  process.env = { ...savedEnv };
  resetEnvCache();
  const { setGoogleDriveStorage } = await import('@/server/storage/google');
  setGoogleDriveStorage(null);
});

describe('an approval records the exact state it was granted against', () => {
  it('binds the Drive revision when the approval closes', async () => {
    if (skipUnlessDb()) return;
    const { versionId, driveFileId } = await approvedFile('bound');

    expect(driveFileId, 'the version should have reached Drive').toBeTruthy();

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.isApproved).toBe(true);
    expect(version!.approvedRevisionId).toBeTruthy();
    expect(version!.approvalSupersededAt).toBeNull();

    // The binding is the revision Drive actually reports, not something invented locally.
    const live = await drive.getHeadRevision(driveFileId!);
    expect(version!.approvedRevisionId).toBe(live.id);
  });

  it('leaves a locally-stored approval unbound, and never calls Drive for it', async () => {
    if (skipUnlessDb()) return;
    connectDriveButKeepUploadsLocal();

    const { versionId } = await approvedFile('local-only');
    const version = await FileVersionModel.findById(versionId).lean();

    expect(version!.storageProvider).toBe('local');
    expect(version!.isApproved).toBe(true);
    // Nothing to bind: local bytes are immutable, so there is nothing that could drift.
    expect(version!.approvedRevisionId).toBeNull();
    expect(drive.calls).not.toContain('getHeadRevision');
  });

  it('records the revision on the review request, so a decision can be checked against it', async () => {
    if (skipUnlessDb()) return;
    const { reviewService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folder = await departmentFolder(alice, 'Pinned request');
    const uploaded = await upload(alice, folder, 'pinned.pdf', pdf('pinned'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [fixture.users.scientistB] },
      TEST_META,
    );

    const stored = await ReviewModel.findById(review.id).lean();
    expect(stored!.versionRevisionId).toBeTruthy();
    expect(stored!.versionChecksum).toBeTruthy();
  });
});

describe('a document that changes after approval goes back to review', () => {
  it('clears the approval, returns the file to changes_requested and explains why', async () => {
    if (skipUnlessDb()) return;
    const { fileId, versionId, driveFileId } = await approvedFile('edited');
    const { approvals } = await services();

    // Somebody edits it in the Drive web UI. Nothing in this application is involved.
    drive.editInDrive(driveFileId!, Buffer.from('rewritten by someone else'));

    const result = await approvals.checkApprovedVersion(versionId);
    expect(result.outcome).toBe('superseded');

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.isApproved).toBe(false);
    expect(version!.label).toBe('changes_requested');
    expect(version!.approvalSupersededAt).toBeTruthy();
    expect(version!.approvalSupersededReason).toContain('changed');

    const file = await FileModel.findById(fileId).lean();
    expect(file!.approvalStatus).toBe('none');
    expect(file!.reviewStatus).toBe('changes_requested');
    expect(file!.approvedVersionId).toBeNull();
  });

  it('keeps the approval record intact — who signed, when, and their decision', async () => {
    if (skipUnlessDb()) return;
    const { versionId, reviewId, driveFileId } = await approvedFile('evidence');
    const { approvals } = await services();

    drive.editInDrive(driveFileId!, Buffer.from('changed'));
    await approvals.checkApprovedVersion(versionId);

    // The review and its decisions are untouched: this is the evidence that an approval
    // happened, and it stays true even though the approval no longer covers the document.
    const review = await ReviewModel.findById(reviewId).lean();
    expect(review!.status).toBe('approved');
    expect(review!.decisions).toHaveLength(1);
    expect(String(review!.decisions[0]!.reviewerUserId)).toBe(fixture.users.scientistB);

    // And on the version itself, who approved it survives even though `isApproved` does not.
    const version = await FileVersionModel.findById(versionId).lean();
    expect(String(version!.approvedBy)).toBe(fixture.users.scientistB);
    expect(version!.approvedAt).toBeTruthy();
  });

  it('writes an audit entry naming the system as the actor', async () => {
    if (skipUnlessDb()) return;
    const { fileId, versionId, driveFileId } = await approvedFile('audited');
    const { approvals } = await services();

    drive.editInDrive(driveFileId!, Buffer.from('changed'));
    await approvals.checkApprovedVersion(versionId);

    const entry = await AuditLogModel.findOne({
      action: 'file.approval_invalidated',
      entityId: fileId,
    }).lean();

    expect(entry).toBeTruthy();
    // Not a synthetic administrator: nobody did this, a sweep noticed it.
    expect(entry!.actorUserId).toBeNull();
    expect(entry!.actorEmail).toBe('system:approval-integrity');
    expect(entry!.severity).toBe('warning');
  });

  it('tells the owner and the person who approved it', async () => {
    if (skipUnlessDb()) return;
    const { fileId, versionId, driveFileId } = await approvedFile('notified');
    const { approvals } = await services();

    drive.editInDrive(driveFileId!, Buffer.from('changed'));
    await approvals.checkApprovedVersion(versionId);

    const notifications = await NotificationModel.find({
      entityId: fileId,
      type: 'review.reopened',
    }).lean();

    const told = new Set(notifications.map((entry) => String(entry.userId)));
    expect(told.has(fixture.users.scientistA), 'the owner').toBe(true);
    expect(told.has(fixture.users.scientistB), 'the approver').toBe(true);
    // Plain language: no revision ids, no Drive vocabulary.
    expect(notifications[0]!.message).toContain('needs reviewing again');
  });

  it('does not invalidate it twice', async () => {
    if (skipUnlessDb()) return;
    const { fileId, versionId, driveFileId } = await approvedFile('once');
    const { approvals } = await services();

    drive.editInDrive(driveFileId!, Buffer.from('changed'));
    await approvals.checkApprovedVersion(versionId);
    const second = await approvals.checkApprovedVersion(versionId);

    // Already recorded, already acted on. Re-checking must not raise it again.
    expect(second.outcome).toBe('unbound');
    const entries = await AuditLogModel.countDocuments({
      action: 'file.approval_invalidated',
      entityId: fileId,
    });
    expect(entries).toBe(1);
  });
});

describe('Google-native documents', () => {
  /**
   * The case the whole design turns on. `files.get` does not populate `headRevisionId` for a
   * Doc, so an implementation that compared *that* would see `undefined === undefined` and
   * call an edited document unchanged, forever. Reading the head revision instead is what
   * makes this detectable — and this test fails if anyone ever "simplifies" it back.
   */
  it('detects an edit to a Doc, which has no headRevisionId at all', async () => {
    if (skipUnlessDb()) return;
    const { fileId, versionId } = await approvedFile('native');
    const { approvals } = await services();

    // Turn the stored object into a Google Doc: no bytes, native mime type. This is the
    // shape a natively-created document has once it is adopted.
    const version = await FileVersionModel.findById(versionId).lean();
    const native = drive.seedNativeDocument({ name: 'protocol', parentId: DRIVE_ROOT });

    await FileVersionModel.updateOne(
      { _id: versionId },
      {
        $set: {
          googleDriveFileId: native.id,
          isGoogleNative: true,
          googleNativeKind: 'document',
          approvedRevisionId: (await drive.getHeadRevision(native.id)).id,
        },
      },
    );
    await FileModel.updateOne({ _id: fileId }, { $set: { hasGoogleNativeContent: true } });
    expect(version!.googleDriveFileId).toBeTruthy();

    // Confirms the premise rather than assuming it: Drive really does leave this empty.
    expect((await drive.getFile(native.id)).headRevisionId).toBeUndefined();

    expect((await approvals.checkApprovedVersion(versionId)).outcome).toBe('unchanged');

    drive.editInDrive(native.id);
    expect((await approvals.checkApprovedVersion(versionId)).outcome).toBe('superseded');
  });
});

describe('opening a native document in the Google editor', () => {
  async function nativeApprovedFile(name: string): Promise<{ fileId: string; versionId: string }> {
    const approved = await approvedFile(name);
    const native = drive.seedNativeDocument({ name, parentId: DRIVE_ROOT });
    await FileVersionModel.updateOne(
      { _id: approved.versionId },
      {
        $set: {
          googleDriveFileId: native.id,
          googleDriveWebViewLink: `https://docs.google.com/document/d/${native.id}/edit`,
          isGoogleNative: true,
          googleNativeKind: 'document',
        },
      },
    );
    return approved;
  }

  it('is refused unless the deployment has switched it on', async () => {
    if (skipUnlessDb()) return;
    const { fileId } = await nativeApprovedFile('editor-off');
    const alice = await actorFor(fixture.users.scientistA);
    const { downloadService } = await import('@/server/services/download.service');

    // The default. Employees' own Google accounts are not necessarily members of the Shared
    // Drive, and a button leading to a Google permission-denied page is worse than none.
    await expect(
      downloadService.openInGoogleEditor(alice, fileId, {}, TEST_META),
    ).rejects.toThrow(/has not been switched on/i);
  });

  it('returns the document URL when it is on, and records the access', async () => {
    if (skipUnlessDb()) return;
    process.env.GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED = 'true';
    resetEnvCache();

    const { fileId } = await nativeApprovedFile('editor-on');
    const alice = await actorFor(fixture.users.scientistA);
    const { downloadService } = await import('@/server/services/download.service');

    const opened = await downloadService.openInGoogleEditor(alice, fileId, {}, TEST_META);
    expect(opened.url).toContain('docs.google.com');

    // §11: application access to a natively-created document is recorded, because once the
    // redirect is followed this application can observe nothing at all.
    const entry = await AuditLogModel.findOne({ action: 'file.preview', entityId: fileId })
      .sort({ createdAt: -1 })
      .lean();
    expect((entry!.newValue as { openedIn?: string }).openedIn).toBe('google_editor');
  });

  it('refuses for an ordinary uploaded file, rather than guessing a URL', async () => {
    if (skipUnlessDb()) return;
    process.env.GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED = 'true';
    resetEnvCache();

    const { fileId } = await approvedFile('not-native');
    const alice = await actorFor(fixture.users.scientistA);
    const { downloadService } = await import('@/server/services/download.service');

    await expect(
      downloadService.openInGoogleEditor(alice, fileId, {}, TEST_META),
    ).rejects.toThrow(/does not open in a Google editor/i);
  });

  it('refuses somebody who may not read the file at all', async () => {
    if (skipUnlessDb()) return;
    process.env.GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED = 'true';
    resetEnvCache();

    const { fileId } = await nativeApprovedFile('editor-forbidden');
    const outsider = await actorFor(fixture.users.noRole);
    const { downloadService } = await import('@/server/services/download.service');

    // The permission check happens before the Drive link is ever resolved, so a guessed id
    // reaches nothing — the same rule download and preview have always obeyed.
    await expect(
      downloadService.openInGoogleEditor(outsider, fileId, {}, TEST_META),
    ).rejects.toMatchObject({ status: expect.any(Number) });
  });
});

describe('deciding on a document that moved underneath the request', () => {
  it('refuses to approve content that changed since it was sent for review', async () => {
    if (skipUnlessDb()) return;
    const { reviewService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folder = await departmentFolder(alice, 'Moved under review');
    const uploaded = await upload(alice, folder, 'moving.pdf', pdf('moving'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [fixture.users.scientistB] },
      TEST_META,
    );

    const version = await FileVersionModel.findById(uploaded.versionId).lean();
    drive.editInDrive(version!.googleDriveFileId!, Buffer.from('edited mid-review'));

    await expect(
      reviewService.decide(bob, review.id, { decision: 'approve' }, TEST_META),
    ).rejects.toMatchObject({ code: 'CONTENT_CHANGED' });
  });

  /**
   * Rejecting an edited document is perfectly sensible — the reviewer has seen enough — and
   * blocking it would leave the request stuck open with no way to close it.
   */
  it('still allows changes to be requested on it', async () => {
    if (skipUnlessDb()) return;
    const { reviewService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folder = await departmentFolder(alice, 'Rejectable');
    const uploaded = await upload(alice, folder, 'reject.pdf', pdf('reject'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [fixture.users.scientistB] },
      TEST_META,
    );

    const version = await FileVersionModel.findById(uploaded.versionId).lean();
    drive.editInDrive(version!.googleDriveFileId!, Buffer.from('edited mid-review'));

    const decided = await reviewService.decide(
      bob,
      review.id,
      { decision: 'request_changes', comment: 'This changed while I was reading it.' },
      TEST_META,
    );
    expect(decided.status).toBe('changes_requested');
  });
});

describe('the sweep', () => {
  it('leaves an unchanged approval completely alone', async () => {
    if (skipUnlessDb()) return;
    const { versionId } = await approvedFile('untouched');
    const { approvals } = await services();

    const before = await FileVersionModel.findById(versionId).lean();
    const summary = await approvals.sweepRemoteApprovals({ limit: 50 });

    expect(summary.superseded).toBe(0);
    const after = await FileVersionModel.findById(versionId).lean();
    expect(after!.isApproved).toBe(true);
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  });

  it('finds an edited document without being told which one', async () => {
    if (skipUnlessDb()) return;
    const { fileId, driveFileId } = await approvedFile('swept');
    const { approvals } = await services();

    drive.editInDrive(driveFileId!, Buffer.from('changed'));

    const summary = await approvals.sweepRemoteApprovals({ limit: 50 });
    expect(summary.superseded).toBeGreaterThanOrEqual(1);

    const file = await FileModel.findById(fileId).lean();
    expect(file!.approvalStatus).toBe('none');
  });

  /**
   * The most important negative case in this file. "Drive did not answer" must never be
   * recorded as "the document is fine" — an outage would otherwise silently certify the
   * entire corpus.
   */
  it('keeps the approval when Drive cannot be reached, and says so', async () => {
    if (skipUnlessDb()) return;
    const { versionId } = await approvedFile('outage');
    const { approvals } = await services();

    drive.failNext(
      'getHeadRevision',
      new DriveApiError({ status: 503, message: 'Backend Error', reason: 'backendError' }),
    );

    const result = await approvals.checkApprovedVersion(versionId);
    expect(result.outcome).toBe('unavailable');

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.isApproved).toBe(true);
    expect(version!.approvalSupersededAt).toBeNull();
  });

  /**
   * §16: a missing Drive object never removes a record, and it is not an approval failure
   * either. The content did not change — it became unreachable, and the two need different
   * responses.
   */
  it('flags a missing document as a storage conflict rather than a stale approval', async () => {
    if (skipUnlessDb()) return;
    const { versionId, driveFileId } = await approvedFile('vanished');
    const { approvals } = await services();

    await drive.deleteFile(driveFileId!);

    const result = await approvals.checkApprovedVersion(versionId);
    expect(result.outcome).toBe('missing');

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.isApproved).toBe(true);
    expect(version!.syncStatus).toBe('conflict');
  });

  /**
   * An approval granted before Phase 8 has no revision to compare against. Inventing a
   * mismatch would send every historic approval back to review over a change that never
   * happened; treating it as permanently matching would leave it unwatched forever.
   */
  it('adopts the current revision for an approval that predates the binding', async () => {
    if (skipUnlessDb()) return;
    const { versionId } = await approvedFile('legacy');
    const { approvals } = await services();

    // Exactly what such a row looks like: approved, in Drive, no binding.
    await FileVersionModel.updateOne(
      { _id: versionId },
      { $set: { approvedRevisionId: null, approvedContentModifiedAt: null } },
    );

    expect((await approvals.checkApprovedVersion(versionId)).outcome).toBe('unchanged');

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.isApproved).toBe(true);
    expect(version!.approvedRevisionId).toBeTruthy();

    // And from then on it is watched like any other.
    drive.editInDrive(version!.googleDriveFileId!, Buffer.from('changed'));
    expect((await approvals.checkApprovedVersion(versionId)).outcome).toBe('superseded');
  });

  it('does nothing at all on a deployment without Drive', async () => {
    if (skipUnlessDb()) return;
    process.env.GOOGLE_DRIVE_STORAGE_ENABLED = 'false';
    process.env.DEFAULT_STORAGE_PROVIDER = 'local';
    resetEnvCache();

    const { approvals } = await services();
    const summary = await approvals.sweepRemoteApprovals({ limit: 50 });

    expect(summary.checked).toBe(0);
    expect(drive.calls).not.toContain('getHeadRevision');
  });
});
