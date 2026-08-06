/**
 * Phase 3, module 1 — users and departments.
 *
 * The acceptance criterion is "API response shapes remain stable". That is a claim about two
 * implementations *agreeing*, so this suite runs both of them: a real MongoDB
 * (`mongodb-memory-server`) and a real D1 (Miniflare/workerd SQLite), in one process, through
 * the same repository contract.
 *
 * Three kinds of assertion live here, and they answer different questions:
 *
 *   1. `describe.each` over both engines — "does each implementation behave correctly?"
 *   2. the `parity` block — "do the two produce byte-identical records for identical input?"
 *      This is the one that would catch a `Date` becoming a string, a `null` becoming
 *      `undefined`, or a missing field, none of which a single-engine test can see.
 *   3. the `d1 specifics` block — the three places D1 is not a transliteration of the Mongo
 *      query, plus the failure modes that only exist in SQL (LIKE metacharacters).
 *
 * It fails rather than skips when a database is unavailable, for the reason recorded in
 * `vitest.config.ts` and repeated in `schema-contract.test.ts`: a run that quietly checked
 * nothing is indistinguishable from one that checked everything.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestDb, stopTestDb, clearCollections } from '../helpers/test-db';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import {
  d1UserRepository,
  mongoUserRepository,
  type UserRecord,
} from '@/server/repositories/user.repository';
import * as userFacade from '@/server/repositories/user.repository';
import {
  d1DepartmentRepository,
  mongoDepartmentRepository,
  type DepartmentRecord,
} from '@/server/repositories/department.repository';
import type { UserRepository } from '@/server/repositories/user.repository.contract';
import type { DepartmentRepository } from '@/server/repositories/department.repository.contract';
import { clearDataSourceOverrides, setDataSourceOverride } from '@/server/repositories/data-source';

/** Real ObjectId hex, so the Mongo side accepts it and the D1 side stores it unchanged. */
const ORG_A = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';

const ISO = '2026-01-01T00:00:00.000Z';

let d1: D1Database;

interface Engine {
  name: 'mongo' | 'd1';
  users: UserRepository;
  departments: DepartmentRepository;
  reset: () => Promise<void>;
}

/* ------------------------------------------------------------------ D1 fixtures */

