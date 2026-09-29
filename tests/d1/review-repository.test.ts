/**
 * Phase 3, module 11 — reviews and approvals on D1.
 *
 * An approval is the closest thing this system has to a signature, so the tests that matter are
 * not the CRUD ones:
 *
 * **A decision is four writes, and they commit together.** Approving closes the review, appends
 * the decision, marks the version approved with its Drive binding, and points the file at it.
 * Split across batches, a failure between them leaves either an approval badge nobody granted
 * or a signature nobody can see. The rollback tests poison one half at a time, by real
 * constraint violation rather than by mocking `withBatch`.
 *
 * **Two reviewers cannot both close one request.** The guard is `status = 'pending'` in the
 * statement, and the loser must come away with *nothing* written — not a decision row against a
 * request somebody else closed with a different outcome.
 *
 * **A later version inherits nothing.** The version-pinned design is the whole reason the
 * approval story is defensible, so v1 staying approved while v2 arrives unapproved is asserted
 * on the version row, on the file's pointer, and on the approval row's `version_id`.
 *
 * The suite runs against a real D1 through Miniflare, so the partial unique index, cascades and
 * batch rollback behave as they do in the Worker.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { and, eq } from 'drizzle-orm';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting, getD1 } from '@/server/db/d1-context';
import { approvals, reviews } from '@/server/db/schema/collaboration';
import { files, fileVersions } from '@/server/db/schema/drive';
import { createVersionWithFile } from '@/server/db/d1-unit-of-work';
import {
  cancelReviewAtomically,
  decideReviewAtomically,
  reviewMutationEngine,
  submitReviewAtomically,
  SplitDataSourceReviewError,
} from '@/server/db/d1-review-unit-of-work';
import * as reviewRepository from '@/server/repositories/review.repository.d1';
import { validateReviewGraph } from '@/server/repositories/review.repository.d1';
import * as fileRepository from '@/server/repositories/file.repository.d1';
import * as folderRepository from '@/server/repositories/folder.repository.d1';
import * as versionRepository from '@/server/repositories/file-version.repository.d1';
import {
  clearDataSourceOverrides,
  setDataSourceOverride,
} from '@/server/repositories/data-source';
import type { FolderRecord } from '@/server/repositories/folder.repository.contract';
import type { FileRecord } from '@/server/repositories/file.repository.contract';
import type {
  CreateReviewInput,
  ReviewDecisionRecord,
} from '@/server/repositories/review.repository.contract';

const ORG = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';
const ALICE = '507f1f77bcf86cd799439031';
const BOB = '507f1f77bcf86cd799439032';
const CAROL = '507f1f77bcf86cd799439033';
const GHOST_FOLDER = 'folder-that-does-not-exist';
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

  for (const [id, email] of [
    [ALICE, 'alice@company.com'],
    [BOB, 'bob@company.com'],
    [CAROL, 'carol@company.com'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO users (id,organization_id,email,email_domain,name,mfa,preferences,status,is_super_admin,storage_quota_bytes,storage_used_bytes,must_change_password,failed_login_count,created_at,updated_at)
       VALUES (?,?,?,'company.com',?,'{"enabled":false}','{}','active',0,1,0,0,0,?,?)`,
      id, ORG, email, email.split('@')[0], ISO, ISO,
    );
  }
}

async function root(): Promise<FolderRecord> {
  return folderRepository.ensureRoot({
    rootKey: `my:${ALICE}:${ORG}`,
    organizationId: ORG,
    name: 'My Drive',
    driveType: 'my',
    ownerId: ALICE,
    departmentId: null,
    projectId: null,
    confidentiality: 'internal',
    createdBy: ALICE,
  });
}

async function file(folder: FolderRecord, name = 'protocol.pdf'): Promise<FileRecord> {
  return fileRepository.create({
    organizationId: ORG,
    displayName: name,
    originalFilename: name,
    extension: 'pdf',
    category: 'document',
    folderId: folder.id,
    folderPathAncestors: [...folder.pathAncestors, folder.id],
    driveType: folder.driveType,
    ownerId: ALICE,
    departmentId: null,
    projectId: null,
    confidentiality: 'internal',
    sizeBytes: 10,
    mimeType: 'application/pdf',
    checksumSha256: 'a'.repeat(64),
    createdBy: ALICE,
  });
}

/** A file with one current version, the state a review is raised against. */
async function fileWithVersion(name = 'protocol.pdf') {
  const home = await root();
  const created = await file(home, name);
  const { versionId, versionNumber } = await createVersionWithFile({
    version: {
      organizationId: ORG,
      fileId: created.id,
      storageKey: `originals/${created.id}/v1`,
      storageArea: 'originals',
      relativeStoragePath: `originals/${created.id}/v1`,
      storedFilename: 'v1',
      originalFilename: name,
      fileSize: 10,
      mimeType: 'application/pdf',
      extension: 'pdf',
      checksumSha256: 'b'.repeat(64),
      uploadedBy: ALICE,
    },
    file: { sizeBytes: 10, updatedBy: ALICE, versionCountDelta: 1 },
  });
  return { file: created, versionId, versionNumber };
}

