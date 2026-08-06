/**
 * Phase 3, module 4 — the D1 visibility predicates.
 *
 * Every assertion runs the predicate as SQL against a real D1 and checks *which rows come
 * back*. Nothing is filtered in JavaScript, and each case is also asserted on `COUNT(*)` using
 * the same predicate — a `total` that includes a row the actor cannot see is itself the
 * disclosure, so proving the row is absent from the page is only half the test.
 *
 * The corrected rule is what is asserted here, not MongoDB's historical behaviour: a live
 * denial removes the row ahead of everything else, and an expired entry grants nothing and
 * denies nothing. The equivalent Mongo assertions are in
 * `tests/security/visibility-deny-and-expiry.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { and, eq, sql } from 'drizzle-orm';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting, getD1 } from '@/server/db/d1-context';
import { folders, files } from '@/server/db/schema/drive';
import {
  MAX_ACTOR_PRINCIPALS,
  TooManyPrincipalsError,
  actorPrincipalIds,
  childVisibility,
  resourceVisibility,
} from '@/server/permissions/visibility.d1';
import type { Actor } from '@/server/permissions/actor';
import type { Permission } from '@/server/domain/permissions';

const ORG = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';
const OWNER = '507f1f77bcf86cd799439031';
const VIEWER = '507f1f77bcf86cd799439032';
const DEPT_A = '507f1f77bcf86cd799439041';
const DEPT_B = '507f1f77bcf86cd799439042';
const PROJ_A = '507f1f77bcf86cd799439051';
const PROJ_B = '507f1f77bcf86cd799439052';
const ROLE = '507f1f77bcf86cd799439061';
const ISO = '2026-01-01T00:00:00.000Z';

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

let d1: D1Database;

/* ------------------------------------------------------------------ fixtures */

