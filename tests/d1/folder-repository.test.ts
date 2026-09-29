/**
 * Phase 3, module 5 — the D1 folder repository.
 *
 * Two things are being proved here, and they need different kinds of test.
 *
 * **Isolation.** Every read is asserted on *which rows come back* and, separately, on the
 * `total` the same call reports. A folder that is absent from the page but present in the count
 * is still disclosed — the count is how you find out that something is there. Nothing in these
 * tests filters in JavaScript; the repository either returns the row or it does not.
 *
 * **Hierarchy.** `folders.parent_folder_id` and `folder_ancestors` are two representations of
 * one truth, and a subtree mutation that updates one and not the other produces a tree that
 * still reads correctly until somebody moves something. So every mutation test finishes by
 * running `checkHierarchyIntegrity`, which compares the two directly — including the concurrency
 * cases, where the interesting outcome is not "did it succeed" but "is the tree still coherent
 * if it did not".
 *
 * The suite runs against a real D1 through Miniflare (see `helpers/test-d1.ts`), so batches,
 * `RETURNING`, partial indexes and foreign keys behave as they do in the Worker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { and, eq, sql } from 'drizzle-orm';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting, getD1 } from '@/server/db/d1-context';
import { folders, folderAncestors } from '@/server/db/schema/drive';
import { clearDataSourceOverrides, setDataSourceOverride } from '@/server/repositories/data-source';
import * as repository from '@/server/repositories/folder.repository.d1';
import { TooManyPrincipalsError, MAX_ACTOR_PRINCIPALS } from '@/server/permissions/visibility.d1';
import type { Actor, RoleGrant } from '@/server/permissions/actor';
import type { Permission } from '@/server/domain/permissions';
import type { FolderRecord } from '@/server/repositories/folder.repository.contract';

const ORG = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';

const ALICE = '507f1f77bcf86cd799439031';
const BOB = '507f1f77bcf86cd799439032';
const CAROL = '507f1f77bcf86cd799439033';
const FOREIGNER = '507f1f77bcf86cd799439034';

const DEPT_A = '507f1f77bcf86cd799439041';
const DEPT_B = '507f1f77bcf86cd799439042';
const PROJ_A = '507f1f77bcf86cd799439051';
const PROJ_B = '507f1f77bcf86cd799439052';
const ROLE = '507f1f77bcf86cd799439061';

const ISO = '2026-01-01T00:00:00.000Z';
const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2099-01-01T00:00:00.000Z');

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
      id,
      name,
      id.slice(-4),
      ISO,
      ISO,
    );
  }

  for (const [id, organizationId, email] of [
    [ALICE, ORG, 'alice@company.com'],
    [BOB, ORG, 'bob@company.com'],
    [CAROL, ORG, 'carol@company.com'],
    [FOREIGNER, ORG_B, 'zed@other.com'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO users (id,organization_id,email,email_domain,name,mfa,preferences,status,is_super_admin,storage_quota_bytes,storage_used_bytes,must_change_password,failed_login_count,created_at,updated_at)
       VALUES (?,?,?,'company.com',?,'{"enabled":false}','{}','active',0,1,0,0,0,?,?)`,
      id,
      organizationId,
      email,
      email.split('@')[0],
      ISO,
      ISO,
    );
  }

  for (const [id, code] of [
    [DEPT_A, 'AAA'],
    [DEPT_B, 'BBB'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO departments (id,organization_id,name,code,description,storage_quota_bytes,storage_used_bytes,member_count,is_active,created_at,updated_at)
       VALUES (?,?,?,?,'',1,0,0,1,?,?)`,
      id,
      ORG,
      `Dept ${code}`,
      code,
      ISO,
      ISO,
    );
  }

  for (const [id, departmentId, code] of [
    [PROJ_A, DEPT_A, 'PA'],
    [PROJ_B, DEPT_B, 'PB'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO projects (id,organization_id,department_id,name,code,description,status,confidentiality,storage_used_bytes,file_count,created_at,updated_at)
       VALUES (?,?,?,?,?,'','active','internal',0,0,?,?)`,
      id,
      ORG,
      departmentId,
      `Project ${code}`,
      code,
      ISO,
      ISO,
    );
  }

  await run(
    `INSERT OR IGNORE INTO roles (id,organization_id,key,name,description,rank,max_confidentiality,company_wide_read,is_system,created_at,updated_at)
     VALUES (?,?,'reviewer','Reviewer','',40,'confidential',0,0,?,?)`,
    ROLE,
    ORG,
    ISO,
    ISO,
  );
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: BOB,
    email: 'bob@company.com',
    name: 'Bob',
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

function grant(overrides: Partial<RoleGrant> = {}): RoleGrant {
  return {
    roleId: ROLE,
    roleKey: 'reviewer',
    roleName: 'Reviewer',
    rank: 40,
    scopeType: 'company',
    scopeId: null,
    permissions: [],
    maxConfidentiality: 'confidential',
    companyWideRead: false,
    ...overrides,
  };
}

/** Alice's personal drive root — the parent everything in these tests hangs off. */
async function root(options: { organizationId?: string; ownerId?: string; key?: string } = {}) {
  return repository.ensureRoot({
    rootKey: options.key ?? `my:${options.ownerId ?? ALICE}`,
    organizationId: options.organizationId ?? ORG,
    name: 'My Drive',
    driveType: 'my',
    ownerId: options.ownerId ?? ALICE,
    departmentId: null,
    projectId: null,
    confidentiality: 'internal',
    createdBy: options.ownerId ?? ALICE,
  });
}

