/**
 * The corrected visibility rule: a denial never grants visibility, and an expired entry
 * grants nothing at all.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────────────────
 *
 * `resourceVisibilityFilter` had no deny guard, and its ACL branch matched
 * `permissions.principalId` without looking at `deny` or `expiresAt`. So a folder carrying an
 * explicit **denial** naming you was *more* visible to you than one with no entry at all, and
 * an expired share kept granting visibility for ever.
 *
 * `canAccess` still refused the action, so nobody could open the file. What leaked was its
 * name, its existence and its place in the result count — which for research data is the
 * disclosure that matters.
 *
 * ── How this is tested ──────────────────────────────────────────────────────────────────
 *
 * Against the filter directly, executed by a real MongoDB, rather than through a service.
 * The filter *is* the security boundary — it is what every listing `$and`s in — so asserting
 * on it removes the question of whether some caller forgot to apply it. The equivalent D1
 * assertions live in `tests/d1/` and are written against the same scenarios.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { childVisibilityFilter, resourceVisibilityFilter } from '@/server/permissions/visibility';
import type { Actor } from '@/server/permissions/actor';
import type { Permission } from '@/server/domain/permissions';

let db: TestDb;

const ORG = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const VIEWER = new Types.ObjectId();
const DEPARTMENT = new Types.ObjectId();

const HOUR = 3_600_000;

beforeAll(async () => {
  db = await startTestDb();
  if (!db.available) {
    throw new Error(`This suite asserts a security rule and needs a database: ${db.reason}`);
  }
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: String(VIEWER),
    email: 'viewer@company.com',
    name: 'Viewer',
    organizationId: String(ORG),
    departmentId: String(DEPARTMENT),
    projectIds: [],
    isSuperAdmin: false,
    status: 'active',
    grants: [],
    permissions: new Set<Permission>(),
    roleKeys: [],
    highestRank: 0,
    sessionId: 'test-session',
    storageQuotaBytes: 0,
    storageUsedBytes: 0,
    ...overrides,
  };
}

interface EntryInput {
  deny?: boolean;
  expiresAt?: Date | null;
  principalId?: Types.ObjectId;
}

/**
 * One folder in the viewer's own department, carrying a single ACL entry.
 *
 * `confidentiality` defaults to `restricted`, which clearance alone never covers — so for the
 * ordinary actor only an ACL entry can make the folder visible, and the entry is therefore the
 * only variable in the test.
 *
 * The super-admin cases must use `internal` instead. A super admin with no role grants has
 * minimal clearance, so a `restricted` folder is invisible to them regardless of any deny —
 * which would make the deny test pass without the deny guard existing at all.
 */
async function seedFolder(
  name: string,
  entry: EntryInput | null,
  confidentiality: 'internal' | 'restricted' = 'restricted',
): Promise<string> {
  const { FolderModel } = await import('@/server/db/models');
  const doc = await FolderModel.create({
    organizationId: ORG,
    name,
    nameLower: name.toLowerCase(),
    parentFolderId: null,
    pathAncestors: [],
    depth: 0,
    driveType: 'department',
    ownerId: OWNER,
    departmentId: DEPARTMENT,
    confidentiality,
    createdBy: OWNER,
    permissions: entry
      ? [
          {
            principalType: 'user',
            principalId: entry.principalId ?? VIEWER,
            accessLevel: 'viewer',
            deny: entry.deny ?? false,
            expiresAt: entry.expiresAt ?? null,
          },
        ]
      : [],
  });
  return String(doc._id);
}

async function visibleIds(filter: Record<string, unknown>): Promise<string[]> {
  const { FolderModel } = await import('@/server/db/models');
  const docs = await FolderModel.find(filter).select({ _id: 1 }).lean<Array<{ _id: Types.ObjectId }>>().exec();
  return docs.map((doc) => String(doc._id));
}