async function seedWorld(): Promise<void> {
  const run = (sqlText: string, ...binds: unknown[]) =>
    d1.prepare(sqlText).bind(...binds).run();

  for (const id of [ORG, ORG_B]) {
    await run(
      `INSERT OR IGNORE INTO organizations (id,name,slug,email_domains,settings,storage_used_bytes,file_count,is_active,created_at,updated_at)
       VALUES (?,?,?,'[]','{}',0,0,1,?,?)`,
      id,
      `Org ${id.slice(-2)}`,
      `org-${id.slice(-2)}`,
      ISO,
      ISO,
    );
  }
  for (const [id, email] of [
    [OWNER, 'owner@company.com'],
    [VIEWER, 'viewer@company.com'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO users (id,organization_id,email,email_domain,name,mfa,preferences,status,is_super_admin,storage_quota_bytes,storage_used_bytes,must_change_password,failed_login_count,created_at,updated_at)
       VALUES (?,?,?,'company.com',?,'{"enabled":false}','{}','active',0,1,0,0,0,?,?)`,
      id,
      ORG,
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
  for (const [id, dept, code] of [
    [PROJ_A, DEPT_A, 'PA'],
    [PROJ_B, DEPT_B, 'PB'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO projects (id,organization_id,department_id,name,code,description,status,confidentiality,storage_used_bytes,file_count,created_at,updated_at)
       VALUES (?,?,?,?,?,'','active','internal',0,0,?,?)`,
      id,
      ORG,
      dept,
      `Project ${code}`,
      code,
      ISO,
      ISO,
    );
  }
  await run(
    `INSERT OR IGNORE INTO roles (id,organization_id,key,name,description,rank,max_confidentiality,company_wide_read,is_system,created_at,updated_at)
     VALUES (?,?,'reviewer','Reviewer','',40,'internal',0,0,?,?)`,
    ROLE,
    ORG,
    ISO,
    ISO,
  );
}

interface FolderInput {
  id: string;
  organizationId?: string;
  ownerId?: string;
  departmentId?: string | null;
  projectId?: string | null;
  confidentiality?: 'public_internal' | 'internal' | 'restricted';
  inherit?: boolean;
  deletedAt?: string | null;
  parentId?: string | null;
}

async function seedFolder(input: FolderInput): Promise<string> {
  await d1
    .prepare(
      `INSERT INTO folders (id,organization_id,name,name_lower,parent_folder_id,depth,drive_type,
         owner_id,department_id,project_id,inherit_permissions,confidentiality,status,description,
         is_system,child_folder_count,file_count,created_by,storage_provider,drive_mapping_status,
         sync_status,deleted_at,created_at,updated_at)
       VALUES (?,?,?,?,?,0,'department',?,?,?,?,?, 'active','',0,0,0,?,'local','none','not_required',?,?,?)`,
    )
    .bind(
      input.id,
      input.organizationId ?? ORG,
      input.id,
      input.id.toLowerCase(),
      input.parentId ?? null,
      input.ownerId ?? OWNER,
      input.departmentId === undefined ? DEPT_A : input.departmentId,
      input.projectId ?? null,
      input.inherit === false ? 0 : 1,
      input.confidentiality ?? 'restricted',
      OWNER,
      input.deletedAt ?? null,
      ISO,
      ISO,
    )
    .run();
  return input.id;
}

async function seedFile(id: string, folderId: string, confidentiality = 'restricted'): Promise<string> {
  await d1
    .prepare(
      `INSERT INTO files (id,organization_id,display_name,display_name_lower,original_filename,
         extension,category,folder_id,drive_type,owner_id,department_id,project_id,version_count,
         size_bytes,mime_type,confidentiality,review_status,approval_status,status,
         inherit_permissions,download_count,created_by,storage_provider,has_google_native_content,
         created_at,updated_at)
       VALUES (?,?,?,?,?,'txt','other',?, 'department',?,?,NULL,0,0,'text/plain',?,'draft','none','active',1,0,?,'local',0,?,?)`,
    )
    .bind(id, ORG, id, id.toLowerCase(), `${id}.txt`, folderId, OWNER, DEPT_A, confidentiality, OWNER, ISO, ISO)
    .run();
  return id;
}

async function seedAcl(
  resourceType: 'folder' | 'file',
  resourceId: string,
  principalId: string,
  opts: { deny?: boolean; expiresAt?: string | null; principalType?: string } = {},
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO resource_permissions (id,organization_id,resource_type,resource_id,principal_type,
         principal_id,access_level,deny,expires_at,granted_by,granted_at)
       VALUES (?,?,?,?,?,?,'viewer',?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      ORG,
      resourceType,
      resourceId,
      opts.principalType ?? 'user',
      principalId,
      opts.deny ? 1 : 0,
      opts.expiresAt ?? null,
      OWNER,
      ISO,
    )
    .run();
}

async function seedAncestor(folderId: string, ancestorId: string): Promise<void> {
  await d1
    .prepare('INSERT INTO folder_ancestors (folder_id, ancestor_id, depth) VALUES (?,?,0)')
    .bind(folderId, ancestorId)
    .run();
}

/* ------------------------------------------------------------------ actor */

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: VIEWER,
    email: 'viewer@company.com',
    name: 'Viewer',
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

/* ------------------------------------------------------------------ query helpers */

/** Rows the predicate admits, plus the count computed with the *same* predicate. */
async function visible(
  kind: 'folder' | 'file',
  predicate: ReturnType<typeof resourceVisibility>,
): Promise<{ ids: string[]; total: number }> {
  const db = await getD1();
  const table = kind === 'folder' ? folders : files;
  const idColumn = kind === 'folder' ? folders.id : files.id;

  const rows = await db.select({ id: idColumn }).from(table).where(predicate);
  const counted = await db
    .select({ value: sql<number>`count(*)` })
    .from(table)
    .where(predicate);

  return { ids: rows.map((row) => row.id), total: Number(counted[0]?.value ?? 0) };
}

/* ------------------------------------------------------------------ harness */

beforeAll(async () => {
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
  await seedWorld();
}, 300_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  await stopTestD1();
});

const RESET = [
  'DELETE FROM resource_permissions',
  'DELETE FROM file_folder_ancestors',
  'DELETE FROM files',
  'DELETE FROM folder_ancestors',
  'DELETE FROM folders',
];

beforeEach(async () => {
  await clearD1(d1, RESET);
  await seedWorld();
});

/* ================================================================== denial */