interface FolderOptions {
  ownerId?: string;
  departmentId?: string | null;
  projectId?: string | null;
  confidentiality?: FolderRecord['confidentiality'];
  organizationId?: string;
}

async function child(
  parent: FolderRecord,
  name: string,
  options: FolderOptions = {},
): Promise<FolderRecord> {
  return repository.create({
    organizationId: options.organizationId ?? parent.organizationId,
    name,
    parentFolderId: parent.id,
    pathAncestors: [...parent.pathAncestors, parent.id],
    depth: parent.depth + 1,
    driveType: parent.driveType,
    ownerId: options.ownerId ?? ALICE,
    departmentId: options.departmentId === undefined ? parent.departmentId : options.departmentId,
    projectId: options.projectId === undefined ? parent.projectId : options.projectId,
    confidentiality: options.confidentiality ?? 'internal',
    createdBy: options.ownerId ?? ALICE,
  });
}

async function share(
  folder: FolderRecord,
  principalId: string,
  options: {
    deny?: boolean;
    expiresAt?: Date | null;
    principalType?: 'user' | 'department' | 'project' | 'role';
  } = {},
): Promise<void> {
  await repository.updateById(folder.id, {
    permissions: [
      {
        principalType: options.principalType ?? 'user',
        principalId,
        accessLevel: 'viewer',
        deny: options.deny ?? false,
        expiresAt: options.expiresAt ?? null,
      },
    ],
  });
}

async function breakInheritance(folderId: string): Promise<void> {
  await repository.updateById(folderId, { inheritPermissions: false });
}

/** Ids of the folders a listing returned, in the order it returned them. */
const names = (page: { items: FolderRecord[] }) => page.items.map((item) => item.name);

/* ------------------------------------------------------------------ harness */

beforeAll(async () => {
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
  await seedWorld();
}, 300_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  clearDataSourceOverrides();
  await stopTestD1();
});

const RESET = [
  'DELETE FROM resource_permissions',
  'DELETE FROM file_folder_ancestors',
  'DELETE FROM files',
  'DELETE FROM folder_ancestors',
  'UPDATE folders SET parent_folder_id = NULL, trashed_with_folder_id = NULL',
  'DELETE FROM folders',
];

beforeEach(async () => {
  await clearD1(d1, RESET);
  await seedWorld();
});

/* ================================================================== access control */

