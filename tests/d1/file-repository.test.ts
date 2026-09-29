/**
 * Phase 3, module 6 — the D1 file repository.
 *
 * Four things are being proved, and they need different kinds of test.
 *
 * **Isolation.** Every read is asserted on *which rows come back* and, separately, on the
 * `total` the same call reports. A file absent from the page but present in the count is still
 * disclosed — the count is how you find out something is there. Nothing here filters in
 * JavaScript; the repository either returns the row or it does not.
 *
 * **Reassembly.** One Mongo document is five D1 tables. A record that loses its tags, drops a
 * metadata key, or returns `null` where Mongo returned `{}` changes an API response without
 * changing a single line of route code, so the hydration is compared against the Mongo
 * implementation's own contract field by field.
 *
 * **Hierarchy.** `files.folder_id` and `file_folder_ancestors` are two representations of one
 * truth. A mutation that updates one and not the other produces a tree that still reads
 * correctly until somebody moves something, so every mutation test finishes by running
 * `checkFileHierarchyIntegrity`.
 *
 * **Index freshness.** The Phase 2 FTS triggers fire on `files` only, so a write that touches
 * just `file_metadata` or just `resource_tags` used to leave `files_fts` holding the previous
 * value. Those cases are asserted in both directions — the new term must match, and the old
 * term must stop matching — because an index that is merely *added to* still returns deleted
 * content.
 *
 * The suite runs against a real D1 through Miniflare, so batches, triggers, FTS5, partial
 * indexes and foreign keys behave as they do in the Worker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import * as repository from '@/server/repositories/file.repository.d1';
import * as folderRepository from '@/server/repositories/folder.repository.d1';
import { AmbiguousDriveFileError } from '@/server/repositories/file.repository.contract';
import type { FolderRecord } from '@/server/repositories/folder.repository.contract';
import type { Actor, RoleGrant } from '@/server/permissions/actor';
import type { Permission } from '@/server/domain/permissions';

const ORG = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';

const ALICE = '507f1f77bcf86cd799439031';
const BOB = '507f1f77bcf86cd799439032';
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

const owner = () => actor({ userId: ALICE });

/**
 * An actor cleared to `internal`, which is the default classification of everything seeded here.
 *
 * `actorClearance` starts at `public_internal` and is raised only by a role grant, so an actor
 * with no grants is cleared for nothing the fixtures create. Any test whose subject reaches a
 * file through a *scope* — department, project, role, or inheritance — needs this, because
 * `passesConfidentialityGate` applies to exactly those branches. Owner and direct-grant
 * branches bypass the gate and do not.
 */
const cleared = (overrides: Partial<Actor> = {}) =>
  actor({ grants: [grant({ maxConfidentiality: 'internal' })], ...overrides });

async function root(options: { organizationId?: string; ownerId?: string } = {}) {
  const ownerId = options.ownerId ?? ALICE;
  const organizationId = options.organizationId ?? ORG;
  return folderRepository.ensureRoot({
    rootKey: `my:${ownerId}:${organizationId}`,
    organizationId,
    name: 'My Drive',
    driveType: 'my',
    ownerId,
    departmentId: null,
    projectId: null,
    confidentiality: 'internal',
    createdBy: ownerId,
  });
}

async function child(
  parent: FolderRecord,
  name: string,
  options: { inheritPermissions?: boolean } = {},
): Promise<FolderRecord> {
  const folder = await folderRepository.create({
    organizationId: parent.organizationId,
    name,
    parentFolderId: parent.id,
    pathAncestors: [...parent.pathAncestors, parent.id],
    depth: parent.depth + 1,
    driveType: parent.driveType,
    ownerId: parent.ownerId,
    departmentId: parent.departmentId,
    projectId: parent.projectId,
    confidentiality: 'internal',
    createdBy: parent.ownerId,
  });
  if (options.inheritPermissions === false) {
    return (await folderRepository.updateById(folder.id, { inheritPermissions: false }))!;
  }
  return folder;
}

interface FileOptions {
  organizationId?: string;
  ownerId?: string;
  departmentId?: string | null;
  projectId?: string | null;
  confidentiality?: 'public_internal' | 'internal' | 'confidential' | 'restricted';
  tags?: string[];
  metadata?: Record<string, unknown>;
  name?: string;
  originalFilename?: string;
}

async function file(folder: FolderRecord, options: FileOptions = {}) {
  return repository.create({
    organizationId: options.organizationId ?? folder.organizationId,
    displayName: options.name ?? 'result.pdf',
    originalFilename: options.originalFilename ?? options.name ?? 'result.pdf',
    extension: 'pdf',
    category: 'document',
    folderId: folder.id,
    folderPathAncestors: [...folder.pathAncestors, folder.id],
    driveType: folder.driveType,
    ownerId: options.ownerId ?? folder.ownerId,
    departmentId: options.departmentId === undefined ? null : options.departmentId,
    projectId: options.projectId === undefined ? null : options.projectId,
    confidentiality: options.confidentiality ?? 'internal',
    sizeBytes: 10,
    mimeType: 'application/pdf',
    checksumSha256: 'c'.repeat(64),
    tags: options.tags,
    metadata: options.metadata,
    createdBy: options.ownerId ?? folder.ownerId,
  });
}