describe('explicit denial', () => {
  /**
   * `ux_resource_permissions` allows **one entry per principal per resource**, so a principal
   * cannot hold an allow and a deny on the same row — the deny simply is the entry. Mongo's
   * `permissions[]` array had no such uniqueness, but the sharing service replaced an existing
   * entry on re-share, so the two agree in practice.
   *
   * The override that is therefore meaningful here is deny beating a *different* source:
   * ownership, which is `canAccess` step 4 beating step 8.
   */
  it('overrides a direct allow, and overrides ownership', async () => {
    await seedFolder({ id: 'granted' });
    await seedAcl('folder', 'granted', VIEWER);

    await seedFolder({ id: 'denied' });
    await seedAcl('folder', 'denied', VIEWER, { deny: true });

    // Owned by the actor, and still removed by the deny.
    await seedFolder({ id: 'owned-but-denied', ownerId: VIEWER });
    await seedAcl('folder', 'owned-but-denied', VIEWER, { deny: true });

    const result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids).toEqual(['granted']);
    expect(result.total).toBe(1);
  });

  it('overrides an inherited allow', async () => {
    await seedFolder({ id: 'parent' });
    await seedAcl('folder', 'parent', VIEWER);

    await seedFolder({ id: 'child', parentId: null });
    await seedAncestor('child', 'parent');

    // Inherited allow reaches the child …
    let result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids).toContain('child');

    // … until a deny on the child itself.
    await seedAcl('folder', 'child', VIEWER, { deny: true });
    result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids).not.toContain('child');
  });

  it('overrides department and project access', async () => {
    await seedFolder({ id: 'dept', departmentId: DEPT_A, confidentiality: 'internal' });
    await seedFolder({ id: 'proj', projectId: PROJ_A, confidentiality: 'public_internal' });
    await seedAcl('folder', 'dept', VIEWER, { deny: true });
    await seedAcl('folder', 'proj', VIEWER, { deny: true });

    const result = await visible(
      'folder',
      resourceVisibility('folder', actor({ departmentId: DEPT_A, projectIds: [PROJ_A] })),
    );
    expect(result.ids).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('overrides super-admin access', async () => {
    await seedFolder({ id: 'seen', confidentiality: 'internal' });
    await seedFolder({ id: 'denied-to-admin', confidentiality: 'internal' });
    await seedAcl('folder', 'denied-to-admin', VIEWER, { deny: true });

    const result = await visible(
      'folder',
      resourceVisibility('folder', actor({ isSuperAdmin: true })),
    );
    expect(result.ids).toContain('seen');
    expect(result.ids).not.toContain('denied-to-admin');
  });

  it('inherited denial removes the row', async () => {
    await seedFolder({ id: 'p', confidentiality: 'internal' });
    await seedFolder({ id: 'c', confidentiality: 'internal' });
    await seedAncestor('c', 'p');
    await seedAcl('folder', 'p', VIEWER, { deny: true });

    const result = await visible(
      'folder',
      resourceVisibility('folder', actor({ isSuperAdmin: true })),
    );
    expect(result.ids).not.toContain('c');
  });

  it('a denial naming somebody else does not hide the row', async () => {
    await seedFolder({ id: 'other-deny', confidentiality: 'internal' });
    await seedAcl('folder', 'other-deny', OWNER, { deny: true });

    const result = await visible(
      'folder',
      resourceVisibility('folder', actor({ isSuperAdmin: true })),
    );
    expect(result.ids).toContain('other-deny');
  });
});

/* ================================================================== expiry */

describe('expiry', () => {
  it('an expired direct share grants nothing', async () => {
    await seedFolder({ id: 'expired' });
    await seedAcl('folder', 'expired', VIEWER, { expiresAt: PAST });
    await seedFolder({ id: 'live' });
    await seedAcl('folder', 'live', VIEWER, { expiresAt: FUTURE });

    const result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids).toEqual(['live']);
    expect(result.total).toBe(1);
  });

  it('an expired inherited share grants nothing', async () => {
    await seedFolder({ id: 'anc' });
    await seedFolder({ id: 'desc' });
    await seedAncestor('desc', 'anc');
    await seedAcl('folder', 'anc', VIEWER, { expiresAt: PAST });

    const result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids).not.toContain('desc');
  });

  /**
   * Visibility comes from ownership here, not from a second ACL entry — one entry per
   * principal per resource. The stale deny must not suppress it, exactly as `aclGrants()`
   * skips an expired entry before it looks at `deny`.
   */
  it('an expired denial denies nothing, matching aclGrants', async () => {
    await seedFolder({ id: 'stale-deny', ownerId: VIEWER });
    await seedAcl('folder', 'stale-deny', VIEWER, { deny: true, expiresAt: PAST });

    const result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids).toContain('stale-deny');

    // Control: the same shape with a *live* deny is removed.
    await seedFolder({ id: 'live-deny', ownerId: VIEWER });
    await seedAcl('folder', 'live-deny', VIEWER, { deny: true, expiresAt: FUTURE });

    const after = await visible('folder', resourceVisibility('folder', actor()));
    expect(after.ids).not.toContain('live-deny');
  });
});

