/**
 * Phase 5 — moving real files into the Shared Drive.
 *
 * Everything here runs the *actual* pipeline: files are uploaded through
 * `upload.service` (quarantine, hashing, finalize), planned by the real planner, and
 * transferred by the real worker against an in-memory Drive. No shortcuts that fabricate a
 * migrated record, because the guarantees being asserted are precisely the ones a shortcut
 * would skip.
 *
 * The tests that matter most are the ones about failure. A migration tool that works when
 * everything works is not worth much: the questions are whether a retry duplicates, whether
 * a crash between "Drive committed" and "MongoDB committed" duplicates, whether a failed
 * transfer leaves the file readable, and whether a rollback actually gets everything back.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import { FakeDriveClient } from '../helpers/fake-drive';
import type { Actor } from '@/server/permissions/actor';
import { DriveApiError } from '@/server/storage/google/drive-errors';
import { GoogleDriveObjectStore } from '@/server/storage/google/google-drive-object-store';
import type { DriveStorageConfig } from '@/server/storage/google/drive-config';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { FileModel } from '@/server/db/models/file.model';
import { StorageRecoveryItemModel } from '@/server/db/models/storage-recovery-item.model';
import * as migrationRepository from '@/server/repositories/storage-migration.repository';
import { planJob } from '@/server/services/storage-migration/planner';
import { runJob, rollbackJob, verifyJob } from '@/server/services/storage-migration/runner';
import type { TransferDeps } from '@/server/services/storage-migration/transfer';

let db: TestDb;
let fixture: Fixture;
let drive: FakeDriveClient;
let deps: TransferDeps;

const DRIVE_ROOT = 'root-folder';

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

async function services() {
  return {
    uploadService: (await import('@/server/services/upload.service')).uploadService,
    downloadService: (await import('@/server/services/download.service')).downloadService,
    driveService: (await import('@/server/services/drive.service')).driveService,
    folderService: (await import('@/server/services/folder.service')).folderService,
  };
}

async function collect(body: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function uploadInto(
  actor: Actor,
  folderId: string,
  filename: string,
  content: Buffer,
  targetFileId?: string,
): Promise<{ fileId: string; versionId: string }> {
  const { uploadService } = await services();
  const ticket = await uploadService.authorizeUpload(
    actor,
    {
      folderId,
      filename,
      size: content.byteLength,
      ...(targetFileId ? { targetFileId } : {}),
    },
    TEST_META,
  );
  await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(content), TEST_META);
  const result = await uploadService.finalize(actor, ticket.sessionId, TEST_META);
  return { fileId: result.fileId, versionId: result.versionId };
}

async function makeFolder(actor: Actor, name: string, parentId?: string): Promise<string> {
  const { driveService, folderService } = await services();
  const parent = parentId ?? (await driveService.getMyDriveRoot(actor)).id;
  const folder = await folderService.createFolder(actor, { name, parentFolderId: parent }, TEST_META);
  return folder.id;
}

/** Creates and plans a job over one folder subtree — the ordinary path. */
async function planFolderJob(actor: Actor, folderId: string, name = 'Test migration') {
  const job = await migrationRepository.createJob({
    organizationId: actor.organizationId,
    name,
    mode: 'migrate',
    selection: { folderIds: [folderId], includeDescendants: true },
    createdBy: actor.userId,
  });

  const report = await planJob({
    jobId: job.id,
    organizationId: actor.organizationId,
    selection: { folderIds: [folderId], includeDescendants: true },
    dryRun: false,
  });

  return { jobId: job.id, report };
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

beforeEach(async () => {
  drive = new FakeDriveClient();
  const store = new GoogleDriveObjectStore(drive, driveConfig());
  deps = { store, client: drive, hierarchy: store };

  if (db.available) {
    // The registry is what the *read* path uses, so a migrated file must be readable
    // through it for the round-trip assertions to mean anything.
    const { getObjectStore, storageRegistry } = await import('@/server/storage');
    getObjectStore('local');
    storageRegistry.register({ objects: store, hierarchy: store });
  }
});

describe('a project migrates without data loss', () => {
  it('moves every version, verifies each one, and serves them all from Drive afterwards', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Ares assays');

    const files = [
      { name: 'run-a.csv', body: Buffer.from('sample,ct\nS-1,22.4\n') },
      { name: 'run-b.csv', body: Buffer.from('sample,ct\nS-2,19.8\nS-3,20.1\n') },
      { name: 'notes.txt', body: Buffer.from('Bench notes for the Ares assay series.') },
    ];
    const uploaded = [];
    for (const file of files) uploaded.push(await uploadInto(actor, folder, file.name, file.body));

    const { jobId, report } = await planFolderJob(actor, folder);
    expect(report.selected).toBe(3);
    expect(report.selectedBytes).toBe(files.reduce((sum, f) => sum + f.body.byteLength, 0));
    expect(report.tooDeep).toEqual([]);
    expect(report.itemProjection.withinLimit).toBe(true);

    const summary = await runJob({ jobId, workerId: 'test', deps });
    expect(summary.verified).toBe(3);
    expect(summary.failed).toBe(0);

    const { downloadService } = await services();
    for (const [index, entry] of uploaded.entries()) {
      const version = await FileVersionModel.findById(entry.versionId);
      expect(version!.storageProvider).toBe('google_drive');
      expect(version!.migrationStatus).toBe('verified');
      expect(version!.googleDriveFileId).toBeTruthy();

      // The byte-for-byte round trip, through the ordinary download path.
      const stream = await downloadService.download(actor, entry.fileId, {}, TEST_META);
      expect(await collect(stream.body)).toEqual(files[index]!.body);
    }
  });

  /** Every version, not just the current one — history is what makes approvals answerable. */
  it('migrates version history, not only the current version', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Versioned');
    const v1 = Buffer.from('first revision');
    const v2 = Buffer.from('second revision, corrected');

    const first = await uploadInto(actor, folder, 'protocol.txt', v1);
    await uploadInto(actor, folder, 'protocol.txt', v2, first.fileId);

    const { jobId, report } = await planFolderJob(actor, folder);
    expect(report.selected).toBe(2);

    await runJob({ jobId, workerId: 'test', deps });

    const versions = await FileVersionModel.find({ fileId: new Types.ObjectId(first.fileId) }).lean();
    expect(versions).toHaveLength(2);
    for (const version of versions) {
      expect(version.storageProvider).toBe('google_drive');
    }

    const { downloadService } = await services();
    expect(
      await collect(
        (await downloadService.download(actor, first.fileId, { versionId: first.versionId }, TEST_META)).body,
      ),
    ).toEqual(v1);
  });

  /** The local copy is the rollback plan. Migration must not touch it. */
  it('leaves the local copy and its key exactly where they were', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Retention');
    const content = Buffer.from('keep me local too');

    const { versionId } = await uploadInto(actor, folder, 'retained.txt', content);
    const before = await FileVersionModel.findById(versionId).lean();

    const { jobId } = await planFolderJob(actor, folder);
    await runJob({ jobId, workerId: 'test', deps });

    const after = await FileVersionModel.findById(versionId).lean();
    expect(after!.storageKey).toBe(before!.storageKey);
    expect(after!.localCopyState).toBe('present');
    expect(after!.localCopyEligibleForDeletionAt).toBeTruthy();

    // And the bytes really are still on this server.
    const { getStorageProvider } = await import('@/server/storage');
    const local = await getStorageProvider().getFile(after!.storageKey, after!.storageArea as never);
    expect(await collect(local)).toEqual(content);
  });

  it('preserves metadata and approvals across the move', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Approved work');
    const content = Buffer.from('approved results');

    const { fileId, versionId } = await uploadInto(actor, folder, 'approved.csv', content);

    await FileVersionModel.updateOne(
      { _id: versionId },
      { $set: { isApproved: true, approvedAt: new Date(), label: 'approved' } },
    );
    await FileModel.updateOne(
      { _id: fileId },
      { $set: { tags: ['ares', 'qpcr'], approvalStatus: 'approved', approvedVersionId: versionId } },
    );

    const { jobId } = await planFolderJob(actor, folder);
    await runJob({ jobId, workerId: 'test', deps });

    const version = await FileVersionModel.findById(versionId).lean();
    const file = await FileModel.findById(fileId).lean();

    expect(version!.isApproved).toBe(true);
    expect(version!.label).toBe('approved');
    // The identity of what was approved is untouched — that is the immutability hook.
    expect(version!.checksumSha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(file!.approvalStatus).toBe('approved');
    expect(String(file!.approvedVersionId)).toBe(versionId);
    expect(file!.tags).toEqual(['ares', 'qpcr']);
  });

  it('maintains the file storage mirror, including the mixed state', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Mirror');

    const first = await uploadInto(actor, folder, 'mirror.txt', Buffer.from('v1'));
    await uploadInto(actor, folder, 'mirror.txt', Buffer.from('v2 longer'), first.fileId);

    // Migrate only one of the two versions.
    const job = await migrationRepository.createJob({
      organizationId: actor.organizationId,
      name: 'Partial',
      mode: 'migrate',
      selection: { versionIds: [first.versionId] },
      createdBy: actor.userId,
    });
    await planJob({
      jobId: job.id,
      organizationId: actor.organizationId,
      selection: { versionIds: [first.versionId] },
      dryRun: false,
    });
    await runJob({ jobId: job.id, workerId: 'test', deps });

    const file = await FileModel.findById(first.fileId).lean();
    expect(file!.storageProvider).toBe('mixed');
  });

  it('mirrors the folder tree once, not once per file', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const parent = await makeFolder(actor, 'Programme');
    const child = await makeFolder(actor, 'Batch 1', parent);

    for (let i = 0; i < 4; i += 1) {
      await uploadInto(actor, child, `sample-${i}.csv`, Buffer.from(`row ${i}`));
    }

    const { jobId } = await planFolderJob(actor, parent);
    await runJob({ jobId, workerId: 'test', deps });

    const folders = drive.snapshot().filter((item) => item.mimeType.includes('folder'));
    // My Drive root → Programme → Batch 1. One Drive folder each, however many files.
    expect(folders.filter((f) => f.name === 'Batch 1')).toHaveLength(1);
    expect(folders.filter((f) => f.name === 'Programme')).toHaveLength(1);
  });
});

