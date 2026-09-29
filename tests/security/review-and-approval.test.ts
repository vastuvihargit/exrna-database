/**
 * Review and approval.
 *
 * The brief's acceptance criteria for this phase are all about what *cannot* happen:
 * a reviewer approving something other than a specific version, an approved version being
 * silently replaced, an unauthorized approval, or a change after approval that does not
 * produce a new version. Each has a test here.
 *
 * The self-approval case is the one worth reading twice. It is enforced in the service
 * rather than by the permission layer, because the permission layer has no concept of
 * "but it's your own file" — a scientist who also holds a department approver role would
 * otherwise pass every check on their own submission.
 */
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';

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

  // Bob needs *approval* rights in Alice's department, which the `reviewer` role
  // deliberately does not carry — a reviewer may raise concerns (`review.perform`) but
  // only management ranks may sign off (`review.approve`). So he gets an R&D Head grant
  // scoped to molbio.
  //
  // Granted through the real repository rather than by hand-building an Actor, so the
  // test cannot give itself a permission the login path would not produce.
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

async function services() {
  return {
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    fileService: (await import('@/server/services/file.service')).fileService,
    folderService: (await import('@/server/services/folder.service')).folderService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    reviewService: (await import('@/server/services/review.service')).reviewService,
    versionService: (await import('@/server/services/version.service')).versionService,
    sharingService: (await import('@/server/services/sharing.service')).sharingService,
    versionRepository: await import('@/server/repositories/file-version.repository'),
    reviewRepository: await import('@/server/repositories/review.repository'),
  };
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('1 0 obj<<>>endobj\n%%EOF\n')]);

function pdf(marker: string): Buffer {
  return Buffer.concat([PDF, Buffer.from(`% ${marker}\n`)]);
}

/**
 * A folder in the molbio department drive, so role scope — not ownership — is what gives
 * the reviewer access. Reviewing inside a personal drive would prove nothing about roles.
 */
async function departmentFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getDepartmentRoot(actor, fixture.departments.molbio);
  const folder = await folderService.createFolder(actor, { name, parentFolderId: root.id }, TEST_META);
  return folder.id;
}