/** A direct ACL entry, written the way the sharing service writes one. */
async function share(
  resourceType: 'file' | 'folder',
  resourceId: string,
  principalId: string,
  options: { deny?: boolean; expiresAt?: Date | null } = {},
) {
  await d1
    .prepare(
      `INSERT INTO resource_permissions (id,organization_id,resource_type,resource_id,principal_type,principal_id,access_level,deny,expires_at,granted_by,granted_at)
       VALUES (?,?,?,?,'user',?,'view',?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      ORG,
      resourceType,
      resourceId,
      principalId,
      options.deny ? 1 : 0,
      options.expiresAt ? options.expiresAt.toISOString() : null,
      ALICE,
      ISO,
    )
    .run();
}

async function seedVersion(
  fileId: string,
  googleDriveFileId: string | null,
  organizationId = ORG,
) {
  await d1
    .prepare(
      `INSERT INTO file_versions (id,organization_id,file_id,version_number,storage_key,storage_area,original_filename,file_size,mime_type,extension,checksum_sha256,uploaded_by,uploaded_at,version_note,processing_status,label,is_current,is_approved,preview_status,storage_provider,google_drive_file_id,migration_status,sync_status,local_copy_state,created_at,updated_at)
       VALUES (?,?,?,1,?,'originals','result.pdf',10,'application/pdf','pdf',?,?,?,'','ready','draft',1,0,'none','local',?,'not_started','not_required','present',?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      organizationId,
      fileId,
      `originals/${fileId}/v1`,
      'c'.repeat(64),
      organizationId === ORG ? ALICE : FOREIGNER,
      ISO,
      googleDriveFileId,
      ISO,
      ISO,
    )
    .run();
}

const searchInput = (over: Partial<Parameters<typeof repository.search>[0]> = {}) => ({
  actor: owner(),
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
  setD1BindingForTesting(null);
  await stopTestD1();
});

beforeEach(async () => {
  await clearD1(d1, [
    'DELETE FROM files_fts',
    'DELETE FROM file_versions',
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

/* ================================================================== permission-aware reads */

describe('findById', () => {
  it('returns a file the actor owns', async () => {
    const home = await root();
    const created = await file(home);

    const found = await repository.findById(owner(), created.id);
    expect(found?.id).toBe(created.id);
  });

  it('refuses a file the actor has no route to, however well they guess the id', async () => {
    const home = await root();
    const created = await file(home);

    // Bob owns nothing, is in no department or project, and holds no grant.
    expect(await repository.findById(actor(), created.id)).toBeNull();
  });

  it('refuses across organizations, super admin included', async () => {
    const foreignHome = await root({ organizationId: ORG_B, ownerId: FOREIGNER });
    const created = await file(foreignHome, { organizationId: ORG_B, ownerId: FOREIGNER });

    const admin = actor({ userId: ALICE, isSuperAdmin: true, organizationId: ORG });
    expect(await repository.findById(admin, created.id)).toBeNull();
    // ...and the file is genuinely there, so the null above is isolation and not an empty table.
    expect(await repository.findByIdInternal(created.id)).not.toBeNull();
  });

  it('refuses a file carrying a live explicit deny, even for its owner', async () => {
    const home = await root();
    const created = await file(home);
    await share('file', created.id, ALICE, { deny: true });

    expect(await repository.findById(owner(), created.id)).toBeNull();
  });

  it('ignores an expired allow and an expired deny alike', async () => {
    const home = await root();
    const expiredAllow = await file(home, { name: 'allow.pdf', ownerId: ALICE });
    const expiredDeny = await file(home, { name: 'deny.pdf', ownerId: ALICE });

    // An expired share grants nothing: Bob still cannot see it.
    await share('file', expiredAllow.id, BOB, { expiresAt: PAST });
    expect(await repository.findById(actor(), expiredAllow.id)).toBeNull();

    // An expired deny blocks nothing: Alice still owns it. `aclGrants()` skips an expired
    // entry before it looks at anything else, and visibility must agree with capability.
    await share('file', expiredDeny.id, ALICE, { deny: true, expiresAt: PAST });
    expect((await repository.findById(owner(), expiredDeny.id))?.id).toBe(expiredDeny.id);
  });

  it('honours a live share on the file itself', async () => {
    const home = await root();
    const created = await file(home);
    await share('file', created.id, BOB, { expiresAt: FUTURE });

    expect((await repository.findById(actor(), created.id))?.id).toBe(created.id);
  });

  it('honours a grant inherited from an ancestor folder', async () => {
    const home = await root();
    const shared = await child(home, 'Shared');
    const deep = await child(shared, 'Results');
    const created = await file(deep);

    // Bob is named on `Shared`, two levels above the file.
    await share('folder', shared.id, BOB);
    expect((await repository.findById(actor(), created.id))?.id).toBe(created.id);
  });

  it('stops inheritance at a folder that breaks it', async () => {
    const home = await root();
    const shared = await child(home, 'Shared');
    const sealed = await child(shared, 'Sealed', { inheritPermissions: false });
    const created = await file(sealed);

    await share('folder', shared.id, BOB);
    // `Sealed` cuts the walk off, so the grant above it cannot reach the file.
    expect(await repository.findById(actor(), created.id)).toBeNull();

    // A grant on the boundary folder itself still flows downwards.
    await share('folder', sealed.id, BOB);
    expect((await repository.findById(actor(), created.id))?.id).toBe(created.id);
  });
});

describe('scope-based visibility', () => {
  it('separates departments', async () => {
    const home = await root();
    const mine = await file(home, { name: 'a.pdf', departmentId: DEPT_A });
    const theirs = await file(home, { name: 'b.pdf', departmentId: DEPT_B });

    const inA = cleared({ departmentId: DEPT_A });
    expect((await repository.findById(inA, mine.id))?.id).toBe(mine.id);
    expect(await repository.findById(inA, theirs.id)).toBeNull();
  });

  it('separates projects', async () => {
    const home = await root();
    const mine = await file(home, { name: 'a.pdf', projectId: PROJ_A });
    const theirs = await file(home, { name: 'b.pdf', projectId: PROJ_B });

    const onA = cleared({ projectIds: [PROJ_A] });
    expect((await repository.findById(onA, mine.id))?.id).toBe(mine.id);
    expect(await repository.findById(onA, theirs.id)).toBeNull();
  });

  it('honours a department-scoped role grant in the lookup', async () => {
    const home = await root();
    const created = await file(home, { departmentId: DEPT_B });

    const reviewer = actor({
      grants: [grant({ scopeType: 'department', scopeId: DEPT_B, maxConfidentiality: 'internal' })],
    });
    expect((await repository.findById(reviewer, created.id))?.id).toBe(created.id);
  });

  it('refuses a file classified above the actor clearance, however they reach it', async () => {
    const home = await root();
    const created = await file(home, {
      departmentId: DEPT_A,
      confidentiality: 'confidential',
    });

    // Cleared to `internal` and in the right department — the scope branch matches, the
    // confidentiality gate does not.
    expect(await repository.findById(cleared({ departmentId: DEPT_A }), created.id)).toBeNull();
  });
});

describe('listInFolder', () => {
  it('applies the same predicate to the rows and to the total', async () => {
    const home = await root();
    const visible = await file(home, { name: 'visible.pdf', ownerId: ALICE });
    await file(home, { name: 'hidden.pdf', ownerId: ALICE, confidentiality: 'restricted' });

    // `childVisibility` assumes the parent folder is already authorised, so an inheriting child
    // within clearance is visible. The second file is classified above Bob's clearance and is
    // not — and that is the whole assertion, because it must hold for the count as well.
    const page = await repository.listInFolder({
      actor: cleared(),
      folderId: home.id,
      page: 1,
      pageSize: 20,
      sort: 'displayName',
      order: 'asc',
    });

    expect(page.items.map((item) => item.id)).toEqual([visible.id]);
    // The count is the disclosure that matters: a total of 2 would announce the second file.
    expect(page.total).toBe(1);
  });
});

/* ================================================================== hydration */

describe('record hydration', () => {
  it('reassembles all five tables into one record', async () => {
    const home = await root();
    const created = await file(home, {
      tags: ['qpcr', 'tox-study'],
      metadata: { sampleId: 'S-4471', description: 'run 3', documentType: 'protocol' },
    });
    await share('file', created.id, BOB, { expiresAt: FUTURE });

    const found = (await repository.findById(owner(), created.id))!;

    expect(found.tags.sort()).toEqual(['qpcr', 'tox-study']);
    expect(found.metadata).toEqual({
      sampleId: 'S-4471',
      description: 'run 3',
      documentType: 'protocol',
    });
    expect(found.folderPathAncestors).toEqual([home.id]);
    expect(found.permissions).toHaveLength(1);
    expect(found.permissions[0]).toMatchObject({ principalId: BOB, deny: false });
  });

  it('uses the same empty defaults as the Mongo record, not nulls', async () => {
    const home = await root();
    const created = await file(home);
    const found = (await repository.findById(owner(), created.id))!;

    // `toRecord` in the Mongo implementation returns `[]`/`{}` for these, never null. A route
    // doing `record.tags.map(...)` must not start throwing because the flag moved.
    expect(found.tags).toEqual([]);
    expect(found.metadata).toEqual({});
    expect(found.permissions).toEqual([]);
    expect(found.experimentId).toBeNull();
    expect(found.currentVersionId).toBeNull();
    expect(found.approvedVersionId).toBeNull();
    expect(found.departmentId).toBeNull();
    expect(found.projectId).toBeNull();
    expect(found.deletedAt).toBeNull();
    expect(found.trashedWithFolderId).toBeNull();
    expect(found.versionCount).toBe(0);
    expect(found.downloadCount).toBe(0);
    expect(found.inheritPermissions).toBe(true);
    expect(found.hasGoogleNativeContent).toBe(false);
    expect(found.createdAt).toBeInstanceOf(Date);
    expect(found.updatedAt).toBeInstanceOf(Date);
  });

  it('carries every field the contract declares', async () => {
    const home = await root();
    const created = await file(home);
    const found = (await repository.findById(owner(), created.id))!;

    // Named explicitly rather than snapshotted: a field silently dropped from hydration is a
    // field silently dropped from every API response.
    for (const key of [
      'id', 'organizationId', 'displayName', 'originalFilename', 'extension', 'category',
      'folderId', 'folderPathAncestors', 'driveType', 'ownerId', 'departmentId', 'projectId',
      'experimentId', 'currentVersionId', 'approvedVersionId', 'versionCount', 'sizeBytes',
      'mimeType', 'checksumSha256', 'tags', 'metadata', 'confidentiality', 'reviewStatus',
      'approvalStatus', 'status', 'permissions', 'inheritPermissions', 'downloadCount',
      'hasGoogleNativeContent', 'createdBy', 'createdAt', 'updatedAt', 'deletedAt',
      'trashedWithFolderId',
    ]) {
      expect(found, `missing ${key}`).toHaveProperty(key);
    }
  });
});

/* ================================================================== creation & hierarchy */

describe('create', () => {
  it('writes the full ancestor chain, ending with the containing folder', async () => {
    const home = await root();
    const project = await child(home, 'Project');
    const experiment = await child(project, 'Experiment');
    const results = await child(experiment, 'Results');
    const created = await file(results, { name: 'file.csv' });

    expect(created.folderPathAncestors).toEqual([home.id, project.id, experiment.id, results.id]);

    const rows = await d1
      .prepare('SELECT ancestor_id, depth FROM file_folder_ancestors WHERE file_id = ? ORDER BY depth')
      .bind(created.id)
      .all();
    expect(rows.results).toEqual([
      { ancestor_id: home.id, depth: 0 },
      { ancestor_id: project.id, depth: 1 },
      { ancestor_id: experiment.id, depth: 2 },
      { ancestor_id: results.id, depth: 3 },
    ]);

    expect(await repository.checkFileHierarchyIntegrity(ORG)).toEqual([]);
  });

  it('honours a caller-supplied id, because the storage key already contains it', async () => {
    const home = await root();
    const id = repository.newId();
    const created = await repository.create({
      id,
      organizationId: ORG,
      displayName: 'a.pdf',
      originalFilename: 'a.pdf',
      extension: 'pdf',
      category: 'document',
      folderId: home.id,
      folderPathAncestors: [home.id],
      driveType: 'my',
      ownerId: ALICE,
      departmentId: null,
      projectId: null,
      confidentiality: 'internal',
      sizeBytes: 1,
      mimeType: 'application/pdf',
      checksumSha256: 'd'.repeat(64),
      createdBy: ALICE,
    });
    expect(created.id).toBe(id);
  });

  it('refuses a folder in another organization rather than creating a cross-tenant file', async () => {
    const foreignHome = await root({ organizationId: ORG_B, ownerId: FOREIGNER });
    await expect(file(foreignHome, { organizationId: ORG })).rejects.toThrow();
  });

  it('leaves nothing behind when the batch fails', async () => {
    const home = await root();
    const id = repository.newId();

    // A non-existent owner violates the foreign key, so the whole batch rolls back — including
    // the ancestor rows, which would otherwise outlive the file they describe.
    await expect(
      repository.create({
        id,
        organizationId: ORG,
        displayName: 'a.pdf',
        originalFilename: 'a.pdf',
        extension: 'pdf',
        category: 'document',
        folderId: home.id,
        folderPathAncestors: [home.id],
        driveType: 'my',
        ownerId: 'no-such-user',
        departmentId: null,
        projectId: null,
        confidentiality: 'internal',
        sizeBytes: 1,
        mimeType: 'application/pdf',
        checksumSha256: 'e'.repeat(64),
        createdBy: ALICE,
      }),
    ).rejects.toThrow();

    const orphans = await d1
      .prepare('SELECT COUNT(*) AS n FROM file_folder_ancestors WHERE file_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });
});

describe('reparentSubtree', () => {
  it('rewrites the chains of files at every depth of the moved subtree', async () => {
    const home = await root();
    const source = await child(home, 'Source');
    const moved = await child(source, 'Moved');
    const nested = await child(moved, 'Nested');
    const destination = await child(home, 'Destination');

    const direct = await file(moved, { name: 'direct.csv' });
    const deep = await file(nested, { name: 'deep.csv' });

    // The folder repository moves the folders first — the order `folder.service.ts` uses.
    await folderRepository.moveSubtree({
      folderId: moved.id,
      newParentId: destination.id,
      newPathAncestors: [home.id, destination.id],
      driveType: 'my',
      departmentId: null,
      projectId: null,
      ownerId: ALICE,
      updatedBy: ALICE,
    });

    await repository.reparentSubtree({
      folderId: moved.id,
      newPathAncestorsForFolder: [home.id, destination.id],
      driveType: 'my',
      departmentId: null,
      projectId: null,
    });

    expect((await repository.findByIdInternal(direct.id))!.folderPathAncestors).toEqual([
      home.id,
      destination.id,
      moved.id,
    ]);
    expect((await repository.findByIdInternal(deep.id))!.folderPathAncestors).toEqual([
      home.id,
      destination.id,
      moved.id,
      nested.id,
    ]);

    expect(await repository.checkFileHierarchyIntegrity(ORG)).toEqual([]);
  });
});

/* ================================================================== patches */

describe('updateById', () => {
  it('replaces tags and upserts metadata keys without discarding the others', async () => {
    const home = await root();
    const created = await file(home, {
      tags: ['old'],
      metadata: { sampleId: 'S-1', description: 'keep me' },
    });

    const updated = (await repository.updateById(created.id, {
      tags: ['new', 'newer'],
      metadataSet: { sampleId: 'S-2' },
    }))!;

    expect(updated.tags.sort()).toEqual(['new', 'newer']);
    // The untouched key survives — this is what a dotted-path `$set` protected and what
    // `$set: { metadata }` would have destroyed.
    expect(updated.metadata).toEqual({ sampleId: 'S-2', description: 'keep me' });
  });

  it('clears exactly the keys named by metadataUnset', async () => {
    const home = await root();
    const created = await file(home, { metadata: { sampleId: 'S-1', description: 'gone' } });

    const updated = (await repository.updateById(created.id, { metadataUnset: ['description'] }))!;
    expect(updated.metadata).toEqual({ sampleId: 'S-1' });
  });

  it('applies counters as deltas rather than as reads and writes', async () => {
    const home = await root();
    const created = await file(home);

    await repository.updateById(created.id, { downloadCountDelta: 1 });
    await repository.updateById(created.id, { downloadCountDelta: 1 });
    const updated = (await repository.updateById(created.id, { versionCountDelta: 2 }))!;

    expect(updated.downloadCount).toBe(2);
    expect(updated.versionCount).toBe(2);
  });

  it('writes the case-folded name with the display name, never separately', async () => {
    const home = await root();
    const created = await file(home);

    await repository.updateById(created.id, { displayName: 'Renamed.PDF' });
    const row = await d1
      .prepare('SELECT display_name, display_name_lower FROM files WHERE id = ?')
      .bind(created.id)
      .first<{ display_name: string; display_name_lower: string }>();
    expect(row).toEqual({ display_name: 'Renamed.PDF', display_name_lower: 'renamed.pdf' });
  });

  it('an empty patch is a no-op read rather than an error', async () => {
    const home = await root();
    const created = await file(home);
    expect((await repository.updateById(created.id, {}))!.id).toBe(created.id);
  });
});

describe('updateByIdWhere', () => {
  it('applies while the guard holds and does nothing once it does not', async () => {
    const home = await root();
    const created = await file(home);
    await repository.updateById(created.id, { approvedVersionId: 'v1' });

    // Somebody else approved a newer version in the meantime.
    const stale = await repository.updateByIdWhere(
      created.id,
      { approvedVersionId: 'v0' },
      { approvalStatus: 'none' },
    );
    expect(stale).toBeNull();
    expect((await repository.findByIdInternal(created.id))!.approvedVersionId).toBe('v1');

    const applied = await repository.updateByIdWhere(
      created.id,
      { approvedVersionId: 'v1' },
      { approvalStatus: 'approved' },
    );
    expect(applied?.approvalStatus).toBe('approved');
  });
});

/* ================================================================== lifecycle */

describe('soft delete and trash', () => {
  it('hides a trashed file from reads but keeps it for the internal lookup', async () => {
    const home = await root();
    const created = await file(home);

    await repository.setDeleted({ fileId: created.id, deleted: true, userId: ALICE });

    expect(await repository.findById(owner(), created.id)).toBeNull();
    expect(await repository.findByIdInternal(created.id)).toBeNull();
    const withDeleted = await repository.findByIdInternal(created.id, { includeDeleted: true });
    expect(withDeleted?.status).toBe('trashed');
    expect(withDeleted?.deletedAt).toBeInstanceOf(Date);
  });

  it('lists what the actor trashed themselves, not what a folder took down with it', async () => {
    const home = await root();
    const folder = await child(home, 'Folder');
    const alone = await file(home, { name: 'alone.pdf' });
    const swept = await file(folder, { name: 'swept.pdf' });

    await repository.setDeleted({ fileId: alone.id, deleted: true, userId: ALICE });
    await repository.setSubtreeDeleted({ folderId: folder.id, deleted: true, userId: ALICE });

    const page = await repository.listTrashed({ actor: owner(), page: 1, pageSize: 20 });
    expect(page.items.map((item) => item.id)).toEqual([alone.id]);
    expect(page.total).toBe(1);
    // ...and the swept file really is trashed, just filed under its folder.
    expect(
      (await repository.findByIdInternal(swept.id, { includeDeleted: true }))!.trashedWithFolderId,
    ).toBe(folder.id);
  });

  it('restores only the files a folder took down with it', async () => {
    const home = await root();
    const folder = await child(home, 'Folder');
    const early = await file(folder, { name: 'early.pdf' });
    const swept = await file(folder, { name: 'swept.pdf' });

    // Trashed on its own first, so the folder's restore must leave it in the trash.
    await repository.setDeleted({ fileId: early.id, deleted: true, userId: ALICE });
    await repository.setSubtreeDeleted({ folderId: folder.id, deleted: true, userId: ALICE });
    const restored = await repository.setSubtreeDeleted({
      folderId: folder.id,
      deleted: false,
      userId: ALICE,
    });

    expect(restored).toBe(1);
    expect(await repository.findByIdInternal(swept.id)).not.toBeNull();
    expect(await repository.findByIdInternal(early.id)).toBeNull();
  });

  it('setDeletedBySystem reports whether anything changed, so a replay is visible', async () => {
    const home = await root();
    const created = await file(home);

    expect(await repository.setDeletedBySystem({ fileId: created.id, deleted: true })).toBe(true);
    // The same change arriving twice must not look like a second deletion.
    expect(await repository.setDeletedBySystem({ fileId: created.id, deleted: true })).toBe(false);

    const row = await repository.findByIdInternal(created.id, { includeDeleted: true });
    // Never falsely attributed: the change feed acts on nobody's behalf.
    expect(row?.deletedAt).toBeInstanceOf(Date);
    const raw = await d1
      .prepare('SELECT deleted_by FROM files WHERE id = ?')
      .bind(created.id)
      .first<{ deleted_by: string | null }>();
    expect(raw?.deleted_by).toBeNull();
  });

  it('purge removes the row and every table hanging off it', async () => {
    const home = await root();
    const created = await file(home, { tags: ['t'], metadata: { sampleId: 'S-1' } });

    expect(await repository.purge([created.id])).toBe(1);

    for (const [table, column] of [
      ['file_folder_ancestors', 'file_id'],
      ['file_metadata', 'file_id'],
      ['files_fts', 'file_id'],
    ] as const) {
      const row = await d1
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
        .bind(created.id)
        .first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }
  });
});

/* ================================================================== internal lookups */

describe('findByDriveFileIdInternal', () => {
  it('resolves a Drive id through file_versions to the owning file', async () => {
    const home = await root();
    const created = await file(home);
    await seedVersion(created.id, 'drive-abc');

    expect((await repository.findByDriveFileIdInternal('drive-abc'))?.id).toBe(created.id);
  });

  it('returns null for a Drive id nothing has claimed', async () => {
    expect(await repository.findByDriveFileIdInternal('drive-unknown')).toBeNull();
    expect(await repository.findByDriveFileIdInternal('')).toBeNull();
  });

  it('still resolves a file that has been trashed here', async () => {
    const home = await root();
    const created = await file(home);
    await seedVersion(created.id, 'drive-trashed');
    await repository.setDeleted({ fileId: created.id, deleted: true, userId: ALICE });

    // Deliberate: a change arriving for a file trashed on this side is still *ours*, and
    // treating it as unmanaged would hide the mirror's disagreement instead of reporting it.
    const found = await repository.findByDriveFileIdInternal('drive-trashed');
    expect(found?.id).toBe(created.id);
    expect(found?.deletedAt).not.toBeNull();
  });

  it('resolves across organizations, and returns the organization id to scope on', async () => {
    const foreignHome = await root({ organizationId: ORG_B, ownerId: FOREIGNER });
    const created = await file(foreignHome, { organizationId: ORG_B, ownerId: FOREIGNER });
    await seedVersion(created.id, 'drive-other-org', ORG_B);

    // The one method in this contract with no tenant filter, and deliberately so — the change
    // feed starts from a Drive id with no organization in hand. Matches the Mongo behaviour
    // asserted in tests/security/file-repository-boundary.test.ts.
    const found = await repository.findByDriveFileIdInternal('drive-other-org');
    expect(found?.id).toBe(created.id);
    expect(found?.organizationId).toBe(ORG_B);
  });

  it('fails deterministically when one Drive id is claimed by two files', async () => {
    const home = await root();
    const first = await file(home, { name: 'a.pdf' });
    const second = await file(home, { name: 'b.pdf' });

    // `ux_file_versions_drive_id` is what normally makes this state unreachable; it is dropped
    // for this one assertion because the question is what the repository does when the data is
    // *already* wrong — a mirror that diverged before the index existed, or around it.
    await d1.prepare('DROP INDEX ux_file_versions_drive_id').run();
    await seedVersion(first.id, 'drive-dup');
    await seedVersion(second.id, 'drive-dup');

    await expect(repository.findByDriveFileIdInternal('drive-dup')).rejects.toBeInstanceOf(
      AmbiguousDriveFileError,
    );
    // ...and the integrity check reports it rather than leaving it to be hit at runtime.
    expect(await repository.checkFileHierarchyIntegrity(ORG)).toContainEqual(
      expect.objectContaining({ kind: 'duplicate_drive_id' }),
    );

    // Restored for the rest of the suite: the harness shares one database across the file, and
    // a missing unique index would silently weaken every later assertion.
    await d1.prepare('DELETE FROM file_versions').run();
    await d1
      .prepare(
        `CREATE UNIQUE INDEX ux_file_versions_drive_id ON file_versions (google_drive_file_id)
           WHERE google_drive_file_id IS NOT NULL`,
      )
      .run();
  });
});

describe('the internal lookups bypass authorization on purpose', () => {
  it('returns a row no actor could reach through findById', async () => {
    const home = await root();
    const created = await file(home, { confidentiality: 'restricted' });

    expect(await repository.findById(actor(), created.id)).toBeNull();
    expect((await repository.findByIdInternal(created.id))?.id).toBe(created.id);
    expect((await repository.findByIdsInternal([created.id])).map((f) => f.id)).toEqual([
      created.id,
    ]);
  });
});

/* ================================================================== full-text index */

describe('files_fts stays in step with the tables it indexes', () => {
  const search = async (text: string) =>
    (await repository.search(searchInput({ text }))).items.map((item) => item.displayName);

  it('is populated on create, including metadata written in the same batch', async () => {
    const home = await root();
    await file(home, { name: 'alpha.pdf', metadata: { sampleId: 'S-4471' } });

    // The insert trigger sees no metadata — the rows land later in the same batch — so this
    // passes only because `create` refreshes the index at the end of that batch.
    expect(await search('S-4471')).toEqual(['alpha.pdf']);
  });

  it('follows a rename, without discarding the filename kept for provenance', async () => {
    const home = await root();
    const created = await file(home, {
      name: 'before.pdf',
      originalFilename: 'instrument-export.pdf',
    });

    await repository.updateById(created.id, { displayName: 'after.pdf' });

    expect(await search('after')).toEqual(['after.pdf']);
    expect(await search('before')).toEqual([]);
    // `original_filename` is a separate indexed column and a rename does not touch it — the
    // name the instrument gave the file is what makes it findable months later.
    expect(await search('instrument-export')).toEqual(['after.pdf']);
  });

  it('follows a metadata update, which fires no trigger at all', async () => {
    const home = await root();
    const created = await file(home, { name: 'alpha.pdf', metadata: { sampleId: 'S-1111' } });

    await repository.updateById(created.id, { metadataSet: { sampleId: 'S-2222' } });

    // The regression this exists for: `file_metadata` has no trigger, so before the explicit
    // refresh the index still held S-1111 and knew nothing of S-2222.
    expect(await search('S-2222')).toEqual(['alpha.pdf']);
    expect(await search('S-1111')).toEqual([]);
  });

  it('follows a metadata removal', async () => {
    const home = await root();
    const created = await file(home, { name: 'alpha.pdf', metadata: { sampleId: 'S-3333' } });

    await repository.updateById(created.id, { metadataUnset: ['sampleId'] });
    expect(await search('S-3333')).toEqual([]);
  });

  it('follows a tag update in both directions', async () => {
    const home = await root();
    const created = await file(home, { name: 'alpha.pdf', tags: ['oldtag'] });

    expect(await search('oldtag')).toEqual(['alpha.pdf']);

    await repository.updateById(created.id, { tags: ['newtag'] });
    expect(await search('newtag')).toEqual(['alpha.pdf']);
    // An index that is only ever added to keeps returning content that has been deleted.
    expect(await search('oldtag')).toEqual([]);
  });

  it('drops a trashed file out of the index entirely', async () => {
    const home = await root();
    const created = await file(home, { name: 'gone.pdf', metadata: { sampleId: 'S-9999' } });

    await repository.setDeleted({ fileId: created.id, deleted: true, userId: ALICE });
    expect(await search('S-9999')).toEqual([]);
  });

  it('never accumulates duplicate index rows for one file', async () => {
    const home = await root();
    const created = await file(home, { name: 'alpha.pdf', tags: ['a'] });

    for (const tag of ['b', 'c', 'd']) {
      await repository.updateById(created.id, { tags: [tag] });
    }

    const row = await d1
      .prepare('SELECT COUNT(*) AS n FROM files_fts WHERE file_id = ?')
      .bind(created.id)
      .first<{ n: number }>();
    // A stale duplicate would return the file once per copy from every search.
    expect(row?.n).toBe(1);
  });
});

/* ================================================================== search & aggregates */

describe('search', () => {
  it('applies the visibility predicate to the rows and to the total', async () => {
    const home = await root();
    await file(home, { name: 'mine.pdf', ownerId: ALICE });
    await file(home, { name: 'theirs.pdf', ownerId: BOB });

    const page = await repository.search(searchInput({ actor: owner(), sort: 'displayName', order: 'asc' }));
    expect(page.items.map((i) => i.displayName)).toEqual(['mine.pdf']);
    expect(page.total).toBe(1);
  });

  it('filters by tag with AND semantics, matching $all', async () => {
    const home = await root();
    await file(home, { name: 'both.pdf', tags: ['x', 'y'] });
    await file(home, { name: 'one.pdf', tags: ['x'] });

    const page = await repository.search(searchInput({ tags: ['x', 'y'] }));
    expect(page.items.map((i) => i.displayName)).toEqual(['both.pdf']);
  });

  it('filters by an exact metadata value', async () => {
    const home = await root();
    await file(home, { name: 'hit.pdf', metadata: { sampleId: 'S-1' } });
    await file(home, { name: 'miss.pdf', metadata: { sampleId: 'S-2' } });

    const page = await repository.search(searchInput({ metadata: { sampleId: 'S-1' } }));
    expect(page.items.map((i) => i.displayName)).toEqual(['hit.pdf']);
  });

  it('restricts to a folder subtree, including the folder itself', async () => {
    const home = await root();
    const branch = await child(home, 'Branch');
    const deep = await child(branch, 'Deep');
    await file(branch, { name: 'shallow.pdf' });
    await file(deep, { name: 'deep.pdf' });
    await file(home, { name: 'outside.pdf' });

    const page = await repository.search(
      searchInput({ underFolderId: branch.id, sort: 'displayName', order: 'asc' }),
    );
    expect(page.items.map((i) => i.displayName)).toEqual(['deep.pdf', 'shallow.pdf']);
  });

  it('survives text that would otherwise be an FTS5 operator', async () => {
    const home = await root();
    await file(home, { name: 'notes.pdf' });

    // A search box is user input: `NEAR`, an unbalanced quote and a bare `*` are all FTS5
    // syntax, and an unescaped query would be a 500 rather than an empty result.
    for (const text of ['NEAR', 'OR', '"', 'a*', 'sample-1 AND']) {
      await expect(repository.search(searchInput({ text }))).resolves.toBeTruthy();
    }
  });
});

describe('aggregates', () => {
  it('counts facets over the visible set only', async () => {
    const home = await root();
    await file(home, { name: 'mine.pdf', ownerId: ALICE, tags: ['shared-tag'] });
    await file(home, { name: 'theirs.pdf', ownerId: BOB, tags: ['shared-tag'] });

    const facets = await repository.searchFacets(owner());
    const tag = facets.tags.find((entry) => entry.value === 'shared-tag');
    // A count of 2 would disclose the existence of Bob's file.
    expect(tag?.count).toBe(1);
  });

  it('excludes trashed files from the project breakdown', async () => {
    const home = await root();
    const kept = await file(home, { name: 'kept.pdf', projectId: PROJ_A });
    const trashed = await file(home, { name: 'trashed.pdf', projectId: PROJ_A });
    await repository.setDeleted({ fileId: trashed.id, deleted: true, userId: ALICE });

    const breakdown = await repository.projectContentBreakdown(
      actor({ userId: ALICE, projectIds: [PROJ_A] }),
      PROJ_A,
    );

    // Deliberately different from MongoDB, where `aggregate` bypasses the soft-delete hook and
    // counts trashed files in four of these five figures while `linkedToExperiment` excludes
    // them. See §3 of file.repository.d1.ts.
    expect(breakdown.totalFiles).toBe(1);
    expect(breakdown.totalBytes).toBe(kept.sizeBytes);
    expect(breakdown.byCategory).toEqual([{ value: 'document', count: 1, bytes: 10 }]);
    expect(breakdown.byDocumentType).toEqual([{ value: 'unclassified', count: 1, bytes: 10 }]);
  });

  it('buckets files by their documentType metadata key', async () => {
    const home = await root();
    await file(home, { name: 'a.pdf', projectId: PROJ_A, metadata: { documentType: 'protocol' } });
    await file(home, { name: 'b.pdf', projectId: PROJ_A });

    const breakdown = await repository.projectContentBreakdown(
      actor({ userId: ALICE, projectIds: [PROJ_A] }),
      PROJ_A,
    );
    expect(breakdown.byDocumentType.map((row) => row.value).sort()).toEqual([
      'protocol',
      'unclassified',
    ]);
  });
});

/* ================================================================== structural reads */

describe('structural reads ignore trashed rows, as the Mongoose hook did', () => {
  it('existsWithName, countInFolder and takenNamesInFolder', async () => {
    const home = await root();
    const created = await file(home, { name: 'taken.pdf' });

    expect(await repository.existsWithName(home.id, 'taken.pdf')).toBe(true);
    expect(await repository.existsWithName(home.id, 'taken.pdf', created.id)).toBe(false);
    expect(await repository.countInFolder(home.id)).toBe(1);
    expect([...(await repository.takenNamesInFolder(home.id))]).toEqual(['taken.pdf']);

    await repository.setDeleted({ fileId: created.id, deleted: true, userId: ALICE });

    // A trashed file must not block re-creating the name.
    expect(await repository.existsWithName(home.id, 'taken.pdf')).toBe(false);
    expect(await repository.countInFolder(home.id)).toBe(0);
    expect([...(await repository.takenNamesInFolder(home.id))]).toEqual([]);
  });
});

describe('checkFileHierarchyIntegrity', () => {
  it('reports a chain whose depths are not contiguous', async () => {
    const home = await root();
    const created = await file(home);

    // A closure table has no array index to keep it honest: `boundaryDepth()` compares depths,
    // so a gap silently changes which ancestors are in scope for inheritance.
    await d1
      .prepare('UPDATE file_folder_ancestors SET depth = 5 WHERE file_id = ?')
      .bind(created.id)
      .run();

    expect(await repository.checkFileHierarchyIntegrity(ORG)).toContainEqual(
      expect.objectContaining({ kind: 'wrong_depth', fileId: created.id }),
    );
  });

  it('reports a file whose ancestor rows vanished', async () => {
    const home = await root();
    const created = await file(home);
    await d1.prepare('DELETE FROM file_folder_ancestors WHERE file_id = ?').bind(created.id).run();

    expect(await repository.checkFileHierarchyIntegrity(ORG)).toContainEqual(
      expect.objectContaining({ kind: 'missing_ancestor_rows', fileId: created.id }),
    );
  });
});
