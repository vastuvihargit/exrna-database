/**
 * Sharing, comments and notifications.
 *
 * The brief asks for explicit proof of two things here, and both are about *removal*
 * rather than addition: revoked access must stop working immediately, and a share must
 * never hand over more than the sharer holds. The rest of the cases guard the quieter
 * leaks — a mention that announces a file's existence, a notification that outlives its
 * subject, a comment that alters what it comments on.
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
    sharingService: (await import('@/server/services/sharing.service')).sharingService,
    commentService: (await import('@/server/services/comment.service')).commentService,
    notificationRepository: await import('@/server/repositories/notification.repository'),
    commentRepository: await import('@/server/repositories/comment.repository'),
  };
}

const TXT = Buffer.from('experimental readings\n');

async function personalFolder(actor: Actor, name: string): Promise<string> {
  const { driveService, folderService } = await services();
  const root = await driveService.getMyDriveRoot(actor);
  const folder = await folderService.createFolder(actor, { name, parentFolderId: root.id }, TEST_META);
  return folder.id;
}

async function upload(actor: Actor, folderId: string, filename: string) {
  const { uploadService } = await services();
  const ticket = await uploadService.authorizeUpload(
    actor,
    { folderId, filename, size: TXT.byteLength },
    TEST_META,
  );
  await uploadService.receiveStream(actor, ticket.sessionId, Readable.from(TXT), TEST_META);
  return uploadService.finalize(actor, ticket.sessionId, TEST_META);
}

describe('sharing grants access, and revoking removes it immediately', () => {
  it('lets a colleague open a file only after it is shared, and not after it is revoked', async () => {
    if (skipUnlessDb()) return;
    const { sharingService, fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await personalFolder(alice, 'Share lifecycle');
    const uploaded = await upload(alice, folderId, 'readings.txt');

    // Before: Bob is in another department and has no route in.
    await expect(fileService.getFile(bob, uploaded.fileId)).rejects.toMatchObject({ status: 404 });

    await sharingService.share(
      alice,
      'file',
      uploaded.fileId,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'viewer' },
      TEST_META,
    );

    // After: the very next call sees it. There is no permission cache to wait out.
    const seen = await fileService.getFile(bob, uploaded.fileId);
    expect(seen.id).toBe(uploaded.fileId);

    await sharingService.revokeShare(
      alice,
      'file',
      uploaded.fileId,
      'user',
      bob.userId,
      TEST_META,
    );

    // Immediately gone again — the Actor is rebuilt per request and ACLs are read from
    // the document on every decision.
    await expect(fileService.getFile(bob, uploaded.fileId)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to grant an access level the sharer does not hold themselves', async () => {
    if (skipUnlessDb()) return;
    const { sharingService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);
    const newcomer = await actorFor(fixture.users.noRole);

    const folderId = await personalFolder(alice, 'Delegation guard');
    const uploaded = await upload(alice, folderId, 'delegation.txt');

    // Bob gets commenter — which does not include `access.manage` or `review.approve`.
    await sharingService.share(
      alice,
      'file',
      uploaded.fileId,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'commenter' },
      TEST_META,
    );

    // Bob cannot hand out manager: that would be privilege escalation in two requests.
    await expect(
      sharingService.share(
        bob,
        'file',
        uploaded.fileId,
        { principalType: 'user', principalId: newcomer.userId, accessLevel: 'manager' },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: expect.any(Number) });
  });

  it('lets an explicit deny beat an inherited allow', async () => {
    if (skipUnlessDb()) return;
    const { sharingService, folderService, fileService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const root = await driveService.getMyDriveRoot(alice);
    const parent = await folderService.createFolder(
      alice,
      { name: 'Deny parent', parentFolderId: root.id },
      TEST_META,
    );
    const uploaded = await upload(alice, parent.id, 'inherited.txt');

    // Bob gains access through the folder.
    await sharingService.share(
      alice,
      'folder',
      parent.id,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'editor' },
      TEST_META,
    );
    expect((await fileService.getFile(bob, uploaded.fileId)).id).toBe(uploaded.fileId);

    // A deny on the file itself overrides the inherited allow.
    await sharingService.share(
      alice,
      'file',
      uploaded.fileId,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'viewer', deny: true },
      TEST_META,
    );

    await expect(fileService.getFile(bob, uploaded.fileId)).rejects.toMatchObject({ status: 404 });
  });

  it('copies inherited entries down when inheritance is broken, so nobody silently loses access', async () => {
    if (skipUnlessDb()) return;
    const { sharingService, folderService, fileService, driveService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const root = await driveService.getMyDriveRoot(alice);
    const parent = await folderService.createFolder(
      alice,
      { name: 'Break inheritance', parentFolderId: root.id },
      TEST_META,
    );
    const uploaded = await upload(alice, parent.id, 'breakable.txt');

    await sharingService.share(
      alice,
      'folder',
      parent.id,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'viewer' },
      TEST_META,
    );

    const after = await sharingService.setInheritance(alice, 'file', uploaded.fileId, false, TEST_META);

    expect(after.inheritPermissions).toBe(false);
    // Bob's grant was copied down rather than dropped.
    expect(after.entries.some((entry) => entry.principalId === bob.userId && !entry.inherited)).toBe(true);
    expect((await fileService.getFile(bob, uploaded.fileId)).id).toBe(uploaded.fileId);
  });

  it('refuses to share with a deactivated account', async () => {
    if (skipUnlessDb()) return;
    const { sharingService } = await services();
    const userRepository = await import('@/server/repositories/user.repository');
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await personalFolder(alice, 'Deactivated share');
    const uploaded = await upload(alice, folderId, 'deactivated.txt');

    await userRepository.updateById(fixture.users.viewer, { status: 'deactivated' });

    // A grant to a dormant account would silently reactivate with the person — the audit
    // trail would show the share, not the reactivation.
    await expect(
      sharingService.share(
        alice,
        'file',
        uploaded.fileId,
        { principalType: 'user', principalId: fixture.users.viewer, accessLevel: 'viewer' },
        TEST_META,
      ),
    ).rejects.toMatchObject({ status: 409 });

    await userRepository.updateById(fixture.users.viewer, { status: 'active' });
  });

  it('keeps the share list itself behind a permission check', async () => {
    if (skipUnlessDb()) return;
    const { sharingService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await personalFolder(alice, 'Share list privacy');
    const uploaded = await upload(alice, folderId, 'listing.txt');

    // Bob gets read access, but reading the file does not entitle him to the roster of
    // everyone else who has it.
    await sharingService.share(
      alice,
      'file',
      uploaded.fileId,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'viewer' },
      TEST_META,
    );

    await expect(
      sharingService.getShareState(bob, 'file', uploaded.fileId),
    ).rejects.toMatchObject({ status: expect.any(Number) });
  });
});

describe('shared with me', () => {
  it('lists what was handed over, and not the sharer’s own files', async () => {
    if (skipUnlessDb()) return;
    const { sharingService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await personalFolder(alice, 'Shared listing');
    const shared = await upload(alice, folderId, 'handed-over.txt');
    await upload(alice, folderId, 'kept-private.txt');

    await sharingService.share(
      alice,
      'file',
      shared.fileId,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'viewer' },
      TEST_META,
    );

    const forBob = await sharingService.listSharedWithMe(bob, { page: 1, pageSize: 25 });
    const ids = forBob.files.map((file) => file.id);
    expect(ids).toContain(shared.fileId);

    // Alice sees nothing here: her own files are in her drive, not in "shared with me".
    const forAlice = await sharingService.listSharedWithMe(alice, { page: 1, pageSize: 25 });
    expect(forAlice.files.map((file) => file.id)).not.toContain(shared.fileId);
  });
});

describe('comments', () => {
  it('does not modify the file it comments on', async () => {
    if (skipUnlessDb()) return;
    const { commentService, fileService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await personalFolder(alice, 'Comment isolation');
    const uploaded = await upload(alice, folderId, 'commented.txt');

    const before = await fileService.getFile(alice, uploaded.fileId);
    await commentService.addComment(alice, uploaded.fileId, { body: 'Peak at 3.2 min looks off' }, TEST_META);
    const after = await fileService.getFile(alice, uploaded.fileId);

    expect(after.checksumSha256).toBe(before.checksumSha256);
    expect(after.currentVersionId).toBe(before.currentVersionId);
    expect(after.versionCount).toBe(before.versionCount);
    expect(after.sizeBytes).toBe(before.sizeBytes);
  });

  it('pins a comment to the version that was current when it was written', async () => {
    if (skipUnlessDb()) return;
    const { commentService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await personalFolder(alice, 'Comment version pin');
    const uploaded = await upload(alice, folderId, 'pinned.txt');

    const comment = await commentService.addComment(
      alice,
      uploaded.fileId,
      { body: 'Reviewed against v1' },
      TEST_META,
    );

    expect(comment.versionNumber).toBe(1);
    expect(comment.versionId).toBe(uploaded.versionId);
  });

  it('flattens a reply-to-a-reply into the same thread', async () => {
    if (skipUnlessDb()) return;
    const { commentService } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await personalFolder(alice, 'Comment threading');
    const uploaded = await upload(alice, folderId, 'threaded.txt');

    const root = await commentService.addComment(alice, uploaded.fileId, { body: 'Question' }, TEST_META);
    const reply = await commentService.addComment(
      alice,
      uploaded.fileId,
      { body: 'Answer', parentCommentId: root.id },
      TEST_META,
    );
    const replyToReply = await commentService.addComment(
      alice,
      uploaded.fileId,
      { body: 'Follow-up', parentCommentId: reply.id },
      TEST_META,
    );

    // One level only — the follow-up joins the root thread rather than nesting.
    expect(reply.parentCommentId).toBe(root.id);
    expect(replyToReply.parentCommentId).toBe(root.id);

    const threads = await commentService.listComments(alice, uploaded.fileId);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.replies).toHaveLength(2);
  });

  it('refuses to let someone edit another person’s comment', async () => {
    if (skipUnlessDb()) return;
    const { commentService, sharingService } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await personalFolder(alice, 'Comment authorship');
    const uploaded = await upload(alice, folderId, 'authored.txt');

    await sharingService.share(
      alice,
      'file',
      uploaded.fileId,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'commenter' },
      TEST_META,
    );

    const comment = await commentService.addComment(alice, uploaded.fileId, { body: 'Mine' }, TEST_META);

    await expect(
      commentService.editComment(bob, uploaded.fileId, comment.id, 'Rewritten', TEST_META),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('drops a mention of someone who cannot open the file', async () => {
    if (skipUnlessDb()) return;
    const { commentService, notificationRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    const folderId = await personalFolder(alice, 'Mention gate');
    const uploaded = await upload(alice, folderId, 'mention.txt');

    const before = await notificationRepository.listForUser(fixture.users.scientistB, { limit: 100 });

    // Bob has no access. Notifying him would announce a file he may not know exists.
    const comment = await commentService.addComment(
      alice,
      uploaded.fileId,
      { body: 'Can you check this @bob@company.com?' },
      TEST_META,
    );

    expect(comment.mentionedUserIds).not.toContain(fixture.users.scientistB);

    const after = await notificationRepository.listForUser(fixture.users.scientistB, { limit: 100 });
    expect(after.length).toBe(before.length);
  });

  it('notifies a mentioned colleague who can open the file', async () => {
    if (skipUnlessDb()) return;
    const { commentService, sharingService, notificationRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);
    const bob = await actorFor(fixture.users.scientistB);

    const folderId = await personalFolder(alice, 'Mention delivery');
    const uploaded = await upload(alice, folderId, 'notify.txt');

    await sharingService.share(
      alice,
      'file',
      uploaded.fileId,
      { principalType: 'user', principalId: bob.userId, accessLevel: 'commenter' },
      TEST_META,
    );

    const comment = await commentService.addComment(
      alice,
      uploaded.fileId,
      { body: 'Second opinion please @bob@company.com' },
      TEST_META,
    );

    expect(comment.mentionedUserIds).toContain(bob.userId);

    // The notification write is fire-and-forget, so give it a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const delivered = await notificationRepository.listForUser(bob.userId, { limit: 100 });
    expect(delivered.some((entry) => entry.type === 'comment.mention')).toBe(true);
  });
});

describe('notifications are private to their recipient', () => {
  it('has no query path that returns another person’s notifications', async () => {
    if (skipUnlessDb()) return;
    const { notificationRepository } = await services();
    const alice = await actorFor(fixture.users.scientistA);

    await notificationRepository.create({
      organizationId: fixture.organizationId,
      userId: fixture.users.scientistB,
      type: 'share.received',
      actorUserId: alice.userId,
      actorName: alice.name,
      entityType: 'file',
      entityId: fixture.users.scientistA, // any valid ObjectId
      entityLabel: 'Bob-only notice',
      message: 'For Bob alone',
    });

    const forAlice = await notificationRepository.listForUser(alice.userId, { limit: 100 });
    expect(forAlice.some((entry) => entry.entityLabel === 'Bob-only notice')).toBe(false);

    // And marking it read from the wrong account is a no-op rather than a mutation.
    const forBob = await notificationRepository.listForUser(fixture.users.scientistB, { limit: 100 });
    const target = forBob.find((entry) => entry.entityLabel === 'Bob-only notice')!;
    expect(await notificationRepository.markRead(alice.userId, target.id)).toBe(false);
    expect(await notificationRepository.markRead(fixture.users.scientistB, target.id)).toBe(true);
  });
});