/* ================================================================== isolation */

describe('isolation', () => {
  it('department A cannot see department B', async () => {
    await seedFolder({ id: 'a', departmentId: DEPT_A, confidentiality: 'public_internal' });
    await seedFolder({ id: 'b', departmentId: DEPT_B, confidentiality: 'public_internal' });

    const result = await visible(
      'folder',
      resourceVisibility('folder', actor({ departmentId: DEPT_A })),
    );
    expect(result.ids).toEqual(['a']);
    expect(result.total).toBe(1);
  });

  it('project A cannot see project B', async () => {
    await seedFolder({ id: 'pa', departmentId: null, projectId: PROJ_A, confidentiality: 'public_internal' });
    await seedFolder({ id: 'pb', departmentId: null, projectId: PROJ_B, confidentiality: 'public_internal' });

    const result = await visible(
      'folder',
      resourceVisibility('folder', actor({ projectIds: [PROJ_A] })),
    );
    expect(result.ids).toEqual(['pa']);
  });

  it('refuses cross-tenant rows, including for a super admin', async () => {
    await seedFolder({ id: 'mine', confidentiality: 'internal' });
    await seedFolder({
      id: 'theirs',
      organizationId: ORG_B,
      departmentId: null,
      confidentiality: 'internal',
    });

    const result = await visible(
      'folder',
      resourceVisibility('folder', actor({ isSuperAdmin: true })),
    );
    expect(result.ids).toEqual(['mine']);
  });

  it('an actor with no department, projects or shares sees only what they own', async () => {
    await seedFolder({ id: 'someone-elses' });
    await seedFolder({ id: 'mine', ownerId: VIEWER });

    const result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids).toEqual(['mine']);
    expect(result.total).toBe(1);
  });
});

/* ================================================================== principals */

describe('principals', () => {
  it('includes role ids, so a role-targeted share is visible', async () => {
    await seedFolder({ id: 'shared-with-role' });
    await seedAcl('folder', 'shared-with-role', ROLE, { principalType: 'role' });

    const withRole = actor({
      grants: [
        {
          roleId: ROLE,
          roleKey: 'reviewer',
          roleName: 'Reviewer',
          rank: 40,
          scopeType: 'company',
          scopeId: null,
          permissions: [],
          maxConfidentiality: 'internal',
          companyWideRead: false,
        },
      ],
    });

    expect(actorPrincipalIds(withRole)).toContain(ROLE);

    const result = await visible('folder', resourceVisibility('folder', withRole));
    expect(result.ids).toEqual(['shared-with-role']);

    // Without the role, the same share is invisible.
    const without = await visible('folder', resourceVisibility('folder', actor()));
    expect(without.ids).toEqual([]);
  });

  /**
   * Fails closed. Truncating the list would produce a narrower result set that looks like a
   * working page, so a user would quietly stop seeing files they are entitled to.
   */
  it('refuses rather than truncating when the principal limit is exceeded', () => {
    const tooMany = actor({
      projectIds: Array.from({ length: MAX_ACTOR_PRINCIPALS + 5 }, (_, i) => `project-${i}`),
    });

    expect(() => actorPrincipalIds(tooMany)).toThrow(TooManyPrincipalsError);
    expect(() => resourceVisibility('folder', tooMany)).toThrow(TooManyPrincipalsError);
  });

  it('accepts a principal set exactly at the limit', () => {
    const atLimit = actor({
      // userId counts as one, so the list is filled to exactly the limit.
      projectIds: Array.from({ length: MAX_ACTOR_PRINCIPALS - 1 }, (_, i) => `project-${i}`),
    });
    expect(actorPrincipalIds(atLimit)).toHaveLength(MAX_ACTOR_PRINCIPALS);
  });
});

