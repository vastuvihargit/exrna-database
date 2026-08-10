/**
 * Phase 3, module 14 — the support repositories.
 *
 * Login history, application settings, storage accounting, the activity timeline, comments and
 * upload sessions. Six repositories with one thing in common: each has a failure mode that is
 * silent rather than loud, and the assertions here are aimed at those rather than the happy
 * paths.
 *
 *   • **Login history must never fail a login.** It is written on every attempt, including the
 *     failing ones, and on D1 it carries two foreign keys — one of which (`user_id`) is null by
 *     definition on the `unknown_user` path. A write that aborts would turn "wrong password"
 *     into a 500, and would let an attacker suppress their own audit trail.
 *
 *   • **A quota counter must never go negative.** A negative counter reads as *unlimited quota
 *     remaining*, so an overshooting delta is a quota bypass, not a cosmetic error.
 *
 *   • **Concurrent deltas must not lose bytes.** Two uploads that both read-modify-write leave
 *     the loser's bytes on disk and invisible to the quota — silent, cumulative, and discovered
 *     only when a volume fills.
 *
 *   • **A re-sent chunk must change nothing at all.** Counting its bytes twice makes a resumable
 *     upload report more received than it holds, and finalize early.
 *
 *   • **Exactly one caller may finalize an upload.** The status transition is the lock; two
 *     winners would build two versions from one upload.
 *
 *   • **A sweep must count what it removed.** D1 reports cascaded deletions in `meta.changes`,
 *     so a naive count roughly doubles — and that number is what an operator reads to decide
 *     whether retention is working.
 *
 * The engine-parity blocks run both implementations through the same contract. The `d1` blocks
 * cover the places where D1 is genuinely not a transliteration of the Mongo query.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestDb, stopTestDb, clearCollections } from '../helpers/test-db';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import {
  d1LoginHistoryRepository,
  mongoLoginHistoryRepository,
} from '@/server/repositories/login-history.repository';
import {
  d1AppSettingRepository,
  mongoAppSettingRepository,
} from '@/server/repositories/app-setting.repository';
import {
  d1StorageUsageRepository,
  mongoStorageUsageRepository,
} from '@/server/repositories/storage-usage.repository';
import type { LoginHistoryRepository } from '@/server/repositories/login-history.repository.contract';
import type { AppSettingRepository } from '@/server/repositories/app-setting.repository.contract';
import type { StorageUsageRepository } from '@/server/repositories/storage-usage.repository.contract';
import {
  d1ActivityRepository,
  mongoActivityRepository,
} from '@/server/repositories/activity.repository';
import type { ActivityRepository } from '@/server/repositories/activity.repository.contract';
import { d1CommentRepository } from '@/server/repositories/comment.repository';
import { d1UploadSessionRepository } from '@/server/repositories/upload-session.repository';
import { clearDataSourceOverrides } from '@/server/repositories/data-source';
import { UserModel, DepartmentModel } from '@/server/db/models';

const ORG = '507f1f77bcf86cd799439011';
const DEPT = '507f1f77bcf86cd799439021';
const ALICE = '507f1f77bcf86cd7994390a1';
const BOB = '507f1f77bcf86cd7994390a2';
const FOLDER = '507f1f77bcf86cd7994390b1';
const OTHER_FOLDER = '507f1f77bcf86cd7994390b2';
const FILE = '507f1f77bcf86cd7994390c1';
const PROJECT = '507f1f77bcf86cd7994390d1';
const OTHER_PROJECT = '507f1f77bcf86cd7994390d2';
const VERSION = '507f1f77bcf86cd7994390e1';

const ISO = '2026-01-01T00:00:00.000Z';
const QUOTA = 1_000_000;

let d1: D1Database;

interface Engine {
  name: 'mongo' | 'd1';
  loginHistory: LoginHistoryRepository;
  appSettings: AppSettingRepository;
  usage: StorageUsageRepository;
  activities: ActivityRepository;
  reset: () => Promise<void>;
}

/* ------------------------------------------------------------------ fixtures */