describe('resourceVisibilityFilter — denials and expiry', () => {
  it('does not reveal a resource the actor is explicitly denied', async () => {
    const denied = await seedFolder('Denied to me', { deny: true });
    const allowed = await seedFolder('Shared with me', {});

    const ids = await visibleIds(resourceVisibilityFilter(actor()));

    expect(ids).toContain(allowed);
    // Before the correction the deny entry MATCHED the ACL branch and granted visibility.
    expect(ids).not.toContain(denied);
  });

  it('does not reveal a resource whose share has expired', async () => {
    const expired = await seedFolder('Expired share', {
      expiresAt: new Date(Date.now() - HOUR),
    });
    const live = await seedFolder('Live share', { expiresAt: new Date(Date.now() + HOUR) });

    const ids = await visibleIds(resourceVisibilityFilter(actor()));

    expect(ids).toContain(live);
    expect(ids).not.toContain(expired);
  });

  /**
   * `aclGrants()` skips an expired entry before it looks at `deny`, so an expired denial
   * stops denying. Visibility must agree, or a stale deny would hide something the actor is
   * once again allowed to open.
   */
  it('ignores an expired denial, matching canAccess', async () => {
    const staleDeny = await seedFolder('Stale deny plus live share', { deny: true, expiresAt: new Date(Date.now() - HOUR) });

    const { FolderModel } = await import('@/server/db/models');
    await FolderModel.updateOne(
      { _id: new Types.ObjectId(staleDeny) },
      {
        $push: {
          permissions: {
            principalType: 'user',
            principalId: VIEWER,
            accessLevel: 'viewer',
            deny: false,
            expiresAt: null,
          },
        },
      },
    ).exec();

    const ids = await visibleIds(resourceVisibilityFilter(actor()));
    expect(ids).toContain(staleDeny);
  });

  it('denies a super admin, because deny precedes super admin in canAccess', async () => {
    // `internal`, so the super admin's clearance genuinely reaches it and the deny is the
    // only thing that can remove it. The control below is what proves that.
    const denied = await seedFolder('Denied to the super admin', { deny: true }, 'internal');
    const control = await seedFolder('Visible to the super admin', null, 'internal');

    const ids = await visibleIds(
      resourceVisibilityFilter(actor({ isSuperAdmin: true, departmentId: null })),
    );

    expect(ids).toContain(control);
    expect(ids).not.toContain(denied);
  });

  it('does not let a denial naming somebody else hide a resource from this actor', async () => {
    const denyingSomebodyElse = await seedFolder(
      'Denied to a third party',
      { deny: true, principalId: new Types.ObjectId() },
      'internal',
    );

    const ids = await visibleIds(
      resourceVisibilityFilter(actor({ isSuperAdmin: true, departmentId: null })),
    );
    expect(ids).toContain(denyingSomebodyElse);
  });

  it('still returns nothing but owned content for an actor with no department, projects or shares', async () => {
    await seedFolder('Somebody else in another department', null);

    const stranger = actor({
      userId: String(new Types.ObjectId()),
      departmentId: null,
      projectIds: [],
      grants: [],
    });

    const ids = await visibleIds(resourceVisibilityFilter(stranger));
    expect(ids).toEqual([]);
  });
});

describe('childVisibilityFilter — expiry', () => {
  it('does not reveal a child whose share has expired', async () => {
    const expired = await seedFolder('Expired child share', {
      expiresAt: new Date(Date.now() - HOUR),
    });

    // Clearance alone cannot reach `restricted`, so only the (expired) entry could.
    const ids = await visibleIds(childVisibilityFilter(actor()));
    expect(ids).not.toContain(expired);
  });

  it('still reveals a child with a live share', async () => {
    const live = await seedFolder('Live child share', { expiresAt: new Date(Date.now() + HOUR) });
    const ids = await visibleIds(childVisibilityFilter(actor()));
    expect(ids).toContain(live);
  });
});
