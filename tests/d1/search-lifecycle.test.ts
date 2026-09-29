/**
 * Phase 3, module 10 — search and the lifecycle read paths on D1.
 *
 * Three repositories move together under `DATA_SOURCE_SEARCH` — stars, recent items and saved
 * searches — plus the FTS query builder they share with file search. What each needs proving is
 * different:
 *
 * **Stars and recent items are private, and that is enforced by shape.** Every method takes a
 * `userId` and there is no method that does not, so the tests here are about the *upsert
 * semantics*, which differ between the two in a way that is easy to get backwards: re-starring
 * must not reorder the Starred page, re-opening must reorder Recent. One is
 * `ON CONFLICT DO NOTHING`, the other `DO UPDATE`, and swapping them produces a plausible-
 * looking page that is quietly wrong.
 *
 * **Saved searches are the IDOR surface.** There is deliberately no `findById` on that
 * repository at all — every method takes `(userId, id)` and puts both in the WHERE clause — so
 * each one is tested against another user's row, not just its owner's.
 *
 * **The FTS builder is the injection and denial-of-service surface.** `MATCH` takes a query
 * *language*, so a raw search box string is both a syntax error waiting to happen and an
 * unbounded query. Both are asserted against real FTS5 rather than against the regex, because
 * what matters is what SQLite does with the output, not what the function returns.
 *
 * The suite runs against a real D1 through Miniflare, so unique indexes, `ON CONFLICT` and FTS5
 * behave as they do in the Worker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import * as stars from '@/server/repositories/star.repository.d1';
import * as recent from '@/server/repositories/recent-item.repository.d1';
import * as saved from '@/server/repositories/saved-search.repository.d1';
import * as fileRepository from '@/server/repositories/file.repository.d1';
import * as folderRepository from '@/server/repositories/folder.repository.d1';
import { toFtsQuery, MAX_FTS_TERMS } from '@/server/repositories/fts-query';
import {
  clearDataSourceOverrides,
  dataSourceFor,
  envVarFor,
  setDataSourceOverride,
} from '@/server/repositories/data-source';
import * as starFacade from '@/server/repositories/star.repository';
import * as recentFacade from '@/server/repositories/recent-item.repository';
import * as savedFacade from '@/server/repositories/saved-search.repository';
import type { FolderRecord } from '@/server/repositories/folder.repository.contract';
import type { Actor } from '@/server/permissions/actor';
import type { Permission } from '@/server/domain/permissions';

const ORG = '507f1f77bcf86cd799439011';
const ALICE = '507f1f77bcf86cd799439031';
const BOB = '507f1f77bcf86cd799439032';
const ISO = '2026-01-01T00:00:00.000Z';

let d1: D1Database;

/* ------------------------------------------------------------------ fixtures */