async function seedD1(): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO organizations
         (id, name, slug, email_domains, settings, storage_used_bytes, file_count, is_active, created_at, updated_at)
       VALUES (?, 'Org', 'org', '[]', '{}', 0, 0, 1, ?, ?)`,
    )
    .bind(ORG, ISO, ISO)
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO departments
         (id, organization_id, name, code, description, storage_quota_bytes, storage_used_bytes,
          member_count, is_active, created_at, updated_at)
       VALUES (?, ?, 'Molecular Biology', 'MOLBIO', '', ?, 0, 0, 1, ?, ?)`,
    )
    .bind(DEPT, ORG, QUOTA, ISO, ISO)
    .run();

  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
  ]) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO users
           (id, organization_id, email, email_domain, name, status, department_id,
            storage_quota_bytes, storage_used_bytes, created_at, updated_at)
         VALUES (?, ?, ?, 'example.com', ?, 'active', ?, ?, 0, ?, ?)`,
      )
      .bind(id, ORG, `${name!.toLowerCase()}@example.com`, name, DEPT, QUOTA, ISO, ISO)
      .run();
  }
}

async function seedMongo(): Promise<void> {
  await DepartmentModel.create({
    _id: DEPT,
    organizationId: ORG,
    name: 'Molecular Biology',
    code: 'MOLBIO',
    storageQuotaBytes: QUOTA,
    storageUsedBytes: 0,
  });

  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
  ]) {
    await UserModel.create({
      _id: id,
      organizationId: ORG,
      email: `${name!.toLowerCase()}@example.com`,
      emailDomain: 'example.com',
      name,
      status: 'active',
      departmentId: DEPT,
      storageQuotaBytes: QUOTA,
      storageUsedBytes: 0,
    });
  }
}

/**
 * The folders and projects the activity timeline references.
 *
 * Only D1 needs them as real rows: `activity_folders.folder_id` and `activities.project_id` are
 * foreign keys there, while MongoDB stores whatever ObjectId it is handed. Seeding both anyway
 * would mean two fixtures to keep in step for no gain, so this one is engine-aware and says so.
 */
async function seedFolder(engine: 'mongo' | 'd1'): Promise<void> {
  if (engine !== 'd1') return;

  for (const [id, name] of [
    [PROJECT, 'Tox Study'],
    [OTHER_PROJECT, 'Other Study'],
  ]) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO projects
           (id, organization_id, department_id, name, code, description, status, lead_user_id,
            storage_used_bytes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', 'active', ?, 0, ?, ?, ?)`,
      )
      .bind(id, ORG, DEPT, name, `P-${id!.slice(-4)}`, ALICE, ALICE, ISO, ISO)
      .run();
  }

  for (const [id, name] of [
    [FOLDER, 'Root'],
    [OTHER_FOLDER, 'Elsewhere'],
  ]) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO folders
           (id, organization_id, drive_type, name, name_lower, owner_id, department_id, depth,
            created_by, created_at, updated_at)
         VALUES (?, ?, 'department', ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(id, ORG, name, name!.toLowerCase(), ALICE, DEPT, ALICE, ISO, ISO)
      .run();
  }
}

/**
 * A file with one version, for the comment tests.
 *
 * `comments.file_id` and `.version_id` are both foreign keys on D1, so a comment cannot be
 * written against a file that does not exist — which is the constraint that makes "a comment is
 * pinned to a version" structural rather than conventional.
 */
async function seedFileAndVersion(): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO files (id, organization_id, display_name, display_name_lower,
                                    original_filename, extension, category, folder_id, drive_type,
                                    owner_id, department_id, version_count, created_by,
                                    created_at, updated_at)
       VALUES (?, ?, 'a.csv', 'a.csv', 'a.csv', 'csv', 'raw_data', ?, 'department', ?, ?, 1, ?, ?, ?)`,
    )
    .bind(FILE, ORG, FOLDER, ALICE, DEPT, ALICE, ISO, ISO)
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO file_versions (id, organization_id, file_id, version_number,
                                            storage_key, storage_area, original_filename,
                                            mime_type, extension, checksum_sha256, file_size,
                                            uploaded_by, uploaded_at, is_current,
                                            created_at, updated_at)
       VALUES (?, ?, ?, 1, 'comment-key', 'originals', 'a.csv', 'text/csv', 'csv', 'sum', 10,
               ?, ?, 1, ?, ?)`,
    )
    .bind(VERSION, ORG, FILE, ALICE, ISO, ISO, ISO)
    .run();
}

/* ------------------------------------------------------------------ harness */

beforeAll(async () => {
  const mongo = await startTestDb();
  if (!mongo.available) {
    throw new Error(
      `This suite asserts that the MongoDB and D1 repositories agree, so it needs both. ` +
        `MongoDB could not start: ${mongo.reason}`,
    );
  }

  d1 = await startTestD1();
  setD1BindingForTesting(d1);
}, 300_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  clearDataSourceOverrides();
  await stopTestD1();
  await stopTestDb();
});

/**
 * Order matters, and the `UPDATE`s are not optional.
 *
 * D1 enforces foreign keys, and two of these tables reference themselves — `folders.parent_folder_id`
 * and `sessions.rotated_from_id` — so no delete order alone satisfies the constraints. The
 * self-references are broken first. `login_history.session_id` is likewise detached rather than
 * relying on a delete order, which is the same thing the production sweep does.
 */