async function upload(
  actor: Actor,
  folderId: string,
  filename: string,
  content: Buffer,
  extra: { targetFileId?: string } = {},
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

describe('a review is of one exact version', () => {
  it('pins the version and its checksum at submission time', async () => {
    if (skipUnlessDb()) return;
    const { reviewService, versionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await departmentFolder(alice, 'Review pinning');
    const uploaded = await upload(alice, folderId, 'protocol.pdf', pdf('v1'));
    const version = await versionRepository.findCurrent(uploaded.fileId);

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [fixture.users.scientistB] },
      TEST_META,
    );

    expect(review.versionId).toBe(version!.id);
    expect(review.versionNumber).toBe(1);
    expect(review.versionChecksum).toBe(version!.checksumSha256);
  });

  it('cancels an open review when a new version is uploaded', async () => {
    if (skipUnlessDb()) return;
    const { reviewService, reviewRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await departmentFolder(alice, 'Review superseded');
    const uploaded = await upload(alice, folderId, 'superseded.pdf', pdf('a'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [fixture.users.scientistB] },
      TEST_META,
    );

    // Uploading again makes the reviewed bytes stale. Leaving the request open would let
    // a reviewer approve superseded content.
    await upload(alice, folderId, 'superseded.pdf', pdf('b'), { targetFileId: uploaded.fileId });

    const after = await reviewRepository.findById(review.id);
    expect(after!.status).toBe('cancelled');
  });

  it('refuses a second open review on the same version', async () => {
    if (skipUnlessDb()) return;
    const { reviewService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await departmentFolder(alice, 'Review duplicate');
    const uploaded = await upload(alice, folderId, 'duplicate.pdf', pdf('once'));

    await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [fixture.users.scientistB] },
      TEST_META,
    );

    await expect(
      reviewService.submitForReview(
        alice,
        uploaded.fileId,
        { reviewerUserIds: [fixture.users.scientistB] },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('nobody approves their own work', () => {
  it('refuses to name the submitter as a reviewer', async () => {
    if (skipUnlessDb()) return;
    const { reviewService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await departmentFolder(alice, 'Self reviewer');
    const uploaded = await upload(alice, folderId, 'self.pdf', pdf('self'));

    await expect(
      reviewService.submitForReview(
        alice,
        uploaded.fileId,
        { reviewerUserIds: [alice.userId] },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a decision from the file’s owner even when they hold approval rights', async () => {
    if (skipUnlessDb()) return;
    const { reviewService, reviewRepository } = await services();
    const head = await actorFor(fixture.users.deptAHead);

    const folderId = await departmentFolder(head, 'Owner decision guard');
    const uploaded = await upload(head, folderId, 'owned.pdf', pdf('owned'));

    // The head submits their own file, naming Bob — then we add the head to the reviewer
    // list directly in the database, which is the escalation this guard exists to stop.
    // The head holds `review.approve` in this department, so the permission layer alone
    // would let the decision through; only the explicit owner check refuses it.
    const review = await reviewService.submitForReview(
      head,
      uploaded.fileId,
      { reviewerUserIds: [fixture.users.scientistB] },
      TEST_META,
    );

    const { ReviewModel } = await import('@/server/db/models');
    await ReviewModel.updateOne(
      { _id: new Types.ObjectId(review.id) },
      { $push: { reviewerUserIds: new Types.ObjectId(head.userId) } },
    ).exec();

    await expect(
      reviewService.decide(head, review.id, { decision: 'approve' }, TEST_META),
    ).rejects.toMatchObject({ status: 403 });

    // Untouched: the request is still pending and carries no decision.
    const untouched = await reviewRepository.findById(review.id);
    expect(untouched!.status).toBe('pending');
    expect(untouched!.decisions).toHaveLength(0);
  });

  it('refuses a decision from someone who is not a named reviewer', async () => {
    if (skipUnlessDb()) return;
    const { reviewService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const head = await actorFor(fixture.users.deptAHead);

    const folderId = await departmentFolder(alice, 'Unnamed reviewer');
    const uploaded = await upload(alice, folderId, 'unnamed.pdf', pdf('unnamed'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [fixture.users.scientistB] },
      TEST_META,
    );

    // The department head has every permission here — but was not asked.
    await expect(
      reviewService.decide(head, review.id, { decision: 'approve' }, TEST_META),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('approval outcomes', () => {
  it('marks the version approved and locks the file', async () => {
    if (skipUnlessDb()) return;
    const { reviewService, fileService, versionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await departmentFolder(alice, 'Approval outcome');
    const uploaded = await upload(alice, folderId, 'approvable.pdf', pdf('approve-me'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [bob.userId], note: 'Please check the calibration section' },
      TEST_META,
    );

    const decided = await reviewService.decide(
      bob,
      review.id,
      { decision: 'approve', comment: 'Calibration is sound' },
      TEST_META,
    );

    expect(decided.status).toBe('approved');
    expect(decided.decisions[0]!.reviewerUserId).toBe(bob.userId);
    // The evidence the brief asks for.
    expect(decided.decisions[0]!.decidedAt).toBeInstanceOf(Date);

    const file = await fileService.getFile(alice, uploaded.fileId);
    expect(file.approvalStatus).toBe('approved');
    expect(file.approvedVersionId).toBe(review.versionId);

    const version = await versionRepository.findById(review.versionId);
    expect(version!.isApproved).toBe(true);
    expect(version!.label).toBe('approved');
    expect(version!.approvedBy).toBe(bob.userId);

    // Read-only: renaming an approved file is refused, with a message pointing at the
    // action that *is* allowed.
    await expect(
      fileService.renameFile(alice, uploaded.fileId, 'renamed.pdf', TEST_META),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('records the reviewer’s IP and user agent with the decision', async () => {
    if (skipUnlessDb()) return;
    const { reviewService, reviewRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await departmentFolder(alice, 'Decision evidence');
    const uploaded = await upload(alice, folderId, 'evidence.pdf', pdf('evidence'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [bob.userId] },
      TEST_META,
    );

    await reviewService.decide(bob, review.id, { decision: 'approve' }, TEST_META);

    const stored = await reviewRepository.findById(review.id);
    expect(stored!.decisions[0]!.ip).toBe(TEST_META.ip);
    expect(stored!.decisions[0]!.userAgent).toBe(TEST_META.userAgent);
    expect(stored!.decisions[0]!.reviewerEmail).toBe(bob.email);
  });

  it('lets a new version replace an approved one only by resetting the approval', async () => {
    if (skipUnlessDb()) return;
    const { reviewService, fileService, versionRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await departmentFolder(alice, 'Approval reset');
    const uploaded = await upload(alice, folderId, 'resettable.pdf', pdf('r1'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [bob.userId] },
      TEST_META,
    );
    await reviewService.decide(bob, review.id, { decision: 'approve' }, TEST_META);

    // Uploading a new version is the sanctioned way to change an approved file.
    await upload(alice, folderId, 'resettable.pdf', pdf('r2'), { targetFileId: uploaded.fileId });

    const file = await fileService.getFile(alice, uploaded.fileId);
    expect(file.approvalStatus).toBe('none');
    expect(file.reviewStatus).toBe('draft');

    // But the approved version keeps its record forever — the whole point.
    const approvedVersion = await versionRepository.findById(review.versionId);
    expect(approvedVersion!.isApproved).toBe(true);
    expect(approvedVersion!.label).toBe('approved');
    expect(approvedVersion!.checksumSha256).toBe(review.versionChecksum);
  });

  it('closes the request on a rejection without collecting the other approvals', async () => {
    if (skipUnlessDb()) return;
    const { reviewService, fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await departmentFolder(alice, 'Rejection closes');
    const uploaded = await upload(alice, folderId, 'rejectable.pdf', pdf('reject'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [bob.userId] },
      TEST_META,
    );

    const decided = await reviewService.decide(
      bob,
      review.id,
      { decision: 'reject', comment: 'Raw data does not support the conclusion' },
      TEST_META,
    );

    expect(decided.status).toBe('rejected');

    const file = await fileService.getFile(alice, uploaded.fileId);
    expect(file.approvalStatus).toBe('rejected');

    // A closed request takes no further decisions.
    await expect(
      reviewService.decide(bob, review.id, { decision: 'approve' }, TEST_META),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('keeps a two-approval request open after the first approval', async () => {
    if (skipUnlessDb()) return;
    const { reviewService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await departmentFolder(alice, 'Two approvals');
    const uploaded = await upload(alice, folderId, 'two-sig.pdf', pdf('two'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      {
        reviewerUserIds: [bob.userId, fixture.users.deptAHead],
        requiredApprovals: 2,
      },
      TEST_META,
    );

    const first = await reviewService.decide(bob, review.id, { decision: 'approve' }, TEST_META);
    expect(first.status).toBe('pending');
    expect(first.approvalsSoFar).toBe(1);

    const head = await actorFor(fixture.users.deptAHead);
    const second = await reviewService.decide(head, review.id, { decision: 'approve' }, TEST_META);
    expect(second.status).toBe('approved');
    expect(second.approvalsSoFar).toBe(2);
  });

  it('refuses a second decision from the same reviewer', async () => {
    if (skipUnlessDb()) return;
    const { reviewService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await departmentFolder(alice, 'Double decision');
    const uploaded = await upload(alice, folderId, 'double.pdf', pdf('double'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [bob.userId, fixture.users.deptAHead], requiredApprovals: 2 },
      TEST_META,
    );

    await reviewService.decide(bob, review.id, { decision: 'approve' }, TEST_META);

    await expect(
      reviewService.decide(bob, review.id, { decision: 'approve' }, TEST_META),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('the pending-review dashboard', () => {
  it('lists only requests naming the caller, and hides ones they can no longer open', async () => {
    if (skipUnlessDb()) return;
    const { reviewService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);
    const newcomer = await actorFor(fixture.users.noRole);

    const folderId = await departmentFolder(alice, 'Dashboard scope');
    const uploaded = await upload(alice, folderId, 'dashboard.pdf', pdf('dash'));

    const review = await reviewService.submitForReview(
      alice,
      uploaded.fileId,
      { reviewerUserIds: [bob.userId] },
      TEST_META,
    );

    const forBob = await reviewService.listPendingForMe(bob, { page: 1, pageSize: 25 });
    expect(forBob.items.map((entry) => entry.id)).toContain(review.id);

    // Not a reviewer — sees nothing, and does not learn the file's name from a count.
    const forNewcomer = await reviewService.listPendingForMe(newcomer, { page: 1, pageSize: 25 });
    expect(forNewcomer.items.map((entry) => entry.id)).not.toContain(review.id);
  });
});