describe('permission-aware lookup', () => {
  it('1. refuses a folder the actor has no route to, however well they guess the id', async () => {
    const drive = await root();
    const secret = await child(drive, 'Alice notes');

    expect(await repository.findById(actor(), secret.id)).toBeNull();
    // …and the owner still gets it, so the test is not passing for the wrong reason.
    expect(await repository.findById(actor({ userId: ALICE }), secret.id)).not.toBeNull();
  });

  it('2 & 3. refuses across organizations, super admin included', async () => {
    const foreignDrive = await root({
      organizationId: ORG_B,
      ownerId: FOREIGNER,
      key: `my:${FOREIGNER}`,
    });
    const foreign = await child(foreignDrive, 'Their data', {
      ownerId: FOREIGNER,
      organizationId: ORG_B,
    });

    expect(await repository.findById(actor({ userId: ALICE }), foreign.id)).toBeNull();
    expect(
      await repository.findById(actor({ userId: ALICE, isSuperAdmin: true }), foreign.id),
    ).toBeNull();

    // A super admin of the *other* tenant can, which is what makes this isolation and not a
    // blanket refusal.
    expect(
      await repository.findById(
        actor({ userId: FOREIGNER, organizationId: ORG_B, isSuperAdmin: true }),
        foreign.id,
      ),
    ).not.toBeNull();
  });

  it('4 & 7. an explicit denial removes the folder, ownership included', async () => {
    const drive = await root();
    const shared = await child(drive, 'Shared');
    await share(shared, BOB);
    expect(await repository.findById(actor(), shared.id)).not.toBeNull();

    await share(shared, BOB, { deny: true });
    expect(await repository.findById(actor(), shared.id)).toBeNull();

    const owned = await child(drive, 'Owned by Bob', { ownerId: BOB });
    await share(owned, BOB, { deny: true });
    expect(await repository.findById(actor(), owned.id)).toBeNull();
  });

  it('5. an expired allow grants nothing', async () => {
    const drive = await root();
    const folder = await child(drive, 'Was shared');
    await share(folder, BOB, { expiresAt: PAST });

    expect(await repository.findById(actor(), folder.id)).toBeNull();

    await share(folder, BOB, { expiresAt: FUTURE });
    expect(await repository.findById(actor(), folder.id)).not.toBeNull();
  });

  it('6. an expired denial blocks nothing', async () => {
    const drive = await root();
    const folder = await child(drive, 'Bob owns this', { ownerId: BOB });
    await share(folder, BOB, { deny: true, expiresAt: PAST });

    expect(await repository.findById(actor(), folder.id)).not.toBeNull();
  });

  it('8, 9 & 10. a denial overrides department, project and role access', async () => {
    const drive = await root();
    const departmental = await child(drive, 'Dept work', { departmentId: DEPT_A });
    const projectWork = await child(drive, 'Project work', { projectId: PROJ_A });
    const roleShared = await child(drive, 'Role shared');
    await share(roleShared, ROLE, { principalType: 'role' });

    const viewer = actor({
      departmentId: DEPT_A,
      projectIds: [PROJ_A],
      grants: [grant()],
    });

    expect(await repository.findById(viewer, departmental.id)).not.toBeNull();
    expect(await repository.findById(viewer, projectWork.id)).not.toBeNull();
    expect(await repository.findById(viewer, roleShared.id)).not.toBeNull();

    await share(departmental, BOB, { deny: true });
    await share(projectWork, BOB, { deny: true });
    await share(roleShared, ROLE, { deny: true, principalType: 'role' });

    expect(await repository.findById(viewer, departmental.id)).toBeNull();
    expect(await repository.findById(viewer, projectWork.id)).toBeNull();
    expect(await repository.findById(viewer, roleShared.id)).toBeNull();
  });

  it('11. a denial overrides super-admin access', async () => {
    const drive = await root();
    const folder = await child(drive, 'Denied to the admin');
    await share(folder, BOB, { deny: true });

    const admin = actor({ isSuperAdmin: true });
    expect(await repository.findById(admin, folder.id)).toBeNull();
  });

  it('12 & 13. one department and one project cannot see the other', async () => {
    const drive = await root();
    const deptA = await child(drive, 'A work', { departmentId: DEPT_A, projectId: null });
    const deptB = await child(drive, 'B work', { departmentId: DEPT_B, projectId: null });
    const projA = await child(drive, 'A project', { departmentId: null, projectId: PROJ_A });
    const projB = await child(drive, 'B project', { departmentId: null, projectId: PROJ_B });

    // Clearance comes from role grants, and department/project access is gated by it — an
    // actor with no grant at all is capped at `public_internal` and would fail this test for
    // the wrong reason.
    const inA = actor({
      departmentId: DEPT_A,
      projectIds: [PROJ_A],
      grants: [grant({ maxConfidentiality: 'internal' })],
    });

    expect(await repository.findById(inA, deptA.id)).not.toBeNull();
    expect(await repository.findById(inA, deptB.id)).toBeNull();
    expect(await repository.findById(inA, projA.id)).not.toBeNull();
    expect(await repository.findById(inA, projB.id)).toBeNull();
  });

  it('14, 15 & 16. inheritance boundaries hold, and direct entries beneath them win', async () => {
    const drive = await root();
    const top = await child(drive, 'Top');
    const middle = await child(top, 'Middle');
    const bottom = await child(middle, 'Bottom');

    await share(top, BOB);
    expect(await repository.findById(actor(), bottom.id)).not.toBeNull();

    // 14. The middle folder stops inheriting, so nothing above it reaches the bottom.
    await breakInheritance(middle.id);
    expect(await repository.findById(actor(), bottom.id)).toBeNull();

    // 15. A direct grant beneath the boundary restores access…
    await share(bottom, BOB);
    expect(await repository.findById(actor(), bottom.id)).not.toBeNull();

    // 16. …and a direct denial beneath it takes it away again.
    await share(bottom, BOB, { deny: true });
    expect(await repository.findById(actor(), bottom.id)).toBeNull();
  });

  it('17. an actor with no principals at all sees only what they own', async () => {
    const drive = await root();
    const theirs = await child(drive, 'Bobs folder', { ownerId: BOB });
    const others = await child(drive, 'Alices folder');

    const loner = actor({ departmentId: null, projectIds: [], grants: [] });
    expect(await repository.findById(loner, theirs.id)).not.toBeNull();
    expect(await repository.findById(loner, others.id)).toBeNull();
  });

  it('18. an actor carrying too many principals fails closed rather than silently narrowing', async () => {
    const drive = await root();
    const folder = await child(drive, 'Anything', { ownerId: BOB });

    const overflowing = actor({
      projectIds: Array.from({ length: MAX_ACTOR_PRINCIPALS + 1 }, (_, index) => `p${index}`),
    });

    await expect(repository.findById(overflowing, folder.id)).rejects.toBeInstanceOf(
      TooManyPrincipalsError,
    );
  });

  it('20 & 21. a trashed folder is absent from ordinary reads and present only when asked for', async () => {
    const drive = await root();
    const folder = await child(drive, 'Deleted later', { ownerId: BOB });
    await repository.setSubtreeDeleted({ folderId: folder.id, deleted: true, userId: BOB });

    expect(await repository.findById(actor(), folder.id)).toBeNull();
    expect(await repository.findById(actor(), folder.id, { includeDeleted: true })).not.toBeNull();

    // The bypass is not a way around the *permission* — only around the soft-delete state.
    expect(
      await repository.findById(actor({ userId: CAROL }), folder.id, { includeDeleted: true }),
    ).toBeNull();
  });
});