/* ================================================================== soft delete + files */

describe('soft delete and the file variant', () => {
  it('the predicate is orthogonal to soft delete, so trash can reuse it', async () => {
    await seedFolder({ id: 'live-row', ownerId: VIEWER });
    await seedFolder({ id: 'trashed-row', ownerId: VIEWER, deletedAt: ISO });

    const db = await getD1();
    const predicate = resourceVisibility('folder', actor());

    const live = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(predicate, sql`${folders.deletedAt} IS NULL`));
    const trashed = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(predicate, sql`${folders.deletedAt} IS NOT NULL`));

    expect(live.map((row) => row.id)).toEqual(['live-row']);
    // Trash shows only rows the actor may see -- the same predicate, a different lifecycle half.
    expect(trashed.map((row) => row.id)).toEqual(['trashed-row']);
  });

  it('applies the same denial rule to files', async () => {
    await seedFolder({ id: 'holder', confidentiality: 'internal' });
    await seedFile('visible-file', 'holder');
    await seedAcl('file', 'visible-file', VIEWER);
    await seedFile('denied-file', 'holder');
    await seedAcl('file', 'denied-file', VIEWER, { deny: true });

    const result = await visible('file', resourceVisibility('file', actor()));
    expect(result.ids).toEqual(['visible-file']);
    expect(result.total).toBe(1);
  });

  it('childVisibility also refuses a denied row', async () => {
    await seedFolder({ id: 'child-ok', confidentiality: 'internal', ownerId: VIEWER });
    await seedFolder({ id: 'child-denied', confidentiality: 'internal', ownerId: VIEWER });
    await seedAcl('folder', 'child-denied', VIEWER, { deny: true });

    const db = await getD1();
    const rows = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.organizationId, ORG), childVisibility('folder', actor())));

    expect(rows.map((row) => row.id)).toEqual(['child-ok']);
  });
});

/* ================================================================== inheritance boundary */

/**
 * `canAccess` walks leaf → root and stops **after** the first ancestor with
 * `inheritPermissions = false` — that ancestor's ACL still applies, nothing above it does.
 *
 * The listing predicate must agree. Relying on `canAccess` to refuse the row afterwards is
 * not enough: by then it has been counted, paginated and had its name rendered, which is the
 * disclosure. Every case below therefore asserts `COUNT(*)` as well as the rows.
 *
 * Tree used throughout:  root ── mid ── leaf
 */