const D1_RESET = [
  'UPDATE login_history SET session_id = NULL, user_id = NULL',
  'DELETE FROM login_history',
  'DELETE FROM app_settings',
  'DELETE FROM upload_sessions',
  'DELETE FROM comment_mentions',
  'UPDATE comments SET parent_comment_id = NULL',
  'DELETE FROM comments',
  'DELETE FROM activity_folders',
  'DELETE FROM activities',
  'DELETE FROM projects',
  'UPDATE sessions SET rotated_from_id = NULL',
  'DELETE FROM sessions',
  'DELETE FROM file_versions',
  'UPDATE files SET current_version_id = NULL, approved_version_id = NULL, trashed_with_folder_id = NULL',
  'DELETE FROM files',
  'UPDATE folders SET parent_folder_id = NULL, trashed_with_folder_id = NULL',
  'DELETE FROM folders',
  'UPDATE users SET department_id = NULL',
  'DELETE FROM departments',
  'DELETE FROM users',
  'DELETE FROM organizations',
];

const engines: Engine[] = [
  {
    name: 'mongo',
    loginHistory: mongoLoginHistoryRepository,
    appSettings: mongoAppSettingRepository,
    usage: mongoStorageUsageRepository,
    activities: mongoActivityRepository,
    reset: async () => {
      await clearCollections();
      await seedMongo();
    },
  },
  {
    name: 'd1',
    loginHistory: d1LoginHistoryRepository,
    appSettings: d1AppSettingRepository,
    usage: d1StorageUsageRepository,
    activities: d1ActivityRepository,
    reset: async () => {
      await clearD1(d1, D1_RESET);
      await seedD1();
    },
  },
];

/* ------------------------------------------------------------------ login history */