describe('retrying never duplicates', () => {
  /**
   * ★ Layer 4. The process died after Drive committed and before MongoDB did, so nothing in
   * the database points at the object. Simulated by rewinding the record while leaving the
   * Drive object — which is exactly the state such a crash produces.
   */
  it('adopts an object orphaned by a crash instead of uploading a second one', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Crash recovery');
    const content = Buffer.from('bytes that made it across');

    const { versionId } = await uploadInto(actor, folder, 'orphan.txt', content);
    const { jobId } = await planFolderJob(actor, folder);
    await runJob({ jobId, workerId: 'test', deps });

    const migrated = await FileVersionModel.findById(versionId).lean();
    const originalDriveId = migrated!.googleDriveFileId;
    const objectsAfterFirstRun = drive.snapshot().filter((i) => !i.mimeType.includes('folder')).length;

    // Rewind the database only — the Drive object and its idempotency key remain.
    await FileVersionModel.updateOne(
      { _id: versionId },
      {
        $set: { storageProvider: 'local', googleDriveFileId: null, migrationStatus: 'not_started' },
      },
    );
    await migrationRepository.requeueFailed(jobId);
    const { StorageMigrationItemModel } = await import('@/server/db/models/storage-migration-item.model');
    await StorageMigrationItemModel.updateMany(
      { jobId: new Types.ObjectId(jobId) },
      { $set: { status: 'queued', claimActive: false } },
    );

    await runJob({ jobId, workerId: 'test-2', deps });

    const recovered = await FileVersionModel.findById(versionId).lean();
    expect(recovered!.googleDriveFileId).toBe(originalDriveId);
    // The decisive assertion: no second object in company storage.
    expect(drive.snapshot().filter((i) => !i.mimeType.includes('folder'))).toHaveLength(
      objectsAfterFirstRun,
    );
  });

  /** Layer 3: a version already recorded as migrated is checked, not transferred again. */
  it('skips a version that is already in Drive and verifies', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Already done');

    await uploadInto(actor, folder, 'done.txt', Buffer.from('already there'));
    const { jobId } = await planFolderJob(actor, folder);
    await runJob({ jobId, workerId: 'test', deps });

    const uploadsAfterFirst = drive.calls.filter((c) => c === 'uploadFile').length;

    const { StorageMigrationItemModel } = await import('@/server/db/models/storage-migration-item.model');
    await StorageMigrationItemModel.updateMany(
      { jobId: new Types.ObjectId(jobId) },
      { $set: { status: 'queued', claimActive: false } },
    );

    const second = await runJob({ jobId, workerId: 'test-2', deps });
    expect(second.skipped).toBe(1);
    expect(drive.calls.filter((c) => c === 'uploadFile')).toHaveLength(uploadsAfterFirst);
  });

  /** Layer 1: the atomic claim. Two concurrent runs must not both take the same item. */
  it('lets only one worker claim an item', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Contention');
    await uploadInto(actor, folder, 'contended.txt', Buffer.from('one item only'));

    const { jobId } = await planFolderJob(actor, folder);

    const [a, b] = await Promise.all([
      migrationRepository.claimNextItem({ jobId, workerId: 'w1' }),
      migrationRepository.claimNextItem({ jobId, workerId: 'w2' }),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  /** Re-planning is idempotent: the unique index on (jobId, versionId) sees to it. */
  it('does not duplicate items when a job is planned twice', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Replan');
    await uploadInto(actor, folder, 'replan.txt', Buffer.from('once'));

    const { jobId } = await planFolderJob(actor, folder);
    await planJob({
      jobId,
      organizationId: actor.organizationId,
      selection: { folderIds: [folder], includeDescendants: true },
      dryRun: false,
    });

    const counts = await migrationRepository.countItemsByStatus(jobId);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe('when a transfer fails', () => {
  /**
   * ★ "Failed files remain local." The record must be untouched and the file must still
   * open — a migration that half-updates a record on failure is worse than one that fails.
   */
  it('leaves the version local and still readable', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Upload fails');
    const content = Buffer.from('this upload will not land');

    const { fileId, versionId } = await uploadInto(actor, folder, 'doomed.txt', content);
    const { jobId } = await planFolderJob(actor, folder);

    drive.failNext('uploadFile', new DriveApiError({ status: 403, reason: 'storageQuotaExceeded', message: 'Quota' }));

    const summary = await runJob({ jobId, workerId: 'test', deps, sleep: async () => {} });
    expect(summary.failed).toBe(1);
    expect(summary.verified).toBe(0);

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.storageProvider).toBe('local');
    expect(version!.googleDriveFileId).toBeNull();
    expect(version!.migrationStatus).toBe('not_started');

    const { downloadService } = await services();
    expect(await collect((await downloadService.download(actor, fileId, {}, TEST_META)).body)).toEqual(content);
  });

  /** Local bit-rot is caught before anything is uploaded, never after. */
  it('refuses to upload a file whose local checksum no longer matches', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Bit rot');

    const { versionId } = await uploadInto(actor, folder, 'rotten.txt', Buffer.from('original bytes'));

    // The database now disagrees with the disk, which is what local corruption looks like.
    await FileVersionModel.updateOne({ _id: versionId }, { $set: { isCurrent: true } });
    const { StorageMigrationItemModel } = await import('@/server/db/models/storage-migration-item.model');
    const { jobId } = await planFolderJob(actor, folder);
    await FileVersionModel.collection.updateOne(
      { _id: new Types.ObjectId(versionId) },
      { $set: { checksumSha256: 'f'.repeat(64) } },
    );

    const summary = await runJob({ jobId, workerId: 'test', deps });
    expect(summary.failed).toBe(1);
    expect(drive.calls).not.toContain('uploadFile');

    const items = await StorageMigrationItemModel.find({ jobId: new Types.ObjectId(jobId) }).lean();
    expect(items[0]!.failureCode).toBe('LOCAL_CORRUPT');
  });

  it('records a machine-readable failure code and surfaces it on the job', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Failure codes');
    await uploadInto(actor, folder, 'coded.txt', Buffer.from('x'));

    const { jobId } = await planFolderJob(actor, folder);
    drive.failNext('uploadFile', new DriveApiError({ status: 403, reason: 'insufficientFilePermissions', message: 'permission denied' }));

    await runJob({ jobId, workerId: 'test', deps, sleep: async () => {} });

    const job = await migrationRepository.findJob(jobId);
    expect(job?.counters?.failed).toBe(1);
    expect(Object.keys(job?.failureCounts ?? {})).toContain('DRIVE_PERMISSION_DENIED');
  });

  it('can retry a failure and succeed', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Retry me');
    const content = Buffer.from('succeeds on the second attempt');

    const { versionId } = await uploadInto(actor, folder, 'retry.txt', content);
    const { jobId } = await planFolderJob(actor, folder);

    drive.failNext('uploadFile', new DriveApiError({ status: 500, message: 'Backend Error' }));
    await runJob({ jobId, workerId: 'test', deps, sleep: async () => {} });
    expect((await FileVersionModel.findById(versionId).lean())!.storageProvider).toBe('local');

    const { requeued } = await migrationRepository.requeueFailed(jobId).then((n) => ({ requeued: n }));
    expect(requeued).toBe(1);

    const second = await runJob({ jobId, workerId: 'test-2', deps });
    expect(second.verified).toBe(1);
    expect((await FileVersionModel.findById(versionId).lean())!.storageProvider).toBe('google_drive');
  });
});