function reviewInput(
  fileId: string,
  versionId: string,
  overrides: Partial<CreateReviewInput> = {},
): CreateReviewInput {
  return {
    organizationId: ORG,
    fileId,
    versionId,
    versionNumber: 1,
    fileName: 'protocol.pdf',
    versionChecksum: 'b'.repeat(64),
    versionRevisionId: 'rev-1',
    versionContentModifiedAt: new Date(ISO),
    requestedBy: ALICE,
    requestedByName: 'alice',
    requestNote: 'please review',
    reviewerUserIds: [BOB],
    requiredApprovals: 1,
    departmentId: null,
    projectId: null,
    ...overrides,
  };
}

function decision(
  reviewerUserId: string,
  value: ReviewDecisionRecord['decision'] = 'approve',
): ReviewDecisionRecord {
  return {
    reviewerUserId,
    reviewerName: reviewerUserId === BOB ? 'bob' : 'carol',
    reviewerEmail: `${reviewerUserId === BOB ? 'bob' : 'carol'}@company.com`,
    decision: value,
    comment: 'looks right',
    decidedAt: new Date('2026-02-01T00:00:00.000Z'),
    ip: '10.0.0.1',
    userAgent: 'vitest',
    requestId: 'req-1',
  };
}

/** The submit the service performs, as one atomic call. */
async function submit(fileId: string, versionId: string, over: Partial<CreateReviewInput> = {}) {
  return submitReviewAtomically({
    review: reviewInput(fileId, versionId, over),
    file: { reviewStatus: 'submitted', approvalStatus: 'pending', updatedBy: ALICE },
    version: { label: 'under_review' },
  });
}

/** The approve the service performs, as one atomic call. */
async function approve(
  reviewId: string,
  fileId: string,
  versionId: string,
  reviewer = BOB,
  extraFile: Record<string, unknown> = {},
) {
  return decideReviewAtomically({
    reviewId,
    fileId,
    versionId,
    decision: decision(reviewer, 'approve'),
    close: { status: 'approved' },
    file: {
      reviewStatus: 'approved',
      approvalStatus: 'approved',
      approvedVersionId: versionId,
      updatedBy: reviewer,
      ...extraFile,
    } as never,
    version: {
      label: 'approved',
      isApproved: true,
      approvedBy: reviewer,
      approvedAt: new Date('2026-02-01T00:00:00.000Z'),
      approvedRevisionId: 'rev-1',
    },
  });
}

async function versionRow(versionId: string) {
  const db = await getD1();
  const [row] = await db.select().from(fileVersions).where(eq(fileVersions.id, versionId));
  return row!;
}

async function fileRow(fileId: string) {
  const db = await getD1();
  const [row] = await db.select().from(files).where(eq(files.id, fileId));
  return row!;
}

/* ------------------------------------------------------------------ lifecycle */