describe('listings, counts and totals', () => {
  it('22 & 23. children, the count and the page total all exclude what the actor may not see', async () => {
    const drive = await root();
    const parent = await child(drive, 'Parent', { ownerId: BOB });
    await child(parent, 'Visible', { ownerId: BOB });
    await child(parent, 'Hidden one');
    await child(parent, 'Hidden two');

    const viewer = actor();
    const listInput = {
      actor: viewer,
      parentFolderId: parent.id,
      page: 1,
      pageSize: 10,
      sort: 'name' as const,
      order: 'asc' as const,
    };

    const page = await repository.listChildrenOf(listInput);
    expect(names(page)).toEqual(['Visible']);
    expect(page.total).toBe(1);
    expect(await repository.countChildrenOf({ actor: viewer, parentFolderId: parent.id })).toBe(1);

    // Somebody who may see all three does, so the numbers above are a filter and not an
    // empty database.
    const owner = await repository.listChildrenOf({
      ...listInput,
      actor: actor({ userId: ALICE, grants: [grant({ maxConfidentiality: 'internal' })] }),
    });
    expect(owner.total).toBe(3);
  });

  it('23b. a hidden folder cannot be inferred from a short page', async () => {
    const drive = await root();
    const parent = await child(drive, 'Paged', { ownerId: BOB });
    await child(parent, 'A', { ownerId: BOB });
    await child(parent, 'B');
    await child(parent, 'C', { ownerId: BOB });

    const page = await repository.listChildrenOf({
      actor: actor(),
      parentFolderId: parent.id,
      page: 1,
      pageSize: 2,
      sort: 'name',
      order: 'asc',
    });

    // Two of two, not "two of three with one missing".
    expect(names(page)).toEqual(['A', 'C']);
    expect(page.total).toBe(2);
  });

  it('24. search excludes what the actor may not see, in rows and in the total', async () => {
    const drive = await root();
    await child(drive, 'Protocols public', { ownerId: BOB });
    await child(drive, 'Protocols private');

    const result = await repository.search({ actor: actor(), text: 'protocols', page: 1, pageSize: 10 });
    expect(names(result)).toEqual(['Protocols public']);
    expect(result.total).toBe(1);
  });

  it('24b. search matches a substring case-insensitively and never returns a drive root', async () => {
    const drive = await root();
    await child(drive, 'Raw Assay Data', { ownerId: BOB });

    const result = await repository.search({ actor: actor(), text: 'ASSAY', page: 1, pageSize: 10 });
    expect(names(result)).toEqual(['Raw Assay Data']);

    // "My Drive" matches "drive" but is a root, and roots are excluded.
    const roots = await repository.search({
      actor: actor({ userId: ALICE }),
      text: 'my drive',
      page: 1,
      pageSize: 10,
    });
    expect(names(roots)).toEqual([]);
  });

  it('24c. a wildcard in the search text is matched literally', async () => {
    const drive = await root();
    await child(drive, '100% recovery', { ownerId: BOB });
    await child(drive, 'Anything else', { ownerId: BOB });

    const result = await repository.search({ actor: actor(), text: '100%', page: 1, pageSize: 10 });
    expect(names(result)).toEqual(['100% recovery']);
  });

  it('25 & 26. resolving recent and starred ids re-applies visibility', async () => {
    const drive = await root();
    const mine = await child(drive, 'Mine', { ownerId: BOB });
    const revoked = await child(drive, 'Access revoked');

    // Both ids are in the actor's recent/starred list; only one is still theirs to see.
    const resolved = await repository.findByIds(actor(), [mine.id, revoked.id]);
    expect(resolved.map((folder) => folder.name)).toEqual(['Mine']);
  });

  it('19 & 27. the trash lists only what the actor deleted and may still see', async () => {
    const drive = await root();
    const mine = await child(drive, 'Bob trashed this', { ownerId: BOB });
    const inner = await child(mine, 'Swept in with it', { ownerId: BOB });
    const theirs = await child(drive, 'Alice trashed this');

    await repository.setSubtreeDeleted({ folderId: mine.id, deleted: true, userId: BOB });
    await repository.setSubtreeDeleted({ folderId: theirs.id, deleted: true, userId: ALICE });

    const trash = await repository.listTrashed({ actor: actor(), page: 1, pageSize: 10 });
    expect(names(trash)).toEqual(['Bob trashed this']);
    expect(trash.total).toBe(1);

    // The descendant is in the trash but not in the listing — it comes back with its parent.
    expect(names(trash)).not.toContain(inner.name);
  });

  it('28. "shared with me" excludes denied and expired grants', async () => {
    const drive = await root();
    const live = await child(drive, 'Live share');
    const expired = await child(drive, 'Expired share');
    const denied = await child(drive, 'Denied share');
    const own = await child(drive, 'My own', { ownerId: BOB });

    await share(live, BOB);
    await share(expired, BOB, { expiresAt: PAST });
    await share(denied, BOB, { deny: true });
    await share(own, BOB);

    const shared = await repository.listSharedWith({
      actor: actor(),
      principalIds: [BOB],
      page: 1,
      pageSize: 10,
    });

    // Own content is excluded too: the page answers "what did someone hand me?"
    expect(names(shared)).toEqual(['Live share']);
    expect(shared.total).toBe(1);
  });

  it('archived folders are excluded from children unless asked for', async () => {
    const drive = await root();
    const parent = await child(drive, 'Archive parent', { ownerId: BOB });
    const archived = await child(parent, 'Archived', { ownerId: BOB });
    await repository.setSubtreeStatus({ folderId: archived.id, status: 'archived', userId: BOB });

    const base = {
      actor: actor(),
      parentFolderId: parent.id,
      page: 1,
      pageSize: 10,
      sort: 'name' as const,
      order: 'asc' as const,
    };
    expect(names(await repository.listChildrenOf(base))).toEqual([]);
    expect(names(await repository.listChildrenOf({ ...base, includeArchived: true }))).toEqual([
      'Archived',
    ]);

    const archive = await repository.listArchived({ actor: actor(), page: 1, pageSize: 10 });
    expect(names(archive)).toEqual(['Archived']);
  });
});