describe('inheritance boundaries', () => {
  async function tree(midInherits: boolean): Promise<void> {
    await seedFolder({ id: 'root' });
    await seedFolder({ id: 'mid', parentId: 'root', inherit: midInherits });
    await seedFolder({ id: 'leaf', parentId: 'mid' });

    // depth: 0 = drive root, increasing towards the parent.
    await d1.prepare('INSERT INTO folder_ancestors (folder_id,ancestor_id,depth) VALUES (?,?,?)').bind('mid', 'root', 0).run();
    await d1.prepare('INSERT INTO folder_ancestors (folder_id,ancestor_id,depth) VALUES (?,?,?)').bind('leaf', 'root', 0).run();
    await d1.prepare('INSERT INTO folder_ancestors (folder_id,ancestor_id,depth) VALUES (?,?,?)').bind('leaf', 'mid', 1).run();
  }

  it('1. a parent grant is inherited by the child', async () => {
    await tree(true);
    await seedAcl('folder', 'root', VIEWER);

    const result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids.sort()).toEqual(['leaf', 'mid', 'root']);
    expect(result.total).toBe(3);
  });

  it('2 & 3. an intermediate folder disabling inheritance hides itself and everything below', async () => {
    await tree(false);
    await seedAcl('folder', 'root', VIEWER);

    const result = await visible('folder', resourceVisibility('folder', actor()));
    // `mid` broke inheritance and holds no direct grant; `leaf` is below the boundary.
    expect(result.ids).toEqual(['root']);
    expect(result.total).toBe(1);
  });

  it('4. a direct grant beneath the boundary restores visibility', async () => {
    await tree(false);
    await seedAcl('folder', 'root', VIEWER);
    await seedAcl('folder', 'leaf', VIEWER);

    const result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids.sort()).toEqual(['leaf', 'root']);
    expect(result.total).toBe(2);
  });

  /**
   * The boundary folder's own ACL is still in scope — `canAccess` breaks *after* considering
   * it — so a grant on `mid` reaches `leaf`, while `root` above the boundary still does not.
   */
  it('4b. the boundary folder\u2019s own grant still flows downwards', async () => {
    await tree(false);
    await seedAcl('folder', 'mid', VIEWER);

    const result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids.sort()).toEqual(['leaf', 'mid']);
  });

  it('5. a direct denial beneath the boundary removes visibility', async () => {
    await tree(false);
    await seedAcl('folder', 'mid', VIEWER);
    await seedAcl('folder', 'leaf', VIEWER, { deny: true });

    const result = await visible('folder', resourceVisibility('folder', actor()));
    expect(result.ids).toEqual(['mid']);
    expect(result.total).toBe(1);
  });

  it('5b. a denial above the boundary cannot reach past it', async () => {
    await tree(false);
    await seedAcl('folder', 'root', VIEWER, { deny: true });
    await seedAcl('folder', 'mid', VIEWER);

    const result = await visible('folder', resourceVisibility('folder', actor()));
    // The deny on `root` is out of scope for `mid` and `leaf`; `root` itself is not granted.
    expect(result.ids.sort()).toEqual(['leaf', 'mid']);
  });

  it('6. moving a folder across a boundary recalculates visibility', async () => {
    await tree(false);
    await seedAcl('folder', 'root', VIEWER);

    // Below the boundary: invisible.
    expect((await visible('folder', resourceVisibility('folder', actor()))).ids).toEqual(['root']);

    // Re-parent `leaf` directly under `root`, bypassing `mid` -- exactly what a move does to
    // the ancestor rows.
    await d1.prepare('DELETE FROM folder_ancestors WHERE folder_id = ?').bind('leaf').run();
    await d1
      .prepare('INSERT INTO folder_ancestors (folder_id,ancestor_id,depth) VALUES (?,?,?)')
      .bind('leaf', 'root', 0)
      .run();
    await d1.prepare('UPDATE folders SET parent_folder_id = ? WHERE id = ?').bind('root', 'leaf').run();

    const after = await visible('folder', resourceVisibility('folder', actor()));
    expect(after.ids.sort()).toEqual(['leaf', 'root']);
    expect(after.total).toBe(2);
  });

  it('7. counts and pagination exclude rows below a broken boundary', async () => {
    await tree(false);
    await seedAcl('folder', 'root', VIEWER);

    const db = await getD1();
    const predicate = resourceVisibility('folder', actor());

    const page = await db
      .select({ id: folders.id })
      .from(folders)
      .where(predicate)
      .orderBy(sql`${folders.name} ASC`, sql`${folders.id} ASC`)
      .limit(10);
    const counted = await db
      .select({ value: sql<number>`count(*)` })
      .from(folders)
      .where(predicate);

    // A page of one and a total of one -- the hidden rows are absent from both, so the total
    // cannot be differenced against a wider query to learn they exist.
    expect(page.map((row) => row.id)).toEqual(['root']);
    expect(Number(counted[0]!.value)).toBe(1);
  });

  it('applies the same boundary to files', async () => {
    await tree(false);
    await seedFile('leaf-file', 'leaf', 'internal');
    await d1
      .prepare('INSERT INTO file_folder_ancestors (file_id,ancestor_id,depth) VALUES (?,?,?)')
      .bind('leaf-file', 'root', 0)
      .run();
    await d1
      .prepare('INSERT INTO file_folder_ancestors (file_id,ancestor_id,depth) VALUES (?,?,?)')
      .bind('leaf-file', 'mid', 1)
      .run();
    await seedAcl('folder', 'root', VIEWER);

    const blocked = await visible('file', resourceVisibility('file', actor()));
    expect(blocked.ids).toEqual([]);
    expect(blocked.total).toBe(0);

    // A grant on the boundary folder itself does reach it.
    await seedAcl('folder', 'mid', VIEWER);
    const reached = await visible('file', resourceVisibility('file', actor()));
    expect(reached.ids).toEqual(['leaf-file']);
  });
});
