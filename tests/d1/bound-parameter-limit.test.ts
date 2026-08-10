/**
 * D1's bound-parameter ceiling, and the reads that used to walk into it.
 *
 * ── Why this suite exists ───────────────────────────────────────────────────────────────
 *
 * Several comments across the D1 layer were written against SQLite's compile-time
 * `SQLITE_MAX_VARIABLE_NUMBER`, whose default is 999. **D1's limit is 100**, and the difference
 * is not academic: `listStarred` fetches up to 200 star ids and hands them to `findByIds`, and
 * a drive folder at the maximum page size hydrates a hundred files. Both were over the line,
 * and both fail as `D1_ERROR: too many SQL variables` — an opaque 500 on an ordinary page,
 * arriving only once a user had starred their hundredth file.
 *
 * The first test measures the ceiling rather than asserting a remembered number, so if a future
 * D1 changes it this suite says so instead of a page failing in production. The rest prove the
 * reads that carry caller-sized lists survive a list far past it, which they now do because
 * `inList` binds the whole list as one JSON parameter.
 *
 * ── Why 250 ─────────────────────────────────────────────────────────────────────────────
 *
 * Comfortably past 100 and past any chunk size that might be reintroduced by accident, while
 * staying small enough that the fixtures build in seconds. A test at 99 would pass against the
 * broken code, which is the only thing that matters about the number.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting, getD1 } from '@/server/db/d1-context';
import { D1_MAX_BOUND_PARAMS, inList } from '@/server/db/d1-bindings';
import { files } from '@/server/db/schema/drive';
import * as fileRepository from '@/server/repositories/file.repository.d1';
import * as folderRepository from '@/server/repositories/folder.repository.d1';
import * as versionRepository from '@/server/repositories/file-version.repository.d1';
import * as stars from '@/server/repositories/star.repository.d1';
import * as recent from '@/server/repositories/recent-item.repository.d1';
import type { FolderRecord } from '@/server/repositories/folder.repository.contract';
import type { Actor } from '@/server/permissions/actor';
import type { Permission } from '@/server/domain/permissions';

const ORG = '507f1f77bcf86cd799439011';
const ALICE = '507f1f77bcf86cd799439031';
const ISO = '2026-01-01T00:00:00.000Z';

/**
 * Past the ceiling by a wide margin, and past any plausible chunk size that might be
 * reintroduced by accident. A test at 99 would pass against the broken code, which is the only
 * thing that matters about the number — beyond that it is chosen to keep the fixture cheap.
 */
const MANY = 150;

let d1: D1Database;

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

async function seedWorld(): Promise<void> {
  const run = (text: string, ...binds: unknown[]) => d1.prepare(text).bind(...binds).run();
  await run(
    `INSERT OR IGNORE INTO organizations (id,name,slug,email_domains,settings,storage_used_bytes,file_count,is_active,created_at,updated_at)
     VALUES (?,'Org A','orga','[]','{}',0,0,1,?,?)`,
    ORG, ISO, ISO,
  );
  await run(
    `INSERT OR IGNORE INTO users (id,organization_id,email,email_domain,name,mfa,preferences,status,is_super_admin,storage_quota_bytes,storage_used_bytes,must_change_password,failed_login_count,created_at,updated_at)
     VALUES (?,?,'alice@company.com','company.com','Alice','{"enabled":false}','{}','active',0,1,0,0,0,?,?)`,
    ALICE, ORG, ISO, ISO,
  );
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

/** `MANY` files in one folder, each with a tag and a metadata key so hydration has work. */
async function manyFiles(folder: FolderRecord): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < MANY; index += 1) {
    const created = await fileRepository.create({
      organizationId: ORG,
      displayName: `file-${index}.pdf`,
      originalFilename: `file-${index}.pdf`,
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
      checksumSha256: 'c'.repeat(64),
      tags: ['bulk'],
      metadata: { sampleId: `S-${index}` },
      createdBy: ALICE,
    });
    ids.push(created.id);
  }
  return ids;
}

/**
 * Seeded once, not per test.
 *
 * Building `MANY` files through the real `create()` — four statements each, against a real
 * engine — costs tens of seconds, and rebuilding it for every test made this suite slower than
 * every other one combined. The shared set is read-only for most tests; the two that write
 * (stars/recent, versions) use their own tables and clean up after themselves, so nothing here
 * depends on declaration order.
 */
let folder: FolderRecord;
let fileIds: string[];

beforeAll(async () => {
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
  await seedWorld();
  folder = await root();
  fileIds = await manyFiles(folder);
}, 600_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  await stopTestD1();
});

beforeEach(async () => {
  // Only what the writing tests touch. The file corpus survives.
  await clearD1(d1, ['DELETE FROM recent_items', 'DELETE FROM stars']);
});