describe('rollback', () => {
  /**
   * ★ The acceptance criterion: an L1 rollback of a migrated project, followed by a
   * successful download of every file in it.
   */
  it('reverts every version to local and every file still downloads', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Rollback me');

    const bodies = [Buffer.from('alpha results'), Buffer.from('beta results, longer')];
    const uploaded = [
      await uploadInto(actor, folder, 'alpha.csv', bodies[0]!),
      await uploadInto(actor, folder, 'beta.csv', bodies[1]!),
    ];

    const { jobId } = await planFolderJob(actor, folder);
    await runJob({ jobId, workerId: 'test', deps });

    const result = await rollbackJob(jobId);
    expect(result.rolledBack).toBe(2);
    expect(result.skipped).toBe(0);

    const { downloadService } = await services();
    for (const [index, entry] of uploaded.entries()) {
      const version = await FileVersionModel.findById(entry.versionId).lean();
      expect(version!.storageProvider).toBe('local');
      expect(version!.migrationStatus).toBe('rolled_back');
      // The Drive id is kept for the record; the object itself is left in place.
      expect(version!.googleDriveFileId).toBeTruthy();

      const stream = await downloadService.download(actor, entry.fileId, {}, TEST_META);
      expect(await collect(stream.body)).toEqual(bodies[index]!);
    }

    // Nothing was deleted from Drive — a rollback must not itself be destructive.
    expect(drive.calls).not.toContain('deleteFile');
  });

  /**
   * A version whose local copy is gone has nothing to roll back *to*. Flipping it would
   * point the record at bytes that are not there — turning a recoverable situation into
   * data loss.
   */
  it('refuses to revert a version whose local copy has been deleted', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'No way back');

    const { versionId } = await uploadInto(actor, folder, 'purged.txt', Buffer.from('local copy gone'));
    const { jobId } = await planFolderJob(actor, folder);
    await runJob({ jobId, workerId: 'test', deps });

    await FileVersionModel.updateOne({ _id: versionId }, { $set: { localCopyState: 'deleted' } });

    const result = await rollbackJob(jobId);
    expect(result.rolledBack).toBe(0);
    expect(result.skipped).toBe(1);

    const version = await FileVersionModel.findById(versionId).lean();
    expect(version!.storageProvider).toBe('google_drive');
  });
});