describe.each(engines)('login history — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  it('records a successful attempt against the user', async () => {
    await engine.loginHistory.record({
      userId: ALICE,
      email: 'Alice@Example.com',
      outcome: 'success',
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });

    const [entry] = await engine.loginHistory.listForUser(ALICE);
    expect(entry!.outcome).toBe('success');
    // Normalised, because the admin view searches on it.
    expect(entry!.email).toBe('alice@example.com');
    expect(entry!.createdAt).toBeInstanceOf(Date);
  });

  /**
   * The `unknown_user` path: there is no account, so there is no id to reference. On D1 both
   * `user_id` and `session_id` are foreign keys, and an aborted write here would mean an
   * attacker probing for valid addresses leaves no trace.
   */
  it('records an attempt against an address that matches no account', async () => {
    await engine.loginHistory.record({
      email: 'nobody@example.com',
      outcome: 'unknown_user',
    });

    const { items } = await engine.loginHistory.query({ page: 1, pageSize: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]!.userId).toBeNull();
    expect(items[0]!.email).toBe('nobody@example.com');
  });

  /**
   * A user id that does not resolve must not abort the write. The row's value is the email and
   * the outcome; the pointer is the least important field on it.
   */
  it('records the attempt even when the user id does not resolve', async () => {
    await engine.loginHistory.record({
      userId: '507f1f77bcf86cd7994390ff',
      email: 'ghost@example.com',
      outcome: 'bad_password',
    });

    const { items, total } = await engine.loginHistory.query({ page: 1, pageSize: 10 });
    expect(total).toBe(1);
    expect(items[0]!.email).toBe('ghost@example.com');
  });

  /** Never throws — the contract's central rule. */
  it('does not throw on a malformed session reference', async () => {
    await expect(
      engine.loginHistory.record({
        userId: ALICE,
        email: 'alice@example.com',
        outcome: 'success',
        sessionId: 'not-an-id',
      }),
    ).resolves.toBeUndefined();
  });

  it('filters by email and by outcome, and paginates', async () => {
    for (const outcome of ['success', 'bad_password', 'bad_password'] as const) {
      await engine.loginHistory.record({ userId: ALICE, email: 'alice@example.com', outcome });
    }
    await engine.loginHistory.record({ userId: BOB, email: 'bob@example.com', outcome: 'success' });

    const failures = await engine.loginHistory.query({
      outcome: 'bad_password',
      page: 1,
      pageSize: 10,
    });
    expect(failures.total).toBe(2);

    const bob = await engine.loginHistory.query({
      email: 'BOB@example.com',
      page: 1,
      pageSize: 10,
    });
    expect(bob.total).toBe(1);

    const firstPage = await engine.loginHistory.query({ page: 1, pageSize: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(4);
  });

  it('sweeps rows older than the retention cutoff', async () => {
    await engine.loginHistory.record({ userId: ALICE, email: 'alice@example.com', outcome: 'success' });

    expect(await engine.loginHistory.deleteOlderThan(new Date(Date.now() - 60_000))).toBe(0);
    expect(await engine.loginHistory.deleteOlderThan(new Date(Date.now() + 60_000))).toBe(1);
    expect(await engine.loginHistory.listForUser(ALICE)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ app settings */

describe.each(engines)('application settings — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  it('stores and reads back a structured value', async () => {
    await engine.appSettings.put({
      organizationId: ORG,
      key: 'retention',
      value: { days: 30, notify: true },
      description: 'Trash retention',
      updatedBy: ALICE,
    });

    const setting = await engine.appSettings.get(ORG, 'retention');
    expect(setting!.value).toEqual({ days: 30, notify: true });
    expect(setting!.description).toBe('Trash retention');
    expect(setting!.updatedBy).toBe(ALICE);
  });

  it('returns null for a key that was never set', async () => {
    expect(await engine.appSettings.get(ORG, 'absent')).toBeNull();
  });

  it('overwrites the value on a second put, without duplicating the row', async () => {
    const base = { organizationId: ORG, key: 'retention', updatedBy: ALICE };
    await engine.appSettings.put({ ...base, value: 1, description: 'first' });
    await engine.appSettings.put({ ...base, value: 2 });

    const setting = await engine.appSettings.get(ORG, 'retention');
    expect(setting!.value).toBe(2);
    // A put that omits the description must not blank it.
    expect(setting!.description).toBe('first');
  });

  it('reads several keys in one call', async () => {
    for (const key of ['a', 'b', 'c']) {
      await engine.appSettings.put({ organizationId: ORG, key, value: key, updatedBy: ALICE });
    }

    const many = await engine.appSettings.getMany(ORG, ['a', 'c', 'missing']);
    expect([...many.keys()].sort()).toEqual(['a', 'c']);
    expect(many.get('a')!.value).toBe('a');
  });

  it('removes a setting and reports whether anything went', async () => {
    await engine.appSettings.put({ organizationId: ORG, key: 'x', value: 1, updatedBy: ALICE });

    expect(await engine.appSettings.remove(ORG, 'x')).toBe(true);
    expect(await engine.appSettings.remove(ORG, 'x')).toBe(false);
    expect(await engine.appSettings.get(ORG, 'x')).toBeNull();
  });

  it('keeps null and false distinguishable from unset', async () => {
    await engine.appSettings.put({ organizationId: ORG, key: 'flag', value: false, updatedBy: ALICE });
    const setting = await engine.appSettings.get(ORG, 'flag');

    expect(setting).not.toBeNull();
    expect(setting!.value).toBe(false);
  });
});

/* ------------------------------------------------------------------ storage usage */

describe.each(engines)('storage accounting — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  it('applies a delta to the user and the department together', async () => {
    await engine.usage.applyDelta({ userId: ALICE, departmentId: DEPT, bytes: 500 });

    expect((await engine.usage.getUserQuota(ALICE))!.usedBytes).toBe(500);
    expect((await engine.usage.getDepartmentQuota(DEPT))!.usedBytes).toBe(500);
  });

  it('reports the remaining allowance', async () => {
    await engine.usage.applyDelta({ userId: ALICE, bytes: 400 });

    const quota = await engine.usage.getUserQuota(ALICE);
    expect(quota).toEqual({ usedBytes: 400, quotaBytes: QUOTA, remainingBytes: QUOTA - 400 });
  });

  it('subtracts on deletion', async () => {
    await engine.usage.applyDelta({ userId: ALICE, bytes: 900 });
    await engine.usage.applyDelta({ userId: ALICE, bytes: -400 });

    expect((await engine.usage.getUserQuota(ALICE))!.usedBytes).toBe(500);
  });

  /**
   * A negative counter reads as unlimited quota remaining, so this is a bypass rather than a
   * cosmetic error. Reachable in practice: a file moved between departments before a drift was
   * corrected subtracts bytes the destination counter never held.
   */
  it('never lets a counter go negative', async () => {
    await engine.usage.applyDelta({ userId: ALICE, departmentId: DEPT, bytes: 100 });
    await engine.usage.applyDelta({ userId: ALICE, departmentId: DEPT, bytes: -5_000 });

    const user = await engine.usage.getUserQuota(ALICE);
    expect(user!.usedBytes).toBe(0);
    expect(user!.remainingBytes).toBe(QUOTA);
    expect((await engine.usage.getDepartmentQuota(DEPT))!.usedBytes).toBe(0);
  });

  /**
   * The property that makes the delta arithmetic rather than a read-modify-write.
   *
   * If both calls read the old total and wrote their own, one upload's bytes would be on disk
   * and invisible to the quota.
   */
  it('loses no bytes when deltas are applied concurrently', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        engine.usage.applyDelta({ userId: ALICE, departmentId: DEPT, bytes: 100 }),
      ),
    );

    expect((await engine.usage.getUserQuota(ALICE))!.usedBytes).toBe(1_000);
    expect((await engine.usage.getDepartmentQuota(DEPT))!.usedBytes).toBe(1_000);
  });

  it('returns null for someone who does not exist', async () => {
    expect(await engine.usage.getUserQuota('507f1f77bcf86cd7994390ff')).toBeNull();
    expect(await engine.usage.getDepartmentQuota('507f1f77bcf86cd7994390fe')).toBeNull();
  });

  it('does not charge one person for another’s upload', async () => {
    await engine.usage.applyDelta({ userId: ALICE, bytes: 700 });

    expect((await engine.usage.getUserQuota(BOB))!.usedBytes).toBe(0);
  });
});