describe('the engine’s own limit', () => {
  /**
   * Measured, not asserted from memory. The loop finds the largest accepted count and compares
   * it with the constant the repositories are written against, so a change in either direction
   * fails here rather than in a user's browser.
   */
  it('refuses more than D1_MAX_BOUND_PARAMS placeholders in one statement', async () => {
    const accepts = async (count: number) => {
      const placeholders = Array.from({ length: count }, () => '?').join(',');
      try {
        await d1
          .prepare(`SELECT id FROM organizations WHERE id IN (${placeholders})`)
          .bind(...Array.from({ length: count }, (_, index) => `x${index}`))
          .all();
        return true;
      } catch {
        return false;
      }
    };

    expect(await accepts(D1_MAX_BOUND_PARAMS)).toBe(true);
    expect(await accepts(D1_MAX_BOUND_PARAMS + 1)).toBe(false);
  });

  /**
   * The property the whole fix rests on: list length no longer costs parameters. 5,000 ids in
   * one statement is not a real query shape, it is a demonstration that the coupling is gone.
   */
  it('binds any list length as a single parameter through inList', async () => {
    const db = await getD1();
    const needle = fileIds[0]!;
    const haystack = [...Array.from({ length: 5_000 }, (_, index) => `absent-${index}`), needle];

    const rows = await db.select({ id: files.id }).from(files).where(inList(files.id, haystack));
    expect(rows.map((row) => row.id)).toEqual([needle]);
  });

  /**
   * An empty list must match nothing. The alternative — omitting the clause — turns "none of
   * these" into "every row", which on a permission-filtered read is a disclosure.
   */
  it('matches nothing for an empty list rather than everything', async () => {
    const db = await getD1();
    const rows = await db.select({ id: files.id }).from(files).where(inList(files.id, []));
    expect(rows).toEqual([]);
  });
});

describe('reads that carry a caller-sized list', () => {
  it('findByIds hydrates far more files than fit in a parameter list', async () => {
    const found = await fileRepository.findByIds(actor(), fileIds);
    expect(found).toHaveLength(MANY);
    // Hydration is four more `IN` queries — ancestors, ACL, metadata, tags — and each was its
    // own copy of the same hazard.
    expect(found[0]!.tags).toEqual(['bulk']);
    expect(found[0]!.folderPathAncestors.length).toBeGreaterThan(0);
    expect(Object.keys(found[0]!.metadata)).toContain('sampleId');
  });

  it('findByIdsInternal does too, on the bypass path', async () => {
    expect(await fileRepository.findByIdsInternal(fileIds)).toHaveLength(MANY);
  });

  it('starredIdsAmong annotates a whole page at once', async () => {
    for (const entityId of fileIds) {
      await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId });
    }
    expect((await stars.starredIdsAmong(ALICE, 'file', fileIds)).size).toBe(MANY);
  });

  it('the star and recent purge hooks clear a large batch', async () => {
    for (const entityId of fileIds) {
      await stars.add({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId });
      await recent.touch({ userId: ALICE, organizationId: ORG, entityType: 'file', entityId });
    }

    await stars.removeAllFor('file', fileIds);
    await recent.removeAllFor('file', fileIds);

    expect(await stars.listForUser(ALICE)).toHaveLength(0);
    expect(await recent.listForUser(ALICE, { limit: MANY })).toHaveLength(0);
  });

  it('folder findByIdsInternal survives a large sibling set', async () => {
    const ids: string[] = [];
    for (let index = 0; index < MANY; index += 1) {
      const branch = await folderRepository.create({
        organizationId: ORG,
        name: `branch-${index}`,
        parentFolderId: folder.id,
        pathAncestors: [...folder.pathAncestors, folder.id],
        depth: folder.depth + 1,
        driveType: folder.driveType,
        ownerId: ALICE,
        departmentId: null,
        projectId: null,
        confidentiality: 'internal',
        createdBy: ALICE,
      });
      ids.push(branch.id);
    }

    expect(await folderRepository.findByIdsInternal(ids)).toHaveLength(MANY);
  });

  /**
   * The principals list is the other caller-sized list, and it is the dangerous one: it is
   * bound inside the visibility predicate of *every* permission-aware read, so an actor with
   * enough roles and projects used to break every listing at once rather than one page.
   */
  it('a listing survives an actor carrying far more principals than fit', async () => {
    const crowded = actor({
      projectIds: Array.from({ length: MANY }, (_, index) => `project-${index}`),
    });

    const page = await fileRepository.listInFolder({
      actor: crowded,
      folderId: folder.id,
      page: 1,
      pageSize: 50,
      sort: 'displayName',
      order: 'asc',
    });
    expect(page.total).toBe(MANY);
    expect(page.items).toHaveLength(50);
  });

  /**
   * Last, because it removes the versions it creates. Nothing else reads them.
   */
  it('version storage locations and purge handle a large file set', async () => {
    for (const fileId of fileIds) {
      await versionRepository.create({
        organizationId: ORG,
        fileId,
        versionNumber: 1,
        storageKey: `originals/${fileId}/v1`,
        storageArea: 'originals',
        relativeStoragePath: `originals/${fileId}/v1`,
        storedFilename: 'v1',
        originalFilename: 'file.pdf',
        fileSize: 10,
        mimeType: 'application/pdf',
        extension: 'pdf',
        checksumSha256: 'd'.repeat(64),
        uploadedBy: ALICE,
      });
    }

    expect(await versionRepository.getStorageLocationsForFiles(fileIds)).toHaveLength(MANY);
    expect(await versionRepository.purgeForFiles(fileIds)).toBe(MANY);
  });
});