describe('verification and dry runs', () => {
  it('verify-only re-checks without transferring anything', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Verify');
    await uploadInto(actor, folder, 'verify.txt', Buffer.from('verify me'));

    const { jobId } = await planFolderJob(actor, folder);
    await runJob({ jobId, workerId: 'test', deps });

    const uploadsBefore = drive.calls.filter((c) => c === 'uploadFile').length;
    const result = await verifyJob({ jobId, deps });

    expect(result.checked).toBe(1);
    expect(result.ok).toBe(1);
    expect(result.failed).toBe(0);
    expect(drive.calls.filter((c) => c === 'uploadFile')).toHaveLength(uploadsBefore);
  });

  it('verify-only reports an object that has changed underneath us', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Changed');
    await uploadInto(actor, folder, 'changed.txt', Buffer.from('original'));

    const { jobId } = await planFolderJob(actor, folder);
    await runJob({ jobId, workerId: 'test', deps });

    const items = await migrationRepository.listItems({ jobId, limit: 10 });
    await drive.deleteFile(items[0]!.googleDriveFileId!);

    const result = await verifyJob({ jobId, deps });
    expect(result.failed).toBe(1);
  });

  it('a dry run writes nothing but reports the same numbers', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Dry run');
    await uploadInto(actor, folder, 'a.csv', Buffer.from('one'));
    await uploadInto(actor, folder, 'b.csv', Buffer.from('two'));

    const job = await migrationRepository.createJob({
      organizationId: actor.organizationId,
      name: 'Dry',
      mode: 'dry_run',
      selection: { folderIds: [folder], includeDescendants: true },
      createdBy: actor.userId,
    });

    const report = await planJob({
      jobId: job.id,
      organizationId: actor.organizationId,
      selection: { folderIds: [folder], includeDescendants: true },
      dryRun: true,
    });

    expect(report.selected).toBe(2);
    expect(report.itemProjection.limit).toBe(500_000);
    // Nothing recorded, nothing in Drive.
    expect(await migrationRepository.countItemsByStatus(job.id)).toEqual({});
    expect(drive.snapshot()).toEqual([]);
  });

  /** An unbounded selection is refused: "migrate everything at once" is the thing to prevent. */
  it('refuses a selection with no criteria', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    await expect(
      planJob({
        jobId: new Types.ObjectId().toHexString(),
        organizationId: actor.organizationId,
        selection: {},
        dryRun: true,
      }),
    ).rejects.toThrow(/at least one/i);
  });
});