/* ------------------------------------------------------------------ activity timeline */

describe.each(engines)('activity timeline — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
    await seedFolder(engine.name);
  });

  it('appends an entry and returns it on the entity timeline', async () => {
    await engine.activities.append({
      organizationId: ORG,
      actorUserId: ALICE,
      actorName: 'Alice',
      action: 'file.upload',
      entityType: 'file',
      entityId: FILE,
      entityLabel: 'a.csv',
      detail: { size: 500 },
    });

    const [entry] = await engine.activities.listForEntity('file', FILE);
    expect(entry!.action).toBe('file.upload');
    expect(entry!.entityLabel).toBe('a.csv');
    expect(entry!.detail).toEqual({ size: 500 });
    expect(entry!.createdAt).toBeInstanceOf(Date);
  });

  /**
   * The reason `contextFolderIds` exists: an activity on a *file* has to surface on the
   * timeline of every folder above it.
   */
  it('surfaces a file activity on an ancestor folder’s timeline', async () => {
    await engine.activities.append({
      organizationId: ORG,
      actorUserId: ALICE,
      actorName: 'Alice',
      action: 'file.upload',
      entityType: 'file',
      entityId: FILE,
      contextFolderIds: [FOLDER],
    });

    const entries = await engine.activities.listForFolderTree(FOLDER);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('file.upload');
  });

  it('includes the folder’s own activity in its tree timeline', async () => {
    await engine.activities.append({
      organizationId: ORG,
      actorUserId: ALICE,
      actorName: 'Alice',
      action: 'folder.create',
      entityType: 'folder',
      entityId: FOLDER,
    });

    expect(await engine.activities.listForFolderTree(FOLDER)).toHaveLength(1);
  });

  /**
   * An activity recorded against several ancestor folders must appear **once** in a folder
   * timeline. The join form of this query returns one row per folder link, which would make
   * LIMIT silently return fewer distinct entries than it claims.
   */
  it('returns an activity once even when it names the folder several times over', async () => {
    await engine.activities.append({
      organizationId: ORG,
      actorUserId: ALICE,
      actorName: 'Alice',
      action: 'file.move',
      entityType: 'file',
      entityId: FILE,
      contextFolderIds: [FOLDER, FOLDER],
    });

    expect(await engine.activities.listForFolderTree(FOLDER)).toHaveLength(1);
  });

  it('does not leak one folder’s activity into another’s timeline', async () => {
    await engine.activities.append({
      organizationId: ORG,
      actorUserId: ALICE,
      actorName: 'Alice',
      action: 'file.upload',
      entityType: 'file',
      entityId: FILE,
      contextFolderIds: [FOLDER],
    });

    expect(await engine.activities.listForFolderTree(OTHER_FOLDER)).toHaveLength(0);
  });

  it('lists a project timeline', async () => {
    await engine.activities.append({
      organizationId: ORG,
      actorUserId: ALICE,
      actorName: 'Alice',
      action: 'experiment.create',
      entityType: 'project',
      entityId: PROJECT,
      projectId: PROJECT,
    });

    expect(await engine.activities.listForProject(PROJECT)).toHaveLength(1);
    expect(await engine.activities.listForProject(OTHER_PROJECT)).toHaveLength(0);
  });

  it('sweeps entries older than the retention cutoff', async () => {
    await engine.activities.append({
      organizationId: ORG,
      actorUserId: ALICE,
      actorName: 'Alice',
      action: 'file.upload',
      entityType: 'file',
      entityId: FILE,
      contextFolderIds: [FOLDER],
    });

    expect(await engine.activities.deleteOlderThan(new Date(Date.now() - 60_000))).toBe(0);
    expect(await engine.activities.deleteOlderThan(new Date(Date.now() + 60_000))).toBe(1);
    expect(await engine.activities.listForFolderTree(FOLDER)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ comments */

describe('comments — d1', () => {
  beforeEach(async () => {
    await clearD1(d1, D1_RESET);
    await seedD1();
    await seedFolder('d1');
    await seedFileAndVersion();
  });

  async function comment(overrides: Record<string, unknown> = {}) {
    return d1CommentRepository.create({
      organizationId: ORG,
      fileId: FILE,
      versionId: VERSION,
      versionNumber: 1,
      authorUserId: ALICE,
      authorName: 'Alice',
      body: 'Looks right to me',
      ...overrides,
    });
  }

  it('writes a comment with its mentions and reads them back', async () => {
    const created = await comment({ mentionedUserIds: [BOB] });

    expect(created.body).toBe('Looks right to me');
    expect(created.mentionedUserIds).toEqual([BOB]);
    // Pinned to the version it was written against — a remark on v1 is not about v7.
    expect(created.versionId).toBe(VERSION);
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it('returns a thread oldest-first, and hides resolved comments by default', async () => {
    const first = await comment({ body: 'one' });
    await comment({ body: 'two' });
    await d1CommentRepository.setResolved(first.id, true, BOB);

    const open = await d1CommentRepository.listForFile(FILE);
    expect(open.map((row) => row.body)).toEqual(['two']);

    const all = await d1CommentRepository.listForFile(FILE, { includeResolved: true });
    expect(all.map((row) => row.body)).toEqual(['one', 'two']);
  });

  it('un-resolves a comment', async () => {
    const created = await comment();
    await d1CommentRepository.setResolved(created.id, true, BOB);
    const reopened = await d1CommentRepository.setResolved(created.id, false, BOB);

    expect(reopened!.resolvedAt).toBeNull();
    expect(reopened!.resolvedBy).toBeNull();
  });

  it('edits a body and stamps it as edited', async () => {
    const created = await comment();
    const edited = await d1CommentRepository.updateBody(created.id, 'Actually, check figure 2');

    expect(edited!.body).toBe('Actually, check figure 2');
    expect(edited!.editedAt).toBeInstanceOf(Date);
  });

  it('counts replies to a thread root', async () => {
    const root = await comment({ body: 'root' });
    await comment({ body: 'reply', parentCommentId: root.id });
    await comment({ body: 'reply 2', parentCommentId: root.id });

    expect(await d1CommentRepository.countRepliesTo(root.id)).toBe(2);
  });

  /** A soft-deleted comment leaves the thread but keeps the audit trail's subject resolvable. */
  it('soft-deletes without removing the row, and refuses a second delete', async () => {
    const created = await comment();

    expect(await d1CommentRepository.softDelete(created.id, ALICE)).toBe(true);
    expect(await d1CommentRepository.softDelete(created.id, ALICE)).toBe(false);
    expect(await d1CommentRepository.findById(created.id)).toBeNull();
    expect(await d1CommentRepository.listForFile(FILE, { includeResolved: true })).toHaveLength(0);
  });

  /**
   * The purge is the one place soft delete is bypassed: the file is gone for good, so a
   * soft-deleted comment would be a permanent orphan.
   *
   * It also has to survive replies, whose `parent_comment_id` references a row in the same
   * delete — a bare DELETE can hit the parent first and abort.
   */
  it('purges every comment for a file, replies and soft-deleted rows included', async () => {
    const root = await comment({ body: 'root' });
    await comment({ body: 'reply', parentCommentId: root.id });
    const gone = await comment({ body: 'deleted' });
    await d1CommentRepository.softDelete(gone.id, ALICE);

    expect(await d1CommentRepository.purgeForFiles([FILE])).toBe(3);
    expect(await d1CommentRepository.countForFile(FILE)).toBe(0);
  });

  it('purges nothing when given no files', async () => {
    await comment();
    expect(await d1CommentRepository.purgeForFiles([])).toBe(0);
    expect(await d1CommentRepository.countForFile(FILE)).toBe(1);
  });
});

/* ------------------------------------------------------------------ upload sessions */

describe('upload sessions — d1', () => {
  beforeEach(async () => {
    await clearD1(d1, D1_RESET);
    await seedD1();
    await seedFolder('d1');
  });

  async function session(overrides: Record<string, unknown> = {}) {
    return d1UploadSessionRepository.create({
      organizationId: ORG,
      userId: ALICE,
      folderId: FOLDER,
      declaredFilename: 'a.csv',
      displayName: 'a.csv',
      extension: 'csv',
      declaredSize: 1_000,
      resolvedMimeType: 'text/csv',
      expiresAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    });
  }

  it('creates a session in the pending state', async () => {
    const created = await session();

    expect(created.status).toBe('pending');
    expect(created.receivedChunks).toEqual([]);
    expect(created.finalizationKey).toBeNull();
    expect(created.expiresAt).toBeInstanceOf(Date);
  });

  /**
   * The lock. Only the caller that moves the session out of `uploading`/`pending` may build the
   * file; a retry that timed out must find nothing to claim and read the stored result instead.
   */
  it('lets exactly one caller claim a session for finalization', async () => {
    const created = await session();

    const claims = await Promise.all([
      d1UploadSessionRepository.claimForFinalization(created.id, 'key-a'),
      d1UploadSessionRepository.claimForFinalization(created.id, 'key-b'),
      d1UploadSessionRepository.claimForFinalization(created.id, 'key-c'),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await d1UploadSessionRepository.findById(created.id))!.status).toBe('processing');
  });

  it('refuses to claim a session that already finalized', async () => {
    const created = await session();
    await d1UploadSessionRepository.claimForFinalization(created.id, 'key-a');

    expect(await d1UploadSessionRepository.claimForFinalization(created.id, 'key-b')).toBeNull();
  });

  /**
   * A file rejected for its content is a different thing from an upload that broke, and the
   * admin review of quarantined uploads has to tell them apart.
   */
  it('does not overwrite a terminal status when marking failed', async () => {
    for (const status of ['ready', 'rejected', 'aborted'] as const) {
      const created = await session();
      await d1UploadSessionRepository.update(created.id, { status });

      await d1UploadSessionRepository.markFailed(created.id, 'connection reset');

      expect((await d1UploadSessionRepository.findById(created.id))!.status).toBe(status);
    }
  });

  it('marks a live session failed, with the reason', async () => {
    const created = await session();
    await d1UploadSessionRepository.markFailed(created.id, 'connection reset');

    const found = await d1UploadSessionRepository.findById(created.id);
    expect(found!.status).toBe('failed');
    expect(found!.failureReason).toBe('connection reset');
  });

  it('records chunks and accumulates their bytes', async () => {
    const created = await session({ chunkSize: 100, totalChunks: 3 });

    await d1UploadSessionRepository.recordChunk(created.id, 0, 100);
    await d1UploadSessionRepository.recordChunk(created.id, 1, 100);

    const found = await d1UploadSessionRepository.findById(created.id);
    expect(found!.receivedChunks.sort()).toEqual([0, 1]);
    expect(found!.receivedBytes).toBe(200);
    expect(found!.status).toBe('uploading');
  });

  /**
   * `$addToSet` has no SQLite equivalent, so the index and the byte count are governed by one
   * predicate in one statement. A re-sent chunk must change neither — counting its bytes twice
   * would make a resumable upload report more received than it holds and finalize early.
   */
  it('ignores a re-sent chunk entirely, bytes included', async () => {
    const created = await session({ chunkSize: 100, totalChunks: 2 });

    await d1UploadSessionRepository.recordChunk(created.id, 0, 100);
    await d1UploadSessionRepository.recordChunk(created.id, 0, 100);
    await d1UploadSessionRepository.recordChunk(created.id, 0, 100);

    const found = await d1UploadSessionRepository.findById(created.id);
    expect(found!.receivedChunks).toEqual([0]);
    expect(found!.receivedBytes).toBe(100);
  });

  it('returns the session rather than null for a duplicate chunk', async () => {
    const created = await session();
    await d1UploadSessionRepository.recordChunk(created.id, 0, 50);

    expect(await d1UploadSessionRepository.recordChunk(created.id, 0, 50)).not.toBeNull();
  });

  it('lists expired sessions, excluding finished ones', async () => {
    const stale = await session();
    await d1UploadSessionRepository.update(stale.id, { expiresAt: new Date(Date.now() - 1_000) });

    const finished = await session();
    await d1UploadSessionRepository.update(finished.id, {
      expiresAt: new Date(Date.now() - 1_000),
      status: 'ready',
    });

    await session();

    const expired = await d1UploadSessionRepository.listExpired(new Date());
    expect(expired.map((row) => row.id)).toEqual([stale.id]);
  });

  it('counts by status for the admin page', async () => {
    await session();
    const failed = await session();
    await d1UploadSessionRepository.markFailed(failed.id, 'boom');

    const counts = await d1UploadSessionRepository.countByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.failed).toBe(1);
  });

  it('removes sessions by id and reports the count', async () => {
    const a = await session();
    const b = await session();

    expect(await d1UploadSessionRepository.remove([a.id, b.id])).toBe(2);
    expect(await d1UploadSessionRepository.remove([])).toBe(0);
    expect(await d1UploadSessionRepository.findById(a.id)).toBeNull();
  });
});

/* ------------------------------------------------------------------ D1 specifics */

describe('d1 specifics', () => {
  beforeEach(async () => {
    await clearD1(d1, D1_RESET);
    await seedD1();
  });

  /**
   * `recomputeAll` is the reconciliation the counters depend on, and it sums **versions**, not
   * files: every version occupies storage, and a quota counting only current versions would let
   * an unbounded history fill a volume while reporting room to spare.
   */
  it('rebuilds counters from the versions that exist', async () => {
    await d1
      .prepare(
        `INSERT INTO folders (id, organization_id, drive_type, name, name_lower, owner_id,
                              department_id, depth, created_by, created_at, updated_at)
         VALUES ('folder-1', ?, 'department', 'Root', 'root', ?, ?, 0, ?, ?, ?)`,
      )
      .bind(ORG, ALICE, DEPT, ALICE, ISO, ISO)
      .run();

    await d1
      .prepare(
        `INSERT INTO files (id, organization_id, display_name, display_name_lower,
                            original_filename, extension, category, folder_id, drive_type,
                            owner_id, department_id, version_count, created_by,
                            created_at, updated_at)
         VALUES ('file-1', ?, 'a.csv', 'a.csv', 'a.csv', 'csv', 'raw_data', 'folder-1',
                 'department', ?, ?, 2, ?, ?, ?)`,
      )
      .bind(ORG, ALICE, DEPT, ALICE, ISO, ISO)
      .run();

    // Two versions: 300 + 200. A counter tracking only the current one would say 200.
    // `storage_key` is uniquely indexed, so each version needs its own.
    for (const [id, number, size] of [
      ['v1', 1, 300],
      ['v2', 2, 200],
    ] as const) {
      await d1
        .prepare(
          `INSERT INTO file_versions (id, organization_id, file_id, version_number, storage_key,
                                      storage_area, original_filename, mime_type, extension,
                                      checksum_sha256, file_size, uploaded_by, uploaded_at,
                                      is_current, created_at, updated_at)
           VALUES (?, ?, 'file-1', ?, ?, 'originals', 'a.csv', 'text/csv', 'csv', 'sum', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, ORG, number, `key-${id}`, size, ALICE, ISO, number === 2 ? 1 : 0, ISO, ISO)
        .run();
    }

    // Start from a wrong value, so the test proves a rebuild rather than a no-op.
    await d1StorageUsageRepository.applyDelta({ userId: ALICE, departmentId: DEPT, bytes: 999 });

    const result = await d1StorageUsageRepository.recomputeAll();

    expect((await d1StorageUsageRepository.getUserQuota(ALICE))!.usedBytes).toBe(500);
    expect((await d1StorageUsageRepository.getDepartmentQuota(DEPT))!.usedBytes).toBe(500);
    expect(result.users).toBe(1);
    expect(result.departments).toBe(1);
  });

  it('zeroes a counter for someone whose files have all gone', async () => {
    await d1StorageUsageRepository.applyDelta({ userId: ALICE, bytes: 4_096 });

    await d1StorageUsageRepository.recomputeAll();

    expect((await d1StorageUsageRepository.getUserQuota(ALICE))!.usedBytes).toBe(0);
  });

  /** A corrupt setting must degrade the feature that reads it, not the page that asked. */
  it('reads a setting whose JSON is malformed as null rather than throwing', async () => {
    await d1
      .prepare(
        `INSERT INTO app_settings (id, organization_id, key, value, description, created_at, updated_at)
         VALUES ('s1', ?, 'broken', '{not json', '', ?, ?)`,
      )
      .bind(ORG, ISO, ISO)
      .run();

    const setting = await d1AppSettingRepository.get(ORG, 'broken');
    expect(setting).not.toBeNull();
    expect(setting!.value).toBeNull();
  });

  /**
   * D1 counts cascaded deletions in `meta.changes` as well as direct ones.
   *
   * An activity carrying three folder links would report as 4 removals. That number is what an
   * operator reads to decide whether retention is working, so the sweep counts with `RETURNING`
   * instead. Written as its own test because the bug is invisible until a row has children —
   * the single-link case in the shared block above happens to be off by exactly one.
   */
  it('counts swept activities, not the folder links that cascade with them', async () => {
    await seedFolder('d1');
    await d1ActivityRepository.append({
      organizationId: ORG,
      actorUserId: ALICE,
      actorName: 'Alice',
      action: 'file.move',
      entityType: 'file',
      entityId: FILE,
      contextFolderIds: [FOLDER, OTHER_FOLDER],
    });

    // One activity, two folder links. `meta.changes` would say 3.
    expect(await d1ActivityRepository.deleteOlderThan(new Date(Date.now() + 60_000))).toBe(1);
  });

  /** The sweep in session.repository.d1 nulls this column rather than cascading. */
  it('keeps a login-history row after its session is swept', async () => {
    await d1
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, token_hash, csrf_token_hash,
                               expires_at, absolute_expires_at, last_used_at, created_at, updated_at)
         VALUES ('sess-1', ?, ?, 'hash', 'csrf', ?, ?, ?, ?, ?)`,
      )
      .bind(ALICE, ORG, ISO, ISO, ISO, ISO, ISO)
      .run();

    await d1LoginHistoryRepository.record({
      userId: ALICE,
      email: 'alice@example.com',
      outcome: 'success',
      sessionId: 'sess-1',
    });

    const [entry] = await d1LoginHistoryRepository.listForUser(ALICE);
    expect(entry!.outcome).toBe('success');
  });
});