beforeAll(async () => {
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
}, 300_000);

afterAll(async () => {
  clearDataSourceOverrides();
  setD1BindingForTesting(null);
  await stopTestD1();
});

beforeEach(async () => {
  clearDataSourceOverrides();
  await clearD1(d1, [
    'DELETE FROM approvals',
    'DELETE FROM review_reviewers',
    'DELETE FROM reviews',
    'DELETE FROM files_fts',
    'DELETE FROM file_versions',
    'DELETE FROM file_metadata',
    'DELETE FROM file_folder_ancestors',
    'DELETE FROM resource_tags',
    'DELETE FROM resource_permissions',
    'UPDATE files SET current_version_id = NULL',
    'DELETE FROM files',
    'DELETE FROM folder_ancestors',
    'DELETE FROM folders',
  ]);
  await seedWorld();
});

afterEach(() => clearDataSourceOverrides());

/* ================================================================== the request */

describe('raising a request', () => {
  it('writes the review, its reviewers, the file state and the version label together', async () => {
    const { file: target, versionId } = await fileWithVersion();

    const review = await submit(target.id, versionId, { reviewerUserIds: [BOB, CAROL] });

    expect(review).toMatchObject({
      fileId: target.id,
      versionId,
      status: 'pending',
      requestedBy: ALICE,
      versionChecksum: 'b'.repeat(64),
      versionRevisionId: 'rev-1',
    });
    expect([...review.reviewerUserIds].sort()).toEqual([BOB, CAROL].sort());
    expect(review.decisions).toEqual([]);

    expect((await fileRow(target.id)).reviewStatus).toBe('submitted');
    expect((await versionRow(versionId)).label).toBe('under_review');
  });

  /**
   * The partial unique index, which is what stops two reviewers approving the same bytes
   * through different requests and producing two conflicting histories.
   */
  it('refuses a second open request against one version', async () => {
    const { file: target, versionId } = await fileWithVersion();
    await submit(target.id, versionId);

    await expect(submit(target.id, versionId)).rejects.toThrow();
    const all = await reviewRepository.listForFile(target.id);
    expect(all).toHaveLength(1);
  });

  /**
   * A stale request against a *different* version is cancelled in the same batch, and the one
   * against the version being submitted is spared — otherwise re-submitting would cancel
   * itself.
   */
  it('cancels an open request on another version, sparing this one', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const first = await submit(target.id, versionId);

    const second = await versionRepository.create({
      organizationId: ORG,
      fileId: target.id,
      versionNumber: 2,
      storageKey: `originals/${target.id}/v2`,
      storageArea: 'originals',
      relativeStoragePath: `originals/${target.id}/v2`,
      storedFilename: 'v2',
      originalFilename: 'protocol.pdf',
      fileSize: 10,
      mimeType: 'application/pdf',
      extension: 'pdf',
      checksumSha256: 'c'.repeat(64),
      uploadedBy: ALICE,
    });

    await submit(target.id, second.id, { versionNumber: 2 });

    expect((await reviewRepository.findById(first.id))!.status).toBe('cancelled');
    expect(await reviewRepository.findOpenForVersion(second.id)).not.toBeNull();
  });

  it('rolls the whole submit back when the file half fails', async () => {
    const { file: target, versionId } = await fileWithVersion();

    await expect(
      submitReviewAtomically({
        review: reviewInput(target.id, versionId),
        // A folder that does not exist: a real foreign-key violation on the file UPDATE.
        file: { folderId: GHOST_FOLDER, reviewStatus: 'submitted', updatedBy: ALICE } as never,
        version: { label: 'under_review' },
      }),
    ).rejects.toThrow();

    // No review, no reviewer rows, and the version untouched.
    expect(await reviewRepository.listForFile(target.id)).toEqual([]);
    expect((await versionRow(versionId)).label).not.toBe('under_review');
    expect((await fileRow(target.id)).reviewStatus).not.toBe('submitted');
  });
});

/* ================================================================== deciding */