/* ================================================================== hierarchy */

describe('creating folders', () => {
  it('writes the complete ancestor chain, root first', async () => {
    const drive = await root();
    const top = await child(drive, 'Top');
    const middle = await child(top, 'Middle');
    const bottom = await child(middle, 'Bottom');

    expect(top.pathAncestors).toEqual([drive.id]);
    expect(bottom.pathAncestors).toEqual([drive.id, top.id, middle.id]);
    expect(bottom.depth).toBe(3);

    const db = await getD1();
    const rows = await db
      .select({ ancestorId: folderAncestors.ancestorId, depth: folderAncestors.depth })
      .from(folderAncestors)
      .where(eq(folderAncestors.folderId, bottom.id))
      .orderBy(folderAncestors.depth);
    expect(rows).toEqual([
      { ancestorId: drive.id, depth: 0 },
      { ancestorId: top.id, depth: 1 },
      { ancestorId: middle.id, depth: 2 },
    ]);

    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });

  it('refuses a parent that does not exist or belongs to another organization', async () => {
    const drive = await root();
    const foreignDrive = await root({
      organizationId: ORG_B,
      ownerId: FOREIGNER,
      key: `my:${FOREIGNER}`,
    });

    await expect(
      repository.create({
        organizationId: ORG,
        name: 'Orphan',
        parentFolderId: 'nope',
        pathAncestors: [],
        depth: 1,
        driveType: 'my',
        ownerId: ALICE,
        departmentId: null,
        projectId: null,
        confidentiality: 'internal',
        createdBy: ALICE,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(child(foreignDrive, 'Cross tenant', { organizationId: ORG })).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );

    // The same call under a parent in the actor's own tenant is fine, so the refusals above
    // are about the parent rather than about the call.
    await expect(child(drive, 'Fine')).resolves.toBeTruthy();
  });

  it('allows the same name under different parents and refuses it under one', async () => {
    const drive = await root();
    const a = await child(drive, 'A');
    const b = await child(drive, 'B');

    await child(a, 'Assays');
    await child(b, 'Assays');

    expect(await repository.existsWithName(a.id, 'assays')).toBe(true);
    await expect(child(a, 'Assays')).rejects.toThrow();
  });
});

describe('moving folders', () => {
  async function tree() {
    const drive = await root();
    const source = await child(drive, 'Source');
    const inner = await child(source, 'Inner');
    const leaf = await child(inner, 'Leaf');
    const destination = await child(drive, 'Destination');
    return { drive, source, inner, leaf, destination };
  }

  const moveInput = (folder: FolderRecord, target: FolderRecord) => ({
    folderId: folder.id,
    newParentId: target.id,
    newPathAncestors: [...target.pathAncestors, target.id],
    driveType: target.driveType,
    departmentId: target.departmentId,
    projectId: target.projectId,
    ownerId: folder.ownerId,
    updatedBy: ALICE,
  });

  it('re-parents the folder and every descendant, ancestor rows included', async () => {
    const { drive, source, inner, leaf, destination } = await tree();

    await repository.moveSubtree(moveInput(source, destination));

    const movedLeaf = await repository.findByIdInternal(leaf.id);
    expect(movedLeaf!.pathAncestors).toEqual([drive.id, destination.id, source.id, inner.id]);
    expect(movedLeaf!.depth).toBe(4);

    const movedSource = await repository.findByIdInternal(source.id);
    expect(movedSource!.parentFolderId).toBe(destination.id);
    expect(movedSource!.pathAncestors).toEqual([drive.id, destination.id]);

    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });

  it('carries the destination department and project to the whole subtree', async () => {
    const drive = await root();
    const fromProject = await child(drive, 'From', { departmentId: DEPT_A, projectId: PROJ_A });
    const moving = await child(fromProject, 'Moving', {
      departmentId: DEPT_A,
      projectId: PROJ_A,
    });
    const inner = await child(moving, 'Inner', { departmentId: DEPT_A, projectId: PROJ_A });
    const toProject = await child(drive, 'To', { departmentId: DEPT_B, projectId: PROJ_B });

    await repository.moveSubtree(moveInput(moving, toProject));

    const movedInner = await repository.findByIdInternal(inner.id);
    expect(movedInner!.departmentId).toBe(DEPT_B);
    expect(movedInner!.projectId).toBe(PROJ_B);

    // …and a member of the old project can no longer reach it, which is the point.
    const cleared = [grant({ maxConfidentiality: 'internal' })];
    const oldMember = actor({ departmentId: DEPT_A, projectIds: [PROJ_A], grants: cleared });
    expect(await repository.findById(oldMember, inner.id)).toBeNull();
    const newMember = actor({ departmentId: DEPT_B, projectIds: [PROJ_B], grants: cleared });
    expect(await repository.findById(newMember, inner.id)).not.toBeNull();

    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });

  it('refuses to move a folder into itself or into its own descendant', async () => {
    const { source, inner } = await tree();

    await expect(repository.moveSubtree(moveInput(source, source))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(repository.moveSubtree(moveInput(source, inner))).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });

  it('refuses a cross-organization move and leaves the hierarchy untouched', async () => {
    const { source } = await tree();
    const foreignDrive = await root({
      organizationId: ORG_B,
      ownerId: FOREIGNER,
      key: `my:${FOREIGNER}`,
    });

    await expect(repository.moveSubtree(moveInput(source, foreignDrive))).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const unmoved = await repository.findByIdInternal(source.id);
    expect(unmoved!.organizationId).toBe(ORG);
    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });

  it('leaves nothing half-written when the destination disappears mid-plan', async () => {
    const { source, destination, leaf } = await tree();
    const input = moveInput(source, destination);

    // The destination is gone by the time the move is attempted.
    await repository.purge([destination.id]);
    await expect(repository.moveSubtree(input)).rejects.toMatchObject({ code: 'CONFLICT' });

    const untouched = await repository.findByIdInternal(leaf.id);
    expect(untouched!.pathAncestors).toEqual(leaf.pathAncestors);
    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });

  it('two concurrent moves leave one winner and a coherent tree', async () => {
    const drive = await root();
    const moving = await child(drive, 'Contended');
    await child(moving, 'Passenger');
    const left = await child(drive, 'Left');
    const right = await child(drive, 'Right');

    const results = await Promise.allSettled([
      repository.moveSubtree(moveInput(moving, left)),
      repository.moveSubtree(moveInput(moving, right)),
    ]);

    // Whatever happened, the tree agrees with itself.
    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);

    const settled = await repository.findByIdInternal(moving.id);
    expect([left.id, right.id]).toContain(settled!.parentFolderId);
    expect(settled!.pathAncestors).toEqual([drive.id, settled!.parentFolderId]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);

    const passenger = (await repository.listDescendantsInternal(moving.id))[0]!;
    expect(passenger.pathAncestors).toEqual([drive.id, settled!.parentFolderId, moving.id]);
  });

  it('a rename racing a move ends with both applied and the chain intact', async () => {
    const drive = await root();
    const moving = await child(drive, 'Before');
    await child(moving, 'Passenger');
    const destination = await child(drive, 'Destination');

    await Promise.all([
      repository.updateById(moving.id, { name: 'After' }),
      repository.moveSubtree(moveInput(moving, destination)),
    ]);

    const settled = await repository.findByIdInternal(moving.id);
    expect(settled!.parentFolderId).toBe(destination.id);
    // The rename is a different column; the retry re-reads and does not undo it.
    expect(settled!.name).toBe('After');
    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });
});

describe('trash and restore', () => {
  it('sweeps the subtree in, tags what it swept, and restores exactly that set', async () => {
    const drive = await root();
    const parent = await child(drive, 'Parent');
    const inner = await child(parent, 'Inner');
    const alreadyTrashed = await child(parent, 'Trashed earlier');

    // Trashed on its own first: it must stay in the trash when the parent comes back.
    await repository.setSubtreeDeleted({
      folderId: alreadyTrashed.id,
      deleted: true,
      userId: ALICE,
    });
    const affected = await repository.setSubtreeDeleted({
      folderId: parent.id,
      deleted: true,
      userId: ALICE,
    });
    expect(affected).toBe(2);

    const trashedInner = await repository.findByIdInternal(inner.id, { includeDeleted: true });
    expect(trashedInner!.deletedAt).toBeTruthy();
    expect(trashedInner!.trashedWithFolderId).toBe(parent.id);
    expect(trashedInner!.status).toBe('trashed');

    await repository.setSubtreeDeleted({ folderId: parent.id, deleted: false, userId: ALICE });

    expect((await repository.findByIdInternal(inner.id))!.deletedAt).toBeNull();
    expect(await repository.findByIdInternal(alreadyTrashed.id)).toBeNull();
    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });

  it('restores a folder whose original parent no longer exists', async () => {
    const drive = await root();
    const parent = await child(drive, 'Doomed parent');
    const orphan = await child(parent, 'Orphan');

    await repository.setSubtreeDeleted({ folderId: orphan.id, deleted: true, userId: ALICE });

    // The foreign key refuses to purge a parent that still has a child — which is the
    // behaviour `purge` documents, and is stricter than MongoDB, where the same purge left a
    // dangling `parentFolderId` behind.
    await expect(repository.purge([parent.id])).rejects.toBeTruthy();

    const db = await getD1();
    await db.update(folders).set({ parentFolderId: null }).where(eq(folders.id, orphan.id));
    await repository.purge([parent.id]);

    // Restore does not consult the parent, so it still works — the service decides separately
    // where a parentless folder lands.
    await repository.setSubtreeDeleted({ folderId: orphan.id, deleted: false, userId: ALICE });
    const restored = await repository.findByIdInternal(orphan.id);
    expect(restored!.deletedAt).toBeNull();
    expect(restored!.status).toBe('active');

    // And the tree it left behind is reported rather than quietly tolerated.
    const problems = await repository.checkHierarchyIntegrity(ORG);
    expect(problems.map((problem) => problem.kind)).toContain('parent_not_in_ancestors');
  });

  it('keeps the ancestor chain across a trash and restore cycle', async () => {
    const drive = await root();
    const parent = await child(drive, 'Cycle parent');
    const inner = await child(parent, 'Cycle inner');

    await repository.setSubtreeDeleted({ folderId: parent.id, deleted: true, userId: ALICE });
    await repository.setSubtreeDeleted({ folderId: parent.id, deleted: false, userId: ALICE });

    const after = await repository.findByIdInternal(inner.id);
    expect(after!.pathAncestors).toEqual([drive.id, parent.id]);
    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });
});

describe('sorting and pagination', () => {
  it('is stable when every folder shares a timestamp', async () => {
    const drive = await root();
    const parent = await child(drive, 'Stable', { ownerId: BOB });
    for (const name of ['a', 'b', 'c', 'd', 'e']) await child(parent, name, { ownerId: BOB });

    const db = await getD1();
    await db.update(folders).set({ updatedAt: ISO }).where(eq(folders.parentFolderId, parent.id));

    const query = (page: number) =>
      repository.listChildrenOf({
        actor: actor(),
        parentFolderId: parent.id,
        page,
        pageSize: 2,
        sort: 'updatedAt',
        order: 'desc',
      });

    const first = await query(1);
    const second = await query(2);
    const third = await query(3);

    const seen = [...names(first), ...names(second), ...names(third)];
    // Five distinct folders across three pages: no repeats, none skipped.
    expect(new Set(seen).size).toBe(5);
    expect(first.total).toBe(5);

    // And the same query twice gives the same page.
    expect(names(await query(1))).toEqual(names(first));
  });

  it('sorts by name ascending and descending, and prefixes filter the page', async () => {
    const drive = await root();
    const parent = await child(drive, 'Sorted', { ownerId: BOB });
    for (const name of ['Beta', 'Alpha', 'Gamma']) await child(parent, name, { ownerId: BOB });

    const base = {
      actor: actor(),
      parentFolderId: parent.id,
      page: 1,
      pageSize: 10,
      sort: 'name' as const,
    };

    expect(names(await repository.listChildrenOf({ ...base, order: 'asc' }))).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
    expect(names(await repository.listChildrenOf({ ...base, order: 'desc' }))).toEqual([
      'Gamma',
      'Beta',
      'Alpha',
    ]);

    const prefixed = await repository.listChildrenOf({
      ...base,
      order: 'asc',
      searchPrefix: 'al',
    });
    expect(names(prefixed)).toEqual(['Alpha']);
    expect(prefixed.total).toBe(1);
  });
});

/* ================================================================== integrity checker */

describe('hierarchy integrity checker', () => {
  it('reports a clean tree as clean', async () => {
    const drive = await root();
    const top = await child(drive, 'Top');
    await child(top, 'Bottom');
    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });

  it('detects missing ancestor rows', async () => {
    const drive = await root();
    const top = await child(drive, 'Top');
    const bottom = await child(top, 'Bottom');

    const db = await getD1();
    await db
      .delete(folderAncestors)
      .where(
        and(eq(folderAncestors.folderId, bottom.id), eq(folderAncestors.ancestorId, drive.id)),
      );

    const problems = await repository.checkHierarchyIntegrity(ORG);
    expect(problems.some((problem) => problem.kind === 'missing_ancestor_rows')).toBe(true);
    expect(problems.every((problem) => problem.folderId === bottom.id)).toBe(true);
  });

  it('detects a wrong depth', async () => {
    const drive = await root();
    const top = await child(drive, 'Top');

    const db = await getD1();
    await db.update(folders).set({ depth: 0 }).where(eq(folders.id, top.id));

    const problems = await repository.checkHierarchyIntegrity(ORG);
    expect(problems.map((problem) => problem.kind)).toContain('wrong_depth');
  });

  it('detects a cycle', async () => {
    const drive = await root();
    const top = await child(drive, 'Top');

    const db = await getD1();
    await db.insert(folderAncestors).values({ folderId: top.id, ancestorId: top.id, depth: 1 });

    const problems = await repository.checkHierarchyIntegrity(ORG);
    expect(problems.some((problem) => problem.kind === 'cycle')).toBe(true);
  });

  it('detects an ancestor from another organization', async () => {
    const drive = await root();
    const top = await child(drive, 'Top');
    const foreignDrive = await root({
      organizationId: ORG_B,
      ownerId: FOREIGNER,
      key: `my:${FOREIGNER}`,
    });

    const db = await getD1();
    await db
      .insert(folderAncestors)
      .values({ folderId: top.id, ancestorId: foreignDrive.id, depth: 1 });

    const problems = await repository.checkHierarchyIntegrity(ORG);
    expect(problems.some((problem) => problem.kind === 'cross_organization_ancestor')).toBe(true);
  });

  it('detects a parent that disagrees with the ancestor rows', async () => {
    const drive = await root();
    const top = await child(drive, 'Top');
    const other = await child(drive, 'Other');

    const db = await getD1();
    await db.update(folders).set({ parentFolderId: other.id }).where(eq(folders.id, top.id));

    const problems = await repository.checkHierarchyIntegrity(ORG);
    expect(problems.some((problem) => problem.kind === 'parent_not_in_ancestors')).toBe(true);
  });
});

/* ================================================================== routing */

describe('repository routing', () => {
  it('defaults to MongoDB and moves only the folders module when asked', async () => {
    clearDataSourceOverrides();
    const { dataSourceFor, isD1 } = await import('@/server/repositories/data-source');

    expect(dataSourceFor('folders')).toBe('mongo');
    expect(isD1('folders')).toBe(false);

    setDataSourceOverride('folders', 'd1');
    expect(dataSourceFor('folders')).toBe('d1');
    // The other modules stay where they are: one flag, one module.
    expect(dataSourceFor('files')).toBe('mongo');
    expect(dataSourceFor('users')).toBe('mongo');

    clearDataSourceOverrides();
    expect(dataSourceFor('folders')).toBe('mongo');
  });

  it('the flag name follows the established convention', async () => {
    const { envVarFor } = await import('@/server/repositories/data-source');
    expect(envVarFor('folders')).toBe('DATA_SOURCE_FOLDERS');
  });

  it('the façade dispatches to the D1 implementation when the flag is set', async () => {
    setDataSourceOverride('folders', 'd1');
    const facade = await import('@/server/repositories/folder.repository');

    const drive = await root();
    const folder = await child(drive, 'Routed', { ownerId: BOB });

    // Reached through the façade rather than the implementation, so this proves the wiring.
    const found = await facade.findById(actor(), folder.id);
    expect(found?.name).toBe('Routed');

    clearDataSourceOverrides();
  });

  it('a D1 failure surfaces rather than falling back to MongoDB', async () => {
    setDataSourceOverride('folders', 'd1');
    const facade = await import('@/server/repositories/folder.repository');

    // A move whose destination does not exist must fail loudly. A silent fallback would have
    // answered from the other database and left the two disagreeing about the tree.
    await expect(
      facade.moveSubtree({
        folderId: 'missing',
        newParentId: 'also-missing',
        newPathAncestors: [],
        driveType: 'my',
        departmentId: null,
        projectId: null,
        ownerId: ALICE,
        updatedBy: ALICE,
      }),
    ).rejects.toBeTruthy();

    clearDataSourceOverrides();
  });
});

/* ================================================================== counters and misc */

describe('counters, names and descendants', () => {
  it('adjusts the child counter without reading it first', async () => {
    const drive = await root();
    const parent = await child(drive, 'Counter');

    await repository.adjustChildFolderCount(parent.id, 1);
    await repository.adjustChildFolderCount(parent.id, 1);
    await repository.adjustChildFolderCount(parent.id, -1);

    expect((await repository.findByIdInternal(parent.id))!.childFolderCount).toBe(1);
  });

  it('counts and lists descendants, and skips trashed ones unless asked', async () => {
    const drive = await root();
    const top = await child(drive, 'Top');
    const middle = await child(top, 'Middle');
    const bottom = await child(middle, 'Bottom');

    expect(await repository.countDescendants(top.id)).toBe(2);

    await repository.setSubtreeDeleted({ folderId: bottom.id, deleted: true, userId: ALICE });
    expect(await repository.countDescendants(top.id)).toBe(1);
    expect((await repository.listDescendantsInternal(top.id)).map((f) => f.name)).toEqual([
      'Middle',
    ]);
    expect(
      (await repository.listDescendantsInternal(top.id, { includeDeleted: true })).map(
        (f) => f.name,
      ),
    ).toEqual(['Middle', 'Bottom']);
  });

  it('reports the names taken inside a folder, case-folded', async () => {
    const drive = await root();
    const parent = await child(drive, 'Naming');
    await child(parent, 'Assays');
    await child(parent, 'Reports');

    const taken = await repository.takenChildNames(parent.id);
    expect([...taken].sort()).toEqual(['assays', 'reports']);
    expect(await repository.findChildByName(parent.id, 'assays')).not.toBeNull();
    expect(await repository.findChildByName(parent.id, 'missing')).toBeNull();
  });

  it('finds a mirrored Drive folder even after it has been trashed here', async () => {
    const drive = await root();
    const folder = await child(drive, 'Mirrored');

    const db = await getD1();
    await db
      .update(folders)
      .set({ googleDriveFolderId: 'gd-123' })
      .where(eq(folders.id, folder.id));
    await repository.setSubtreeDeleted({ folderId: folder.id, deleted: true, userId: ALICE });

    const found = await repository.findByDriveFolderIdInternal('gd-123');
    expect(found?.id).toBe(folder.id);
    expect(found?.deletedAt).toBeTruthy();
  });

  it('returns drive roots by key, and creates one only once', async () => {
    const first = await root();
    const second = await root();
    expect(second.id).toBe(first.id);
    expect(first.isSystem).toBe(true);

    const byKey = await repository.findByRootKeyInternal(`my:${ALICE}`);
    expect(byKey?.id).toBe(first.id);
    expect((await repository.findByRootKeysInternal([`my:${ALICE}`])).length).toBe(1);
  });

  it('purges rows and their closure entries together', async () => {
    const drive = await root();
    const doomed = await child(drive, 'Doomed');

    expect(await repository.purge([doomed.id])).toBe(1);

    const db = await getD1();
    const [remaining] = await db
      .select({ value: sql<number>`count(*)` })
      .from(folderAncestors)
      .where(eq(folderAncestors.folderId, doomed.id));
    expect(Number(remaining?.value ?? 0)).toBe(0);
    expect(await repository.checkHierarchyIntegrity(ORG)).toEqual([]);
  });

  it('lists the trash the retention job is about to purge', async () => {
    const drive = await root();
    const folder = await child(drive, 'Old trash');
    await repository.setSubtreeDeleted({ folderId: folder.id, deleted: true, userId: ALICE });

    const db = await getD1();
    await db.update(folders).set({ deletedAt: ISO }).where(eq(folders.id, folder.id));

    const expired = await repository.findExpiredTrashInternal(new Date('2026-06-01T00:00:00.000Z'));
    expect(expired.map((entry) => entry.name)).toContain('Old trash');

    const notYet = await repository.findExpiredTrashInternal(new Date('2025-01-01T00:00:00.000Z'));
    expect(notYet.map((entry) => entry.name)).not.toContain('Old trash');
  });
});