describe('the recovery queue', () => {
  it('opens a row before the Drive write and closes it after the commit', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Recovery');
    await uploadInto(actor, folder, 'recovered.txt', Buffer.from('traceable'));

    const { jobId } = await planFolderJob(actor, folder);
    await runJob({ jobId, workerId: 'test', deps });

    // Scoped to this job: earlier tests in this file leave their own rows behind, which is
    // itself correct behaviour and must not be mistaken for this job's.
    const scope = { jobId: new Types.ObjectId(jobId) };

    // Nothing left open on success, and the row records that it was resolved.
    expect(await StorageRecoveryItemModel.countDocuments({ ...scope, status: 'open' })).toBe(0);
    expect(
      await StorageRecoveryItemModel.countDocuments({ ...scope, status: 'resolved_adopted' }),
    ).toBe(1);
  });

  it('leaves the row open when the upload fails, so a sweep can find it', async () => {
    if (skipUnlessDb()) return;
    const actor = await actorFor(fixture.users.scientistA);
    const folder = await makeFolder(actor, 'Left open');
    await uploadInto(actor, folder, 'stuck.txt', Buffer.from('did not land'));

    const { jobId } = await planFolderJob(actor, folder);
    drive.failNext('uploadFile', new DriveApiError({ status: 500, message: 'Backend Error' }));

    await runJob({ jobId, workerId: 'test', deps, sleep: async () => {} });

    // Still open, and it names the object to go looking for. That row is the only thing
    // standing between a crashed transfer and a duplicate upload.
    const open = await StorageRecoveryItemModel.find({
      jobId: new Types.ObjectId(jobId),
      status: 'open',
    }).lean();

    expect(open).toHaveLength(1);
    expect(open[0]!.idempotencyKey).toContain(jobId);
  });
});