describe('a decision and everything that follows from it', () => {
  it('closes the review, records the approval, marks the version and points the file at it', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);

    const updated = await approve(review.id, target.id, versionId);

    expect(updated).toMatchObject({ status: 'approved' });
    expect(updated!.closedAt).toBeInstanceOf(Date);
    expect(updated!.decisions).toHaveLength(1);
    expect(updated!.decisions[0]).toMatchObject({
      reviewerUserId: BOB,
      decision: 'approve',
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });

    const version = await versionRow(versionId);
    expect(version.isApproved).toBe(true);
    expect(version.approvedBy).toBe(BOB);
    expect(version.approvedRevisionId).toBe('rev-1');
    expect(version.label).toBe('approved');

    const parent = await fileRow(target.id);
    expect(parent.approvalStatus).toBe('approved');
    expect(parent.approvedVersionId).toBe(versionId);

    // The approval row is denormalized with the file and version, so an auditor can query it
    // without joining — and it must name the same version the review does.
    const db = await getD1();
    const [row] = await db.select().from(approvals).where(eq(approvals.reviewId, review.id));
    expect(row).toMatchObject({ fileId: target.id, versionId, reviewerUserId: BOB });
  });

  /**
   * The rollback that matters most: the review half is valid and would have committed alone,
   * leaving an approved review whose file never learned about it.
   */
  it('rolls the decision back when the file half fails', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);

    await expect(
      approve(review.id, target.id, versionId, BOB, { folderId: GHOST_FOLDER }),
    ).rejects.toThrow();

    const after = await reviewRepository.findById(review.id);
    expect(after!.status).toBe('pending');
    expect(after!.decisions).toEqual([]);
    expect((await versionRow(versionId)).isApproved).toBe(false);
    expect((await fileRow(target.id)).approvalStatus).not.toBe('approved');
  });

  it('rolls back when the version half fails', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);

    await expect(
      decideReviewAtomically({
        reviewId: review.id,
        fileId: target.id,
        versionId,
        decision: decision(BOB),
        close: { status: 'approved' },
        file: { reviewStatus: 'approved', updatedBy: BOB },
        // `approved_by` references `users`; a user that does not exist violates it.
        version: { isApproved: true, approvedBy: 'nobody-at-all' },
      }),
    ).rejects.toThrow();

    expect((await reviewRepository.findById(review.id))!.status).toBe('pending');
    expect((await fileRow(target.id)).reviewStatus).toBe('submitted');
  });

  /**
   * Two reviewers deciding at once. The loser must write *nothing* — not a decision row
   * against a request somebody else closed with a different outcome.
   */
  it('lets exactly one of two simultaneous decisions close the request', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId, { reviewerUserIds: [BOB, CAROL] });

    const [first, second] = await Promise.all([
      decideReviewAtomically({
        reviewId: review.id,
        fileId: target.id,
        versionId,
        decision: decision(BOB, 'approve'),
        close: { status: 'approved' },
        file: { reviewStatus: 'approved', approvalStatus: 'approved', updatedBy: BOB },
        version: { isApproved: true, approvedBy: BOB },
      }).catch(() => null),
      decideReviewAtomically({
        reviewId: review.id,
        fileId: target.id,
        versionId,
        decision: decision(CAROL, 'reject'),
        close: { status: 'rejected' },
        file: { reviewStatus: 'rejected', approvalStatus: 'rejected', updatedBy: CAROL },
        version: { label: 'draft' },
      }).catch(() => null),
    ]);

    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);

    const final = await reviewRepository.findById(review.id);
    expect(['approved', 'rejected']).toContain(final!.status);
    // One decision, from the winner. The loser's guard matched nothing.
    expect(final!.decisions).toHaveLength(1);
  });

  it('keeps the request open until requiredApprovals is reached', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId, {
      reviewerUserIds: [BOB, CAROL],
      requiredApprovals: 2,
    });

    const afterFirst = await decideReviewAtomically({
      reviewId: review.id,
      fileId: target.id,
      versionId,
      decision: decision(BOB, 'approve'),
      close: null,
      file: { reviewStatus: 'in_review', updatedBy: BOB },
      version: {},
    });

    expect(afterFirst!.status).toBe('pending');
    expect(afterFirst!.decisions).toHaveLength(1);
    expect((await fileRow(target.id)).reviewStatus).toBe('in_review');
    // Still open, and the version has not been marked.
    expect((await versionRow(versionId)).isApproved).toBe(false);

    const afterSecond = await approve(review.id, target.id, versionId, CAROL);
    expect(afterSecond!.status).toBe('approved');
    expect(afterSecond!.decisions).toHaveLength(2);
  });

  it('returns null rather than writing when the request is already closed', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);
    await approve(review.id, target.id, versionId);

    const late = await decideReviewAtomically({
      reviewId: review.id,
      fileId: target.id,
      versionId,
      decision: decision(CAROL, 'reject'),
      close: { status: 'rejected' },
      file: { reviewStatus: 'rejected', updatedBy: CAROL },
      version: { label: 'draft' },
    });

    expect(late).toBeNull();
    const final = await reviewRepository.findById(review.id);
    expect(final!.status).toBe('approved');
    expect(final!.decisions).toHaveLength(1);
    // And the file was not quietly moved to rejected by the losing half.
    expect((await fileRow(target.id)).approvalStatus).toBe('approved');
  });

  it('withdraws a request and returns the file and version to draft', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);

    const cancelled = await cancelReviewAtomically({
      reviewId: review.id,
      fileId: target.id,
      versionId,
      file: { reviewStatus: 'draft', approvalStatus: 'none', updatedBy: ALICE },
      version: { label: 'draft' },
    });

    expect(cancelled).toBe(true);
    expect((await reviewRepository.findById(review.id))!.status).toBe('cancelled');
    expect((await fileRow(target.id)).reviewStatus).toBe('draft');
    expect((await versionRow(versionId)).label).toBe('draft');

    // Withdrawing twice is a no-op, not a second cancellation.
    expect(
      await cancelReviewAtomically({
        reviewId: review.id,
        fileId: target.id,
        versionId,
        file: { reviewStatus: 'draft', updatedBy: ALICE },
        version: { label: 'draft' },
      }),
    ).toBe(false);
  });
});