async function seedD1Organizations(): Promise<void> {
  for (const id of [ORG_A, ORG_B]) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO organizations
           (id, name, slug, email_domains, settings, storage_used_bytes, file_count, is_active, created_at, updated_at)
         VALUES (?, ?, ?, '[]', '{}', 0, 0, 1, ?, ?)`,
      )
      .bind(id, `Org ${id.slice(-2)}`, `org-${id.slice(-2)}`, ISO, ISO)
      .run();
  }
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
  await seedD1Organizations();
}, 300_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  clearDataSourceOverrides();
  await stopTestD1();
  await stopTestDb();
});

/**
 * `users` and `departments` reference each other, so the cross-references are nulled before
 * either table is emptied. Deleting in any order without this step trips a foreign key.
 */
const D1_RESET = [
  'DELETE FROM project_members',
  'DELETE FROM user_auth_providers',
  'DELETE FROM projects',
  'UPDATE departments SET created_by = NULL, head_user_id = NULL, parent_department_id = NULL',
  'UPDATE users SET department_id = NULL, invited_by = NULL, deactivated_by = NULL',
  'DELETE FROM users',
  'DELETE FROM departments',
];

const ENGINES: Engine[] = [
  {
    name: 'mongo',
    users: mongoUserRepository,
    departments: mongoDepartmentRepository,
    reset: () => clearCollections(),
  },
  {
    name: 'd1',
    users: d1UserRepository,
    departments: d1DepartmentRepository,
    reset: async () => {
      await clearD1(d1, D1_RESET);
      await seedD1Organizations();
    },
  },
];

/* ------------------------------------------------------------------ helpers */

function makeUser(overrides: Partial<Parameters<UserRepository['create']>[0]> = {}) {
  return {
    organizationId: ORG_A,
    email: 'Ada.Lovelace@company.com',
    emailDomain: 'Company.com',
    name: 'Ada Lovelace',
    jobTitle: 'Principal Scientist',
    status: 'active' as const,
    departmentId: null,
    storageQuotaBytes: 20 * 1024 ** 3,
    ...overrides,
  };
}

/**
 * `createdBy` is required rather than defaulted.
 *
 * The first draft of this file defaulted it to the organization id. MongoDB accepted that —
 * it stores whatever ObjectId it is given — and D1 rejected it, because `departments.created_by`
 * carries a real foreign key to `users.id`. Eight tests failed and the constraint was right:
 * the Mongo database has been able to hold a department attributed to a non-existent employee
 * all along, and D1 cannot. Making the parameter mandatory keeps that honest at the call site.
 */
function makeDepartment(
  createdBy: string,
  overrides: Partial<Parameters<DepartmentRepository['create']>[0]> = {},
) {
  return {
    organizationId: ORG_A,
    name: 'Molecular Biology',
    code: 'mb',
    description: 'exRNA workstream',
    headUserId: null,
    parentDepartmentId: null,
    storageQuotaBytes: 500 * 1024 ** 3,
    createdBy,
    ...overrides,
  };
}

/** An employee to attribute fixture departments to, so the `created_by` foreign key resolves. */
async function createFounder(users: UserRepository): Promise<string> {
  const founder = await users.create(
    makeUser({ email: 'founder@company.com', name: 'Zz Founder' }),
  );
  return founder.id;
}

/**
 * Replaces engine-specific values with symbolic ones so two records can be compared directly.
 *
 * Dates become the marker `<Date>` rather than being dropped: the whole point is to catch a
 * D1 `TEXT` column arriving as a string where Mongo yields a `Date`, and dropping the field
 * would hide exactly that.
 */
function comparable(record: UserRecord, aliases: Map<string, string>): Record<string, unknown> {
  const alias = (value: string | null): string | null =>
    value === null ? null : (aliases.get(value) ?? `<unmapped:${value}>`);

  const date = (value: Date | null): string | null => {
    if (value === null) return null;
    if (!(value instanceof Date)) return `<not-a-Date:${typeof value}>`;
    return Number.isNaN(value.getTime()) ? '<Invalid Date>' : '<Date>';
  };

  return {
    id: alias(record.id),
    organizationId: record.organizationId,
    email: record.email,
    emailDomain: record.emailDomain,
    name: record.name,
    avatarUrl: record.avatarUrl,
    jobTitle: record.jobTitle,
    status: record.status,
    isSuperAdmin: record.isSuperAdmin,
    departmentId: alias(record.departmentId),
    projectIds: record.projectIds.map((id) => aliases.get(id) ?? `<unmapped:${id}>`).sort(),
    storageQuotaBytes: record.storageQuotaBytes,
    storageUsedBytes: record.storageUsedBytes,
    lastLoginAt: date(record.lastLoginAt),
    lastActiveAt: date(record.lastActiveAt),
    failedLoginCount: record.failedLoginCount,
    lockedUntil: date(record.lockedUntil),
    passwordUpdatedAt: date(record.passwordUpdatedAt),
    mustChangePassword: record.mustChangePassword,
    mfaEnabled: record.mfaEnabled,
    authProviders: [...record.authProviders].sort(),
    createdAt: date(record.createdAt),
    deactivatedAt: date(record.deactivatedAt),
    deactivationReason: record.deactivationReason,
  };
}

function comparableDepartment(
  record: DepartmentRecord,
  aliases: Map<string, string>,
): Record<string, unknown> {
  const alias = (value: string | null): string | null =>
    value === null ? null : (aliases.get(value) ?? `<unmapped:${value}>`);

  return {
    id: alias(record.id),
    organizationId: record.organizationId,
    name: record.name,
    code: record.code,
    description: record.description,
    headUserId: alias(record.headUserId),
    parentDepartmentId: alias(record.parentDepartmentId),
    rootFolderId: record.rootFolderId,
    storageQuotaBytes: record.storageQuotaBytes,
    storageUsedBytes: record.storageUsedBytes,
    memberCount: record.memberCount,
    isActive: record.isActive,
    createdAt: record.createdAt instanceof Date ? '<Date>' : `<not-a-Date>`,
  };
}

/* ================================================================== per-engine */

describe.each(ENGINES)('$name repository', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  describe('users — writes', () => {
    it('lower-cases the email and domain on create, as the Mongoose schema did', async () => {
      const created = await engine.users.create(makeUser());

      expect(created.email).toBe('ada.lovelace@company.com');
      expect(created.emailDomain).toBe('company.com');
      // Case-insensitive lookup is a property of the stored value, not of the query.
      expect(await engine.users.findByEmail('ADA.LOVELACE@COMPANY.COM')).not.toBeNull();
    });

    it('records the auth provider it was created with', async () => {
      const created = await engine.users.create(makeUser({ authProvider: 'google' }));
      expect(created.authProviders).toEqual(['google']);
    });

    it('stores no provider when none is given', async () => {
      const created = await engine.users.create(makeUser());
      expect(created.authProviders).toEqual([]);
    });

    it('distinguishes "leave alone" from "write null" in a patch', async () => {
      const created = await engine.users.create(
        makeUser({ jobTitle: 'Principal Scientist', status: 'active' }),
      );

      // Deactivate: sets a reason, must not disturb jobTitle.
      const deactivated = await engine.users.updateById(created.id, {
        status: 'deactivated',
        deactivatedAt: new Date(),
        deactivationReason: 'left the company',
      });
      expect(deactivated?.jobTitle).toBe('Principal Scientist');
      expect(deactivated?.deactivationReason).toBe('left the company');

      // Reactivate: explicit nulls must actually clear the columns.
      const reactivated = await engine.users.updateById(created.id, {
        status: 'active',
        deactivatedAt: null,
        deactivationReason: null,
        failedLoginCount: 0,
        lockedUntil: null,
      });
      expect(reactivated?.deactivatedAt).toBeNull();
      expect(reactivated?.deactivationReason).toBeNull();
      expect(reactivated?.jobTitle).toBe('Principal Scientist');
    });

    it('returns null when updating an id that does not exist', async () => {
      expect(await engine.users.updateById('507f1f77bcf86cd799439099', { name: 'x' })).toBeNull();
    });

    it('counts failed logins and locks at the threshold', async () => {
      const created = await engine.users.create(makeUser());

      expect(await engine.users.recordFailedLogin(created.id, 3)).toBe(1);
      expect(await engine.users.recordFailedLogin(created.id, 3)).toBe(2);
      expect(await engine.users.recordFailedLogin(created.id, 3)).toBe(3);

      const locked = await engine.users.findById(created.id);
      expect(locked?.failedLoginCount).toBe(3);
      expect(locked?.lockedUntil).toBeInstanceOf(Date);
      expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    });

    it('clears the lock and the counter on a successful login', async () => {
      const created = await engine.users.create(makeUser());
      await engine.users.recordFailedLogin(created.id, 1);
      await engine.users.recordSuccessfulLogin(created.id);

      const after = await engine.users.findById(created.id);
      expect(after?.failedLoginCount).toBe(0);
      expect(after?.lockedUntil).toBeNull();
      expect(after?.lastLoginAt).toBeInstanceOf(Date);
    });

    it('links an auth provider at most once', async () => {
      const created = await engine.users.create(makeUser());

      await engine.users.linkAuthProvider(created.id, 'google', 'google-123');
      await engine.users.linkAuthProvider(created.id, 'google', 'google-123');
      await engine.users.linkAuthProvider(created.id, 'password', null);

      const after = await engine.users.findById(created.id);
      expect([...after!.authProviders].sort()).toEqual(['google', 'password']);
    });

    it('keeps the password hash out of the record but retrievable by the one function that needs it', async () => {
      await engine.users.create(makeUser({ passwordHash: 'argon2id$fake' }));

      const record = await engine.users.findByEmail('ada.lovelace@company.com');
      expect(record).not.toBeNull();
      expect(Object.keys(record as object)).not.toContain('passwordHash');

      const withSecrets = await engine.users.findByEmailWithSecrets('ada.lovelace@company.com');
      expect(withSecrets?.passwordHash).toBe('argon2id$fake');
    });
  });

  describe('users — listing', () => {
    beforeEach(async () => {
      await engine.users.create(
        makeUser({ email: 'ada@company.com', name: 'Ada Lovelace', status: 'active' }),
      );
      await engine.users.create(
        makeUser({ email: 'grace@company.com', name: 'Grace Hopper', status: 'active' }),
      );
      await engine.users.create(
        makeUser({ email: 'alan@company.com', name: 'Alan Turing', status: 'suspended' }),
      );
      // A different tenant. Must never appear.
      await engine.users.create(
        makeUser({
          organizationId: ORG_B,
          email: 'mallory@other.com',
          name: 'Mallory Other',
        }),
      );
    });

    it('never returns a user from another organization', async () => {
      const { items, total } = await engine.users.list({
        organizationId: ORG_A,
        page: 1,
        pageSize: 50,
      });

      expect(total).toBe(3);
      expect(items.map((user) => user.email)).not.toContain('mallory@other.com');
      expect(items.every((user) => user.organizationId === ORG_A)).toBe(true);
    });

    it('filters by status', async () => {
      const { items, total } = await engine.users.list({
        organizationId: ORG_A,
        status: 'suspended',
        page: 1,
        pageSize: 50,
      });
      expect(total).toBe(1);
      expect(items[0]?.email).toBe('alan@company.com');
    });

    it('matches an email by prefix and a name by substring', async () => {
      const byEmailPrefix = await engine.users.list({
        organizationId: ORG_A,
        search: 'gra',
        page: 1,
        pageSize: 50,
      });
      expect(byEmailPrefix.items.map((user) => user.email)).toEqual(['grace@company.com']);

      // "Hopper" is inside the name but is not a prefix of any email.
      const byNameSubstring = await engine.users.list({
        organizationId: ORG_A,
        search: 'Hopper',
        page: 1,
        pageSize: 50,
      });
      expect(byNameSubstring.items.map((user) => user.email)).toEqual(['grace@company.com']);
    });

    it('search is case-insensitive', async () => {
      const { items } = await engine.users.list({
        organizationId: ORG_A,
        search: 'LOVELACE',
        page: 1,
        pageSize: 50,
      });
      expect(items.map((user) => user.email)).toEqual(['ada@company.com']);
    });

    it('paginates with a total that counts the whole match, not the page', async () => {
      const page1 = await engine.users.list({
        organizationId: ORG_A,
        page: 1,
        pageSize: 2,
        sort: 'name',
      });
      const page2 = await engine.users.list({
        organizationId: ORG_A,
        page: 2,
        pageSize: 2,
        sort: 'name',
      });

      expect(page1.total).toBe(3);
      expect(page2.total).toBe(3);
      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(1);

      const seen = [...page1.items, ...page2.items].map((user) => user.email);
      expect(new Set(seen).size).toBe(3);
    });

    it('sorts by name in both directions', async () => {
      const ascending = await engine.users.list({
        organizationId: ORG_A,
        page: 1,
        pageSize: 50,
        sort: 'name',
        order: 'asc',
      });
      const descending = await engine.users.list({
        organizationId: ORG_A,
        page: 1,
        pageSize: 50,
        sort: 'name',
        order: 'desc',
      });

      expect(ascending.items.map((user) => user.name)).toEqual([
        'Ada Lovelace',
        'Alan Turing',
        'Grace Hopper',
      ]);
      expect(descending.items.map((user) => user.name)).toEqual([
        'Grace Hopper',
        'Alan Turing',
        'Ada Lovelace',
      ]);
    });

    it('falls back to name ordering for an unknown sort key', async () => {
      const { items } = await engine.users.list({
        organizationId: ORG_A,
        page: 1,
        pageSize: 50,
        sort: 'passwordHash; DROP TABLE users',
      });
      expect(items.map((user) => user.name)).toEqual([
        'Ada Lovelace',
        'Alan Turing',
        'Grace Hopper',
      ]);
    });

    it('finds mention candidates by exact email and by name prefix only', async () => {
      const byEmail = await engine.users.findForMentions({
        organizationId: ORG_A,
        emails: ['GRACE@company.com'],
        names: [],
      });
      expect(byEmail.map((user) => user.email)).toEqual(['grace@company.com']);

      const byNamePrefix = await engine.users.findForMentions({
        organizationId: ORG_A,
        emails: [],
        names: ['Ada'],
      });
      expect(byNamePrefix.map((user) => user.name)).toEqual(['Ada Lovelace']);

      // A substring that is not a prefix must not match — otherwise one request enumerates
      // the directory.
      const bySubstring = await engine.users.findForMentions({
        organizationId: ORG_A,
        emails: [],
        names: ['Lovelace'],
      });
      expect(bySubstring).toEqual([]);
    });

    it('returns nothing for an empty mention query rather than everything', async () => {
      expect(
        await engine.users.findForMentions({ organizationId: ORG_A, emails: [], names: [] }),
      ).toEqual([]);
    });

    it('findByIds ignores ids that do not exist', async () => {
      const all = await engine.users.list({ organizationId: ORG_A, page: 1, pageSize: 50 });
      const ids = all.items.map((user) => user.id);

      const found = await engine.users.findByIds([...ids, '507f1f77bcf86cd799439099']);
      expect(found).toHaveLength(ids.length);
    });
  });

  describe('departments', () => {
    let founder: string;

    beforeEach(async () => {
      founder = await createFounder(engine.users);
    });

    it('upper-cases the code on create and finds it case-insensitively', async () => {
      const created = await engine.departments.create(makeDepartment(founder, { code: 'mb' }));
      expect(created.code).toBe('MB');
      expect(await engine.departments.findByCode(ORG_A, 'mb')).not.toBeNull();
    });

    it('orders the listing by name', async () => {
      await engine.departments.create(makeDepartment(founder, { name: 'Zoology', code: 'ZO' }));
      await engine.departments.create(makeDepartment(founder, { name: 'Assay Dev', code: 'AD' }));

      const list = await engine.departments.list({ organizationId: ORG_A });
      expect(list.map((department) => department.name)).toEqual(['Assay Dev', 'Zoology']);
    });

    it('never returns a department from another organization', async () => {
      await engine.departments.create(makeDepartment(founder, { code: 'AAA' }));
      await engine.departments.create(
        makeDepartment(founder, { organizationId: ORG_B, code: 'BBB' }),
      );

      const list = await engine.departments.list({ organizationId: ORG_A });
      expect(list.map((department) => department.code)).toEqual(['AAA']);
    });

    /**
     * Not a quirk to be tidied up later. `department.model.ts` does not apply
     * `applySoftDeleteFilter`, so MongoDB returns soft-deleted departments from this listing
     * today, and `isActive: false` is what actually hides them downstream. If D1 filtered
     * them out, a department visible before the flag flipped would vanish after it.
     */
    it('keeps soft-deleted departments in the default listing, matching MongoDB', async () => {
      const created = await engine.departments.create(makeDepartment(founder, { code: 'GONE' }));
      expect(await engine.departments.softDelete(created.id, founder)).toBe(true);

      const included = await engine.departments.list({ organizationId: ORG_A });
      expect(included.map((department) => department.code)).toContain('GONE');
      expect(included.find((department) => department.code === 'GONE')?.isActive).toBe(false);

      const excluded = await engine.departments.list({
        organizationId: ORG_A,
        includeDeleted: false,
      });
      expect(excluded.map((department) => department.code)).not.toContain('GONE');
    });

    it('counts only active members when refreshing the member count', async () => {
      const department = await engine.departments.create(makeDepartment(founder, { code: 'CNT' }));

      await engine.users.create(
        makeUser({ email: 'a@company.com', status: 'active', departmentId: department.id }),
      );
      await engine.users.create(
        makeUser({ email: 'b@company.com', status: 'active', departmentId: department.id }),
      );
      await engine.users.create(
        makeUser({ email: 'c@company.com', status: 'deactivated', departmentId: department.id }),
      );

      expect(await engine.departments.refreshMemberCount(department.id)).toBe(2);
      expect((await engine.departments.findById(department.id))?.memberCount).toBe(2);
    });

    it('returns null for an unknown id rather than throwing', async () => {
      expect(await engine.departments.findById('507f1f77bcf86cd799439099')).toBeNull();
      expect(await engine.departments.findByIds([])).toEqual([]);
    });
  });
});

/* ================================================================== parity */

describe('parity — the two implementations produce identical records', () => {
  beforeEach(async () => {
    await clearCollections();
    await clearD1(d1, D1_RESET);
    await seedD1Organizations();
  });

  it('create → findById returns the same record from both databases', async () => {
    const input = makeUser({ passwordHash: 'argon2id$fake', authProvider: 'google' });

    const fromMongo = await mongoUserRepository.create(input);
    const fromD1 = await d1UserRepository.create(input);

    const mongoAliases = new Map([[fromMongo.id, '<user>']]);
    const d1Aliases = new Map([[fromD1.id, '<user>']]);

    expect(comparable(fromD1, d1Aliases)).toEqual(comparable(fromMongo, mongoAliases));
  });

  it('a department-assigned, deactivated user matches field for field', async () => {
    const mongoFounder = await createFounder(mongoUserRepository);
    const d1Founder = await createFounder(d1UserRepository);

    const mongoDepartment = await mongoDepartmentRepository.create(makeDepartment(mongoFounder));
    const d1Department = await d1DepartmentRepository.create(makeDepartment(d1Founder));

    const patch = {
      status: 'deactivated' as const,
      deactivatedAt: new Date(),
      deactivationReason: 'contract ended',
      lockedUntil: null,
    };

    const mongoUser = await mongoUserRepository.create(
      makeUser({ departmentId: mongoDepartment.id }),
    );
    const d1User = await d1UserRepository.create(makeUser({ departmentId: d1Department.id }));

    const mongoUpdated = await mongoUserRepository.updateById(mongoUser.id, patch);
    const d1Updated = await d1UserRepository.updateById(d1User.id, patch);

    const mongoAliases = new Map([
      [mongoUser.id, '<user>'],
      [mongoDepartment.id, '<department>'],
    ]);
    const d1Aliases = new Map([
      [d1User.id, '<user>'],
      [d1Department.id, '<department>'],
    ]);

    expect(comparable(d1Updated!, d1Aliases)).toEqual(comparable(mongoUpdated!, mongoAliases));
  });

  it('department records match field for field', async () => {
    const mongoFounder = await createFounder(mongoUserRepository);
    const d1Founder = await createFounder(d1UserRepository);

    const fromMongo = await mongoDepartmentRepository.create(
      makeDepartment(mongoFounder, { description: 'exRNA workstream', code: 'mb' }),
    );
    const fromD1 = await d1DepartmentRepository.create(
      makeDepartment(d1Founder, { description: 'exRNA workstream', code: 'mb' }),
    );

    expect(comparableDepartment(fromD1, new Map([[fromD1.id, '<department>']]))).toEqual(
      comparableDepartment(fromMongo, new Map([[fromMongo.id, '<department>']])),
    );
  });

  it('listing order, totals and record shape all match', async () => {
    const people = [
      { email: 'ada@company.com', name: 'Ada Lovelace', status: 'active' as const },
      { email: 'grace@company.com', name: 'Grace Hopper', status: 'active' as const },
      { email: 'alan@company.com', name: 'Alan Turing', status: 'suspended' as const },
    ];

    for (const person of people) {
      await mongoUserRepository.create(makeUser(person));
      await d1UserRepository.create(makeUser(person));
    }

    const criteria = { organizationId: ORG_A, page: 1, pageSize: 2, sort: 'name', order: 'asc' as const };
    const fromMongo = await mongoUserRepository.list(criteria);
    const fromD1 = await d1UserRepository.list(criteria);

    expect(fromD1.total).toBe(fromMongo.total);
    expect(fromD1.items.map((user) => user.email)).toEqual(
      fromMongo.items.map((user) => user.email),
    );

    for (const [index, d1Item] of fromD1.items.entries()) {
      const mongoItem = fromMongo.items[index]!;
      expect(comparable(d1Item, new Map([[d1Item.id, '<user>']]))).toEqual(
        comparable(mongoItem, new Map([[mongoItem.id, '<user>']])),
      );
    }
  });

  it('projectIds survives the move from an embedded array to a join table', async () => {
    const projectId = '507f1f77bcf86cd799439021';

    // MongoDB: the id lives in `users.projectIds[]`.
    const mongoUser = await mongoUserRepository.create(makeUser());
    const { UserModel } = await import('@/server/db/models');
    const { Types } = await import('mongoose');
    await UserModel.updateOne(
      { _id: new Types.ObjectId(mongoUser.id) },
      { $set: { projectIds: [new Types.ObjectId(projectId)] } },
    ).exec();

    // D1: the same fact lives in `project_members`, which is the single source of truth.
    const d1Founder = await createFounder(d1UserRepository);
    const d1Department = await d1DepartmentRepository.create(makeDepartment(d1Founder));
    const d1User = await d1UserRepository.create(makeUser({ departmentId: d1Department.id }));
    await d1
      .prepare(
        `INSERT INTO projects
           (id, organization_id, department_id, name, code, description, status, confidentiality,
            storage_used_bytes, file_count, created_at, updated_at)
         VALUES (?, ?, ?, 'exRNA Discovery', 'EXRNA', '', 'active', 'internal', 0, 0, ?, ?)`,
      )
      .bind(projectId, ORG_A, d1Department.id, ISO, ISO)
      .run();
    await d1
      .prepare(`INSERT INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)`)
      .bind(projectId, d1User.id, ISO)
      .run();

    expect((await d1UserRepository.findById(d1User.id))?.projectIds).toEqual([projectId]);
    expect((await mongoUserRepository.findById(mongoUser.id))?.projectIds).toEqual([projectId]);
  });
});

/* ================================================================== d1 specifics */

describe('d1 specifics', () => {
  beforeEach(async () => {
    await clearD1(d1, D1_RESET);
    await seedD1Organizations();
  });

  /**
   * The failure mode that does not exist in MongoDB. `%` is a wildcard in SQL `LIKE`, so an
   * unescaped search term of `%` would match every employee in the organization — a directory
   * dump from the search box. The Mongo path escaped regex metacharacters for the same reason.
   */
  it('treats LIKE wildcards in a search term as literal characters', async () => {
    await d1UserRepository.create(makeUser({ email: 'ada@company.com', name: 'Ada Lovelace' }));
    await d1UserRepository.create(makeUser({ email: 'grace@company.com', name: 'Grace Hopper' }));
    await d1UserRepository.create(makeUser({ email: 'pct@company.com', name: '100% Recovery' }));

    const wildcard = await d1UserRepository.list({
      organizationId: ORG_A,
      search: '%',
      page: 1,
      pageSize: 50,
    });
    expect(wildcard.items.map((user) => user.name)).toEqual(['100% Recovery']);
    expect(wildcard.total).toBe(1);

    const underscore = await d1UserRepository.list({
      organizationId: ORG_A,
      search: '_',
      page: 1,
      pageSize: 50,
    });
    expect(underscore.total).toBe(0);
  });

  it('reports a malformed mfa blob as disabled rather than throwing', async () => {
    const created = await d1UserRepository.create(makeUser());
    await d1.prepare(`UPDATE users SET mfa = 'not json' WHERE id = ?`).bind(created.id).run();

    expect((await d1UserRepository.findById(created.id))?.mfaEnabled).toBe(false);
  });

  it('reads mfaEnabled out of the JSON column', async () => {
    const created = await d1UserRepository.create(makeUser());
    await d1
      .prepare(`UPDATE users SET mfa = '{"enabled":true,"secret":"s"}' WHERE id = ?`)
      .bind(created.id)
      .run();

    const record = await d1UserRepository.findById(created.id);
    expect(record?.mfaEnabled).toBe(true);
    // The secret is in the same column and must not ride along on the record.
    expect(JSON.stringify(record)).not.toContain('"secret"');
  });

  it('maintains updated_at on every write path', async () => {
    const created = await d1UserRepository.create(makeUser());
    const before = await d1
      .prepare('SELECT updated_at FROM users WHERE id = ?')
      .bind(created.id)
      .first<{ updated_at: string }>();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await d1UserRepository.updateById(created.id, { name: 'Ada L.' });

    const after = await d1
      .prepare('SELECT updated_at FROM users WHERE id = ?')
      .bind(created.id)
      .first<{ updated_at: string }>();

    expect(after!.updated_at > before!.updated_at).toBe(true);
  });

  it('rolls the whole create back if the auth-provider row cannot be written', async () => {
    // A duplicate primary key inside the batch. `withBatch` must abort the user insert too,
    // rather than leaving an account with no way to sign in.
    const first = await d1UserRepository.create(makeUser({ authProvider: 'google' }));
    expect(first.authProviders).toEqual(['google']);

    const before = await d1.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>();
    await expect(
      d1UserRepository.create(makeUser({ email: 'ada.lovelace@company.com' })),
    ).rejects.toThrow();
    const after = await d1.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>();

    // The unique email index rejected it; no partial row survived.
    expect(after!.c).toBe(before!.c);
  });
});

/* ================================================================== the flag */

describe('the DATA_SOURCE flag', () => {
  beforeEach(async () => {
    await clearCollections();
    await clearD1(d1, D1_RESET);
    await seedD1Organizations();
    clearDataSourceOverrides();
  });

  afterAll(() => clearDataSourceOverrides());

  it('defaults to MongoDB', async () => {
    const created = await mongoUserRepository.create(makeUser({ email: 'mongo@company.com' }));

    // The façade, with no flag set, must find the Mongo row and not the D1 one.
    expect((await userFacade.findById(created.id))?.email).toBe('mongo@company.com');
  });

  it('routes to D1 when the module is switched, and back when it is not', async () => {
    const mongoUser = await mongoUserRepository.create(makeUser({ email: 'mongo@company.com' }));
    const d1User = await d1UserRepository.create(makeUser({ email: 'd1@company.com' }));

    setDataSourceOverride('users', 'd1');
    expect((await userFacade.findById(d1User.id))?.email).toBe('d1@company.com');
    // The Mongo id does not exist in D1 — proving the call really went to the other database.
    expect(await userFacade.findById(mongoUser.id)).toBeNull();

    setDataSourceOverride('users', 'mongo');
    expect((await userFacade.findById(mongoUser.id))?.email).toBe('mongo@company.com');
    expect(await userFacade.findById(d1User.id)).toBeNull();
  });

  it('switches users without switching departments', async () => {
    setDataSourceOverride('users', 'd1');

    const { dataSourceFor } = await import('@/server/repositories/data-source');
    expect(dataSourceFor('users')).toBe('d1');
    expect(dataSourceFor('departments')).toBe('mongo');
  });
});