async function seedWorld(): Promise<void> {
  const run = (text: string, ...binds: unknown[]) => d1.prepare(text).bind(...binds).run();

  await run(
    `INSERT OR IGNORE INTO organizations (id,name,slug,email_domains,settings,storage_used_bytes,file_count,is_active,created_at,updated_at)
     VALUES (?,'Org A','orga','[]','{}',0,0,1,?,?)`,
    ORG, ISO, ISO,
  );

  for (const [id, email] of [
    [ALICE, 'alice@company.com'],
    [BOB, 'bob@company.com'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO users (id,organization_id,email,email_domain,name,mfa,preferences,status,is_super_admin,storage_quota_bytes,storage_used_bytes,must_change_password,failed_login_count,created_at,updated_at)
       VALUES (?,?,?,'company.com',?,'{"enabled":false}','{}','active',0,1,0,0,0,?,?)`,
      id, ORG, email, email.split('@')[0], ISO, ISO,
    );
  }
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: ALICE,
    email: 'alice@company.com',
    name: 'Alice',
    organizationId: ORG,
    departmentId: null,
    projectIds: [],
    isSuperAdmin: false,
    status: 'active',
    grants: [],
    permissions: new Set<Permission>(),
    roleKeys: [],
    highestRank: 0,
    sessionId: 's',
    storageQuotaBytes: 0,
    storageUsedBytes: 0,
    ...overrides,
  };
}

async function root(ownerId = ALICE): Promise<FolderRecord> {
  return folderRepository.ensureRoot({
    rootKey: `my:${ownerId}:${ORG}`,
    organizationId: ORG,
    name: 'My Drive',
    driveType: 'my',
    ownerId,
    departmentId: null,
    projectId: null,
    confidentiality: 'internal',
    createdBy: ownerId,
  });
}

async function file(folder: FolderRecord, name: string, ownerId = folder.ownerId) {
  return fileRepository.create({
    organizationId: ORG,
    displayName: name,
    originalFilename: name,
    extension: 'pdf',
    category: 'document',
    folderId: folder.id,
    folderPathAncestors: [...folder.pathAncestors, folder.id],
    driveType: folder.driveType,
    ownerId,
    departmentId: null,
    projectId: null,
    confidentiality: 'internal',
    sizeBytes: 10,
    mimeType: 'application/pdf',
    checksumSha256: 'c'.repeat(64),
    createdBy: ownerId,
  });
}

const searchInput = (over: Partial<Parameters<typeof fileRepository.search>[0]> = {}) => ({
  actor: actor(),
  page: 1,
  pageSize: 20,
  sort: 'relevance' as const,
  order: 'desc' as const,
  ...over,
});

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
  await clearD1(d1, [
    'DELETE FROM saved_searches',
    'DELETE FROM recent_items',
    'DELETE FROM stars',
    'DELETE FROM files_fts',
    'DELETE FROM file_metadata',
    'DELETE FROM file_folder_ancestors',
    'DELETE FROM resource_tags',
    'DELETE FROM resource_permissions',
    'DELETE FROM files',
    'DELETE FROM folder_ancestors',
    'DELETE FROM folders',
  ]);
  await seedWorld();
});

/* ================================================================== stars */

describe('stars are private, idempotent and stable', () => {
  it('adds once however many times it is called, and keeps the original timestamp', async () => {
    await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'f1' });
    const [first] = await stars.listForUser(ALICE);

    await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'f1' });
    await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'f1' });

    const rows = await stars.listForUser(ALICE);
    expect(rows).toHaveLength(1);
    // `DO NOTHING`, not `DO UPDATE`: re-starring must not push the item back to the top of a
    // page ordered by when it was starred.
    expect(rows[0]!.createdAt.toISOString()).toBe(first!.createdAt.toISOString());

    const row = await d1.prepare('SELECT COUNT(*) AS n FROM stars').first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('two people starring the same file get one row each', async () => {
    await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'f1' });
    await stars.add({ userId: BOB, organizationId: ORG, entityType: 'file', entityId: 'f1' });

    expect(await stars.listForUser(ALICE)).toHaveLength(1);
    expect(await stars.listForUser(BOB)).toHaveLength(1);
    // Alice's star is hers: unstarring must not remove it from Bob's page.
    await stars.remove({ userId: ALICE, entityType: 'file', entityId: 'f1' });
    expect(await stars.listForUser(ALICE)).toHaveLength(0);
    expect(await stars.listForUser(BOB)).toHaveLength(1);
  });

  it('separates a folder and a file that happen to share an id', async () => {
    await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'x' });
    await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'folder', entityId: 'x' });

    expect(await stars.listForUser(ALICE)).toHaveLength(2);
    expect(await stars.listForUser(ALICE, { entityType: 'file' })).toHaveLength(1);
    expect(await stars.starredIdsAmong(ALICE, 'file', ['x'])).toEqual(new Set(['x']));

    await stars.remove({ userId: ALICE, entityType: 'file', entityId: 'x' });
    // The folder star survives — `entity_type` is part of the key, not decoration.
    expect(await stars.listForUser(ALICE, { entityType: 'folder' })).toHaveLength(1);
  });

  it('answers starredIdsAmong for one user only, and for ids it was not given', async () => {
    await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'a' });
    await stars.add({ userId: BOB, organizationId: ORG, entityType: 'file', entityId: 'b' });

    const forAlice = await stars.starredIdsAmong(ALICE, 'file', ['a', 'b', 'c']);
    expect(forAlice).toEqual(new Set(['a']));
    expect(await stars.starredIdsAmong(ALICE, 'file', [])).toEqual(new Set());
  });

  /**
   * The chunking path. `starredIdsAmong` is called with a whole page of ids, and D1 refuses a
   * statement with too many bound parameters — so the repository splits at 100. A test with 99
   * ids would never exercise the split.
   */
  it('handles more ids than fit in one IN clause', async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `file-${index}`);
    for (const entityId of ids.slice(0, 120)) {
      await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId });
    }

    const found = await stars.starredIdsAmong(ALICE, 'file', ids);
    expect(found.size).toBe(120);
    expect(found.has('file-0')).toBe(true);
    expect(found.has('file-119')).toBe(true);
    expect(found.has('file-120')).toBe(false);

    await stars.removeAllFor('file', ids);
    expect(await stars.listForUser(ALICE)).toHaveLength(0);
  });

  it('removeAllFor clears every viewer’s star on a purged item', async () => {
    await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'gone' });
    await stars.add({ userId: BOB, organizationId: ORG, entityType: 'file', entityId: 'gone' });
    await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'kept' });

    await stars.removeAllFor('file', ['gone']);

    expect((await stars.listForUser(ALICE)).map((row) => row.entityId)).toEqual(['kept']);
    expect(await stars.listForUser(BOB)).toHaveLength(0);
  });
});

/* ================================================================== recent */

describe('recent is a set ordered by last touch, not a log', () => {
  it('upserts rather than appending, and moves the item to the top', async () => {
    for (const entityId of ['a', 'b', 'c']) {
      await recent.touch({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId });
    }
    expect((await recent.listForUser(ALICE)).map((row) => row.entityId)).toEqual(['c', 'b', 'a']);

    // Opening `a` again moves it, and does not add a fourth row.
    await recent.touch({
      userId: ALICE,
      organizationId: ORG,
      entityType: 'file',
      entityId: 'a',
      action: 'edited',
    });

    const rows = await recent.listForUser(ALICE);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.entityId).toBe('a');
    // `DO UPDATE`, unlike stars: the action is refreshed too.
    expect(rows[0]!.lastAction).toBe('edited');
  });

  it('leaves the organization alone on re-touch, as $setOnInsert did', async () => {
    await recent.touch({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'a' });
    await recent.touch({
      userId: ALICE,
      organizationId: 'some-other-org',
      entityType: 'file',
      entityId: 'a',
    });

    const row = await d1
      .prepare('SELECT organization_id AS org FROM recent_items WHERE entity_id = ?')
      .bind('a')
      .first<{ org: string }>();
    // A row's tenant is set once. An access must not be able to rewrite it.
    expect(row?.org).toBe(ORG);
  });

  it('keeps one person’s history out of another’s', async () => {
    await recent.touch({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'a' });
    await recent.touch({ userId: BOB, organizationId: ORG, entityType: 'file', entityId: 'b' });

    expect((await recent.listForUser(ALICE)).map((row) => row.entityId)).toEqual(['a']);
    expect((await recent.listForUser(BOB)).map((row) => row.entityId)).toEqual(['b']);
  });

  it('filters by entity type and honours the limit', async () => {
    await recent.touch({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'f' });
    await recent.touch({ userId: ALICE, organizationId: ORG, entityType: 'folder', entityId: 'd' });

    expect(await recent.listForUser(ALICE, { entityType: 'folder' })).toHaveLength(1);
    expect(await recent.listForUser(ALICE, { limit: 1 })).toHaveLength(1);
  });

  it('removeAllFor clears a purged item from every history', async () => {
    await recent.touch({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId: 'x' });
    await recent.touch({ userId: BOB, organizationId: ORG, entityType: 'file', entityId: 'x' });

    await recent.removeAllFor('file', ['x']);

    expect(await recent.listForUser(ALICE)).toHaveLength(0);
    expect(await recent.listForUser(BOB)).toHaveLength(0);
  });
});

/* ================================================================== saved searches */

describe('a saved search is reachable only by its owner', () => {
  const criteria = { q: 'exosome', tags: ['qpcr'] };

  it('refuses every method to somebody else, without disclosing that the row exists', async () => {
    const mine = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Weekly',
      criteria,
    });

    // Not "throws" — `null`/`false`, which is what the routes turn into a 404. A different
    // error for "exists but not yours" would itself be the disclosure.
    expect(await saved.findOwned(BOB, mine.id)).toBeNull();
    expect(await saved.update(BOB, mine.id, { name: 'Stolen' })).toBeNull();
    expect(await saved.remove(BOB, mine.id)).toBe(false);
    await saved.markRun(BOB, mine.id);

    const stillMine = await saved.findOwned(ALICE, mine.id);
    expect(stillMine).toMatchObject({ name: 'Weekly', runCount: 0 });
  });

  it('round-trips the criteria object through JSON', async () => {
    const record = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Round trip',
      criteria,
    });
    expect(record.criteria).toEqual(criteria);
    expect((await saved.findOwned(ALICE, record.id))!.criteria).toEqual(criteria);
  });

  it('replaces rather than duplicating when the same name is saved again', async () => {
    const first = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Weekly',
      criteria: { q: 'one' },
    });
    const second = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      // Case-folded: the unique index is on `name_lower`, so this is the same search.
      name: 'weekly',
      criteria: { q: 'two' },
    });

    expect(second.id).toBe(first.id);
    expect(second.criteria).toEqual({ q: 'two' });
    expect(await saved.listForUser(ALICE)).toHaveLength(1);
  });

  it('lets two people keep a search under the same name', async () => {
    await saved.upsert({ organizationId: ORG, userId: ALICE, name: 'Weekly', criteria });
    await saved.upsert({ organizationId: ORG, userId: BOB, name: 'Weekly', criteria });

    expect(await saved.listForUser(ALICE)).toHaveLength(1);
    expect(await saved.listForUser(BOB)).toHaveLength(1);
  });

  it('leaves the pin alone when upsert does not mention it', async () => {
    const pinned = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Weekly',
      criteria,
      isPinned: true,
    });
    expect(pinned.isPinned).toBe(true);

    const again = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Weekly',
      criteria: { q: 'changed' },
    });
    expect(again.isPinned).toBe(true);
  });

  it('lists pinned searches first', async () => {
    await saved.upsert({ organizationId: ORG, userId: ALICE, name: 'Plain', criteria });
    await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Pinned',
      criteria,
      isPinned: true,
    });

    expect((await saved.listForUser(ALICE)).map((row) => row.name)).toEqual(['Pinned', 'Plain']);
  });

  it('counts runs in the statement so concurrent runs are not lost', async () => {
    const record = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Counted',
      criteria,
    });

    await Promise.all([
      saved.markRun(ALICE, record.id),
      saved.markRun(ALICE, record.id),
      saved.markRun(ALICE, record.id),
    ]);

    const after = await saved.findOwned(ALICE, record.id);
    expect(after?.runCount).toBe(3);
    expect(after?.lastRunAt).toBeInstanceOf(Date);
  });

  it('returns an empty criteria object rather than throwing on unparseable JSON', async () => {
    const record = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Corrupt',
      criteria,
    });
    // The state a bad migration or a hand-edited row would leave behind.
    await d1
      .prepare('UPDATE saved_searches SET criteria = ? WHERE id = ?')
      .bind('{not json', record.id)
      .run();

    // One corrupted row must not make the whole saved-search list un-openable.
    const listed = await saved.listForUser(ALICE);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.criteria).toEqual({});
  });

  it('renames and unpins through update, and deletes through remove', async () => {
    const record = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Before',
      criteria,
      isPinned: true,
    });

    const renamed = await saved.update(ALICE, record.id, { name: 'After', isPinned: false });
    expect(renamed).toMatchObject({ name: 'After', isPinned: false });

    // The rename moved `name_lower` too, or saving under "after" would collide invisibly.
    const resaved = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'after',
      criteria,
    });
    expect(resaved.id).toBe(record.id);

    expect(await saved.remove(ALICE, record.id)).toBe(true);
    expect(await saved.remove(ALICE, record.id)).toBe(false);
    expect(await saved.listForUser(ALICE)).toHaveLength(0);
  });

  it('update with no changes is a read, not a write', async () => {
    const record = await saved.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Untouched',
      criteria,
    });
    const same = await saved.update(ALICE, record.id, {});
    expect(same).toMatchObject({ id: record.id, name: 'Untouched' });
    expect(same!.updatedAt.toISOString()).toBe(record.updatedAt.toISOString());
  });
});

/* ================================================================== the FTS builder */

describe('the shared FTS query builder', () => {
  it('strips every FTS5 metacharacter before quoting', () => {
    // One phrase per typed word: `S-4471` must not match `S-2222` on the shared `S`.
    expect(toFtsQuery('S-4471')).toBe('"S 4471"');
    expect(toFtsQuery('col:value')).toBe('"col value"');
    expect(toFtsQuery('"unbalanced')).toBe('"unbalanced"');
    // ...and OR between words, matching what `$text` does with a space-separated query.
    expect(toFtsQuery('sample* AND -x')).toBe('"sample" OR "AND" OR "x"');
  });

  it('keeps a hyphenated identifier from matching its neighbours', async () => {
    const home = await root();
    await file(home, 'S-1111.pdf');
    await file(home, 'S-2222.pdf');

    const exact = await fileRepository.search(searchInput({ text: 'S-1111' }));
    expect(exact.items.map((row) => row.displayName)).toEqual(['S-1111.pdf']);

    // The whole point: the shared `S` must not drag the other one in.
    expect(exact.total).toBe(1);
  });

  it('returns null when nothing searchable survives', () => {
    for (const text of ['***', '--', '   ', '"', '^', '(){}[]']) {
      expect(toFtsQuery(text), text).toBeNull();
    }
  });

  it('caps the number of OR branches', () => {
    const many = Array.from({ length: 500 }, (_, index) => `term${index}`).join(' ');
    const query = toFtsQuery(many)!;
    expect(query.split(' OR ')).toHaveLength(MAX_FTS_TERMS);
  });

  it('keeps non-ASCII words, which a \\w-based tokenizer would delete', () => {
    expect(toFtsQuery('Müller 検体')).toBe('"Müller" OR "検体"');
  });

  /**
   * Against real FTS5, not against the regex. What matters is that SQLite accepts the output —
   * a builder that returns a plausible string SQLite then rejects is a 500 on the search page.
   */
  it('produces MATCH arguments FTS5 accepts, for input designed to break it', async () => {
    const home = await root();
    await file(home, 'notes.pdf');

    const hostile = [
      'NEAR', 'OR', 'AND', 'NOT', '"', '""', 'a*', '^anchor', 'col:value',
      'sample-1 AND', '(unbalanced', 'x" OR files_fts MATCH "y', "'; DROP TABLE files; --",
      '***', '🧬', 'Müller',
    ];

    for (const text of hostile) {
      const page = await fileRepository.search(searchInput({ text }));
      expect(Array.isArray(page.items), text).toBe(true);
    }
  });

  /**
   * The important half of the null case.
   *
   * `toFtsQuery('***')` is `null`, and the tempting implementation is `if (match) push(...)` —
   * which drops the text filter entirely and answers with every file the actor can see. On a
   * search page that reads as a disclosure: the user asked one question and was shown the
   * answer to another.
   */
  it('treats unsearchable text as no results, never as no filter', async () => {
    const home = await root();
    await file(home, 'alpha.pdf');
    await file(home, 'beta.pdf');

    // Sanity: with no text at all, both files come back.
    expect((await fileRepository.search(searchInput())).total).toBe(2);

    const page = await fileRepository.search(searchInput({ text: '***' }));
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('matches any term rather than all of them, as $text does', async () => {
    const home = await root();
    await file(home, 'exosome-yield.pdf');
    await file(home, 'plasma-prep.pdf');

    const page = await fileRepository.search(searchInput({ text: 'exosome plasma' }));
    expect(page.total).toBe(2);
  });
});

/* ================================================================== lifecycle views hold files */

/**
 * The regression these views existed to have.
 *
 * Recent, Starred and Trash each render folders *and* files, and the bug that shipped was a
 * page that showed only folders while the endpoints behind it had been returning both all
 * along. On the D1 side the equivalent failure is a repository that answers the folder half
 * and silently returns nothing for the file half, which no folder-only assertion would catch.
 */
describe('the lifecycle read paths return files, not only folders', () => {
  it('lists a trashed file, and counts it, without the folder it was in', async () => {
    const home = await root();
    const created = await file(home, 'deleted.pdf');
    await fileRepository.setDeleted({ fileId: created.id, deleted: true, userId: ALICE });

    const page = await fileRepository.listTrashed({ actor: actor(), page: 1, pageSize: 20 });
    expect(page.items.map((row) => row.displayName)).toEqual(['deleted.pdf']);
    expect(page.total).toBe(1);
  });

  it('does not list a file swept into the trash with its parent folder', async () => {
    const home = await root();
    const branch = await folderRepository.create({
      organizationId: ORG,
      name: 'Branch',
      parentFolderId: home.id,
      pathAncestors: [...home.pathAncestors, home.id],
      depth: home.depth + 1,
      driveType: home.driveType,
      ownerId: ALICE,
      departmentId: null,
      projectId: null,
      confidentiality: 'internal',
      createdBy: ALICE,
    });
    const swept = await file(branch, 'swept.pdf');
    await fileRepository.setDeleted({
      fileId: swept.id,
      deleted: true,
      userId: ALICE,
      withFolderId: branch.id,
    });

    // Trash shows what the user deleted, not everything that went with it — restoring the
    // folder brings this back on its own.
    const page = await fileRepository.listTrashed({ actor: actor(), page: 1, pageSize: 20 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('lists a file shared with the actor, and not their own', async () => {
    const home = await root();
    const theirs = await file(home, 'handed-over.pdf', ALICE);
    const bobsHome = await root(BOB);
    await file(bobsHome, 'bobs-own.pdf', BOB);

    await d1
      .prepare(
        `INSERT INTO resource_permissions (id,organization_id,resource_type,resource_id,principal_type,principal_id,access_level,deny,expires_at,granted_by,granted_at)
         VALUES (?,?,'file',?,'user',?,'view',0,NULL,?,?)`,
      )
      .bind(crypto.randomUUID(), ORG, theirs.id, BOB, ALICE, ISO)
      .run();

    const page = await fileRepository.listSharedWith({
      actor: actor({ userId: BOB }),
      principalIds: [BOB],
      excludeOwnerId: BOB,
      page: 1,
      pageSize: 20,
    });
    expect(page.items.map((row) => row.displayName)).toEqual(['handed-over.pdf']);
    expect(page.total).toBe(1);
  });

  it('excludes a hidden row from the trash total as well as the page', async () => {
    const home = await root();
    const mine = await file(home, 'mine.pdf', ALICE);
    const theirs = await file(home, 'theirs.pdf', BOB);
    for (const target of [mine, theirs]) {
      await fileRepository.setDeleted({ fileId: target.id, deleted: true, userId: target.ownerId });
    }

    // Bob owns one of them and can reach neither the other file nor knowledge of it.
    const page = await fileRepository.listTrashed({
      actor: actor({ userId: BOB }),
      page: 1,
      pageSize: 20,
    });
    expect(page.items.map((row) => row.displayName)).toEqual(['theirs.pdf']);
    // A total of 2 would disclose that Alice deleted something.
    expect(page.total).toBe(1);
  });
});

/* ================================================================== routing */

describe('the search module routes on its own flag', () => {
  afterAll(() => clearDataSourceOverrides());

  /**
   * The default is the thing worth pinning. An unset variable, a typo and a misspelled module
   * name must all resolve to the database currently serving production — the only way to read
   * D1 is to ask for it by the exact string.
   */
  it('is on Mongo until the flag says otherwise, by exact match', () => {
    clearDataSourceOverrides();
    expect(dataSourceFor('search')).toBe('mongo');
    expect(envVarFor('search')).toBe('DATA_SOURCE_SEARCH');

    setDataSourceOverride('search', 'd1');
    expect(dataSourceFor('search')).toBe('d1');
  });

  /**
   * The three repositories share one flag, so the test writes through all three façades and
   * checks all three D1 tables. Wiring one of them to the wrong flag would leave its table
   * empty here while the other two passed.
   */
  it('writes through the façade to D1 once the flag is set', async () => {
    setDataSourceOverride('search', 'd1');

    await starFacade.add({
      userId: ALICE,
      organizationId: ORG,
      entityType: 'file',
      entityId: 'via-facade',
    });
    await recentFacade.touch({
      userId: ALICE,
      organizationId: ORG,
      entityType: 'file',
      entityId: 'via-facade',
    });
    const record = await savedFacade.upsert({
      organizationId: ORG,
      userId: ALICE,
      name: 'Via façade',
      criteria: { q: 'x' },
    });

    const counts = await d1
      .prepare(
        `SELECT (SELECT COUNT(*) FROM stars) AS stars,
                (SELECT COUNT(*) FROM recent_items) AS recents,
                (SELECT COUNT(*) FROM saved_searches) AS searches`,
      )
      .first<{ stars: number; recents: number; searches: number }>();

    expect(counts).toEqual({ stars: 1, recents: 1, searches: 1 });
    expect(await savedFacade.findOwned(ALICE, record.id)).not.toBeNull();
  });
});