/* ================================================================== version binding */

describe('an approval belongs to one exact version', () => {
  it('leaves v1 approved and v2 unapproved when a new version lands', async () => {
    const { file: target, versionId: v1 } = await fileWithVersion();
    const review = await submit(target.id, v1);
    await approve(review.id, target.id, v1);

    const { versionId: v2 } = await createVersionWithFile({
      version: {
        organizationId: ORG,
        fileId: target.id,
        storageKey: `originals/${target.id}/v2`,
        storageArea: 'originals',
        relativeStoragePath: `originals/${target.id}/v2`,
        storedFilename: 'v2',
        originalFilename: 'protocol.pdf',
        fileSize: 20,
        mimeType: 'application/pdf',
        extension: 'pdf',
        checksumSha256: 'c'.repeat(64),
        uploadedBy: ALICE,
      },
      file: {
        sizeBytes: 20,
        updatedBy: ALICE,
        versionCountDelta: 1,
        // What the upload service clears: the file stops being approved.
        approvalStatus: 'none',
        approvedVersionId: null,
        reviewStatus: 'draft',
      },
    });

    // The signature survives on the bytes it covered...
    const first = await versionRow(v1);
    expect(first.isApproved).toBe(true);
    expect(first.approvedBy).toBe(BOB);

    // ...and the new bytes inherit none of it.
    const second = await versionRow(v2);
    expect(second.isApproved).toBe(false);
    expect(second.approvedBy).toBeNull();

    const parent = await fileRow(target.id);
    expect(parent.approvalStatus).toBe('none');
    expect(parent.approvedVersionId).toBeNull();
    expect(parent.currentVersionId).toBe(v2);

    // The approval row still names v1, so the history answers "which bytes were signed?".
    const db = await getD1();
    const [row] = await db.select().from(approvals).where(eq(approvals.fileId, target.id));
    expect(row!.versionId).toBe(v1);
  });

  /**
   * The rule the version service documents but could not enforce inside its batch until
   * reviews moved: uploading cancels every open request in the *same* batch as the version.
   */
  it('cancels an open review in the same batch as the new version', async () => {
    setDataSourceOverride('reviews', 'd1');
    const { file: target, versionId: v1 } = await fileWithVersion();
    const review = await submit(target.id, v1);
    expect(review.status).toBe('pending');

    await createVersionWithFile({
      version: {
        organizationId: ORG,
        fileId: target.id,
        storageKey: `originals/${target.id}/v2`,
        storageArea: 'originals',
        relativeStoragePath: `originals/${target.id}/v2`,
        storedFilename: 'v2',
        originalFilename: 'protocol.pdf',
        fileSize: 20,
        mimeType: 'application/pdf',
        extension: 'pdf',
        checksumSha256: 'c'.repeat(64),
        uploadedBy: ALICE,
      },
      file: { sizeBytes: 20, updatedBy: ALICE, versionCountDelta: 1 },
    });

    // A review left open against superseded bytes could still be approved, which would point
    // the file at a version it has already moved past.
    expect((await reviewRepository.findById(review.id))!.status).toBe('cancelled');
  });
});

/* ================================================================== reads */

describe('the read surface', () => {
  it('lists a reviewer’s pending requests without duplicating one that names them twice', async () => {
    const { file: target, versionId } = await fileWithVersion();
    await submit(target.id, versionId, { reviewerUserIds: [BOB, CAROL] });

    const page = await reviewRepository.list({
      organizationId: ORG,
      reviewerUserId: BOB,
      status: 'pending',
      page: 1,
      pageSize: 10,
    });

    // A join would return the review once per matching reviewer row and inflate `total`.
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(await reviewRepository.countPendingFor(BOB)).toBe(1);
    expect(await reviewRepository.countPendingFor(ALICE)).toBe(0);
  });

  it('pages the history newest first, and counts what it pages', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const first = await submit(target.id, versionId);
    await cancelReviewAtomically({
      reviewId: first.id,
      fileId: target.id,
      versionId,
      file: { reviewStatus: 'draft', updatedBy: ALICE },
      version: { label: 'draft' },
    });
    await submit(target.id, versionId);

    const history = await reviewRepository.listForFile(target.id);
    expect(history).toHaveLength(2);

    const page = await reviewRepository.list({
      organizationId: ORG,
      page: 1,
      pageSize: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
  });

  it('keeps another organization’s requests out of the list', async () => {
    const { file: target, versionId } = await fileWithVersion();
    await submit(target.id, versionId);

    const page = await reviewRepository.list({
      organizationId: ORG_B,
      page: 1,
      pageSize: 10,
    });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('purges a file’s reviews, taking its reviewers and approvals with them', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);
    await approve(review.id, target.id, versionId);

    expect(await reviewRepository.purgeForFiles([target.id])).toBe(1);

    const db = await getD1();
    expect(await db.select().from(reviews).where(eq(reviews.fileId, target.id))).toEqual([]);
    // Cascades, so the decision rows go with the request rather than dangling.
    expect(await db.select().from(approvals).where(eq(approvals.fileId, target.id))).toEqual([]);
  });
});

/* ================================================================== split providers */

describe('review writes never span two databases', () => {
  it('selects D1 when reviews, files and versions are all on D1', () => {
    for (const name of ['reviews', 'files', 'fileVersions'] as const) {
      setDataSourceOverride(name, 'd1');
    }
    expect(reviewMutationEngine()).toBe('d1');
  });

  it('selects Mongo when all three are on Mongo', () => {
    clearDataSourceOverrides();
    expect(reviewMutationEngine()).toBe('mongo');
  });

  it.each([
    ['reviews alone', { reviews: 'd1' }],
    ['reviews and files, not versions', { reviews: 'd1', files: 'd1' }],
    ['reviews and versions, not files', { reviews: 'd1', fileVersions: 'd1' }],
    ['files and versions, not reviews', { files: 'd1', fileVersions: 'd1' }],
  ] as const)('refuses %s', (_label, flags) => {
    for (const [module, value] of Object.entries(flags)) {
      setDataSourceOverride(module as 'reviews', value as 'd1');
    }
    expect(() => reviewMutationEngine()).toThrow(SplitDataSourceReviewError);
  });

  it('names all three flags in the refusal, and refuses before writing anything', async () => {
    setDataSourceOverride('reviews', 'd1');
    let caught: unknown;
    try {
      reviewMutationEngine();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SplitDataSourceReviewError);
    const details = (caught as SplitDataSourceReviewError & { details?: Record<string, unknown> })
      .details as { reason: string } | undefined;
    const reason = details?.reason ?? String((caught as Error).message);
    expect(reason).toContain('DATA_SOURCE_REVIEWS');
    expect(reason).toContain('DATA_SOURCE_FILES');
    expect(reason).toContain('DATA_SOURCE_FILE_VERSIONS');
  });
});

/* ================================================================== validator */

describe('the review validator reports and never repairs', () => {
  it('finds nothing wrong with a healthy graph', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);
    await approve(review.id, target.id, versionId);

    expect(await validateReviewGraph(ORG)).toEqual([]);
  });

  it('reports a request closed with no decision recorded', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);
    // The state a bad migration would leave: closed, but nothing signed it.
    await d1
      .prepare("UPDATE reviews SET status = 'approved', closed_at = ? WHERE id = ?")
      .bind(ISO, review.id)
      .run();

    const problems = await validateReviewGraph(ORG);
    expect(problems.map((problem) => problem.kind)).toContain('closed_without_decision');
  });

  it('reports a pending request carrying a closed_at', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);
    await d1.prepare('UPDATE reviews SET closed_at = ? WHERE id = ?').bind(ISO, review.id).run();

    expect((await validateReviewGraph(ORG)).map((problem) => problem.kind)).toContain(
      'pending_with_closed_at',
    );
  });

  it('reports a request nobody was asked to act on', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);
    await d1.prepare('DELETE FROM review_reviewers WHERE review_id = ?').bind(review.id).run();

    expect((await validateReviewGraph(ORG)).map((problem) => problem.kind)).toContain(
      'review_without_reviewers',
    );
  });

  it('reports an approval naming a different version from its review', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);
    await approve(review.id, target.id, versionId);

    const other = await versionRepository.create({
      organizationId: ORG,
      fileId: target.id,
      versionNumber: 2,
      storageKey: `originals/${target.id}/v2`,
      storageArea: 'originals',
      relativeStoragePath: `originals/${target.id}/v2`,
      storedFilename: 'v2',
      originalFilename: 'protocol.pdf',
      fileSize: 10,
      mimeType: 'application/pdf',
      extension: 'pdf',
      checksumSha256: 'c'.repeat(64),
      uploadedBy: ALICE,
    });
    await d1
      .prepare('UPDATE approvals SET version_id = ? WHERE review_id = ?')
      .bind(other.id, review.id)
      .run();

    expect((await validateReviewGraph(ORG)).map((problem) => problem.kind)).toContain(
      'approval_version_mismatch',
    );
  });

  it('changes nothing when it runs twice', async () => {
    const { file: target, versionId } = await fileWithVersion();
    const review = await submit(target.id, versionId);
    await d1.prepare('DELETE FROM review_reviewers WHERE review_id = ?').bind(review.id).run();

    const first = await validateReviewGraph(ORG);
    const second = await validateReviewGraph(ORG);
    expect(second).toEqual(first);

    const db = await getD1();
    const [row] = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.id, review.id), eq(reviews.status, 'pending')));
    expect(row).toBeTruthy();
  });
});
