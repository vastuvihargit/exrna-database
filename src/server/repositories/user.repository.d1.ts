/**
 * The D1 user repository.
 *
 * Verified against `user.repository.mongo.ts` rather than against a specification: the two run
 * the same suite in `tests/d1/user-department-repository.test.ts`, because "the API response
 * shape is stable" is a claim about two implementations agreeing, and only a test that runs
 * both can make it.
 *
 * ── Three places where D1 is not a transliteration of the Mongo query ────────────────────
 *
 * 1. **`projectIds` comes from `project_members`.** MongoDB stored project membership twice —
 *    `users.projectIds[]` and `projects.memberUserIds[]` — and D1 keeps one copy
 *    (see `identity.ts`). So the field the contract still exposes is now a join, not a column.
 *    It is loaded in one batched query per listing, never one per row.
 *
 * 2. **`authProviders` comes from `user_auth_providers`.** Same shape of change, same batching.
 *
 * 3. **`updatedAt` is written explicitly.** Mongoose's `timestamps: true` maintained it on
 *    every save; SQL has no equivalent, so every write path here sets it. A missing
 *    `updated_at` would not fail anything loudly — it would just quietly stop being true.
 *
 * ── What is deliberately *not* added ────────────────────────────────────────────────────
 *
 * No `deleted_at IS NULL` predicate. `user.model.ts` includes the soft-delete *fields* but does
 * not call `applySoftDeleteFilter`, so MongoDB returns soft-deleted users from these queries
 * today. Filtering them here would be a silent behaviour change disguised as a tidy-up.
 */
import { and, count, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { withBatch, type Database } from '@/server/db/d1';
import { getD1 } from '@/server/db/d1-context';
import { users, userAuthProviders } from '@/server/db/schema/identity';
import { projectMembers } from '@/server/db/schema/research';
import type { UserStatus } from '@/server/db/models';
import type {
  CreateUserInput,
  FindForMentionsInput,
  ListUsersCriteria,
  UserPatch,
  UserRecord,
  UserRepository,
} from './user.repository.contract';
import { USER_SORT_FIELDS } from './user.repository.contract';

type UserRow = typeof users.$inferSelect;

/* ------------------------------------------------------------------ conversions */

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * `mfa` is a JSON column holding the sub-document MongoDB embedded. Only `enabled` is exposed;
 * `secret` and `backupCodes` are in there and must never reach a record the API can serialize.
 */
function mfaEnabled(raw: string | null): boolean {
  if (!raw) return false;
  try {
    return Boolean((JSON.parse(raw) as { enabled?: unknown }).enabled);
  } catch {
    // A malformed blob means "we cannot prove MFA is on", and the safe reading of that is off.
    return false;
  }
}

function toUserRecord(
  row: UserRow,
  projectIds: string[],
  authProviders: string[],
): UserRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    emailDomain: row.emailDomain,
    name: row.name,
    avatarUrl: row.avatarUrl ?? null,
    jobTitle: row.jobTitle ?? null,
    status: row.status as UserStatus,
    isSuperAdmin: Boolean(row.isSuperAdmin),
    departmentId: row.departmentId ?? null,
    projectIds,
    storageQuotaBytes: row.storageQuotaBytes,
    storageUsedBytes: row.storageUsedBytes ?? 0,
    lastLoginAt: toDate(row.lastLoginAt),
    lastActiveAt: toDate(row.lastActiveAt),
    failedLoginCount: row.failedLoginCount ?? 0,
    lockedUntil: toDate(row.lockedUntil),
    passwordUpdatedAt: toDate(row.passwordUpdatedAt),
    mustChangePassword: Boolean(row.mustChangePassword),
    mfaEnabled: mfaEnabled(row.mfa),
    authProviders,
    createdAt: new Date(row.createdAt),
    deactivatedAt: toDate(row.deactivatedAt),
    deactivationReason: row.deactivationReason ?? null,
  };
}

/**
 * Loads the two child collections for a page of users in two queries, not two per row.
 *
 * The N+1 version of this would be invisible on a developer's 12-row database and would be the
 * whole cost of the endpoint on a 400-employee directory.
 */
async function hydrate(db: Database, rows: UserRow[]): Promise<UserRecord[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  const [memberships, providers] = await Promise.all([
    db
      .select({ userId: projectMembers.userId, projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(inArray(projectMembers.userId, ids)),
    db
      .select({ userId: userAuthProviders.userId, provider: userAuthProviders.provider })
      .from(userAuthProviders)
      .where(inArray(userAuthProviders.userId, ids)),
  ]);

  const projectsByUser = new Map<string, string[]>();
  for (const row of memberships) {
    const list = projectsByUser.get(row.userId);
    if (list) list.push(row.projectId);
    else projectsByUser.set(row.userId, [row.projectId]);
  }

  const providersByUser = new Map<string, string[]>();
  for (const row of providers) {
    if (!row.provider) continue;
    const list = providersByUser.get(row.userId);
    if (list) list.push(row.provider);
    else providersByUser.set(row.userId, [row.provider]);
  }

  return rows.map((row) =>
    toUserRecord(row, projectsByUser.get(row.id) ?? [], providersByUser.get(row.id) ?? []),
  );
}

async function hydrateOne(db: Database, row: UserRow | undefined): Promise<UserRecord | null> {
  if (!row) return null;
  const [record] = await hydrate(db, [row]);
  return record ?? null;
}

/**
 * Escapes the LIKE metacharacters so a search for "100%" is a search for the literal string.
 * Without this, `%` typed into the directory search box matches every employee.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/* ------------------------------------------------------------------ reads */

export async function findById(id: string): Promise<UserRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return hydrateOne(db, row);
}

export async function findByIds(ids: string[]): Promise<UserRecord[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();
  const rows = await db.select().from(users).where(inArray(users.id, unique));
  return hydrate(db, rows);
}

export async function findByEmail(email: string): Promise<UserRecord | null> {
  const db = await getD1();
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return hydrateOne(db, row);
}

/**
 * The Mongo model marks `passwordHash` `select: false`, so it is loaded only here. D1 has no
 * such notion — every column is selectable — which makes this the one function that reads the
 * column, by convention rather than by enforcement. `UserRecord` has no field for it, so the
 * hash cannot leak through a record even if another query selects it.
 */
export async function findByEmailWithSecrets(
  email: string,
): Promise<{ user: UserRecord; passwordHash: string | null } | null> {
  const db = await getD1();
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (!row) return null;
  const record = await hydrateOne(db, row);
  return record ? { user: record, passwordHash: row.passwordHash ?? null } : null;
}

/**
 * Mirrors the Mongo version's rules exactly: emails match in full, names match as a
 * case-insensitive **prefix** (never an unanchored substring, which would let one request
 * enumerate the directory), at most 10 name fragments, hard-capped at 50 results.
 */
export async function findForMentions(input: FindForMentionsInput): Promise<UserRecord[]> {
  const branches: SQL[] = [];

  if (input.emails.length > 0) {
    branches.push(inArray(users.email, input.emails.map((email) => email.toLowerCase())));
  }
  for (const name of input.names.slice(0, 10)) {
    branches.push(sql`${users.name} LIKE ${`${escapeLike(name)}%`} ESCAPE '\\'`);
  }
  if (branches.length === 0) return [];

  const db = await getD1();
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.organizationId, input.organizationId), or(...branches)))
    .limit(Math.min(input.limit ?? 20, 50));

  return hydrate(db, rows);
}

export async function list(
  criteria: ListUsersCriteria,
): Promise<{ items: UserRecord[]; total: number }> {
  const db = await getD1();

  const predicates: SQL[] = [eq(users.organizationId, criteria.organizationId)];

  if (criteria.status) predicates.push(eq(users.status, criteria.status));
  if (criteria.isSuperAdmin !== undefined) {
    predicates.push(eq(users.isSuperAdmin, criteria.isSuperAdmin));
  }
  if (criteria.departmentId) predicates.push(eq(users.departmentId, criteria.departmentId));

  if (criteria.search) {
    // Same shape as the Mongo version: email is a prefix match, name is a substring match.
    // `slice(0, 80)` matches the cap the regex path applied.
    const term = escapeLike(criteria.search.slice(0, 80));
    predicates.push(
      or(
        sql`${users.email} LIKE ${`${term}%`} ESCAPE '\\'`,
        sql`${users.name} LIKE ${`%${term}%`} ESCAPE '\\'`,
      )!,
    );
  }

  const where = and(...predicates);

  const sortKey = (USER_SORT_FIELDS as readonly string[]).includes(criteria.sort ?? '')
    ? (criteria.sort as (typeof USER_SORT_FIELDS)[number])
    : 'name';
  const column = {
    name: users.name,
    email: users.email,
    createdAt: users.createdAt,
    lastLoginAt: users.lastLoginAt,
    status: users.status,
  }[sortKey];

  // SQLite's default BINARY collation and MongoDB's default simple collation are both
  // byte-order, so this ordering matches the Mongo listing rather than merely resembling it.
  const direction = criteria.order === 'desc' ? sql`DESC` : sql`ASC`;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(users)
      .where(where)
      .orderBy(sql`${column} ${direction}`)
      .limit(criteria.pageSize)
      .offset((criteria.page - 1) * criteria.pageSize),
    db.select({ value: count() }).from(users).where(where),
  ]);

  return { items: await hydrate(db, rows), total: totals[0]?.value ?? 0 };
}

export async function countByOrganization(organizationId: string): Promise<number> {
  const db = await getD1();
  const rows = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.organizationId, organizationId));
  return rows[0]?.value ?? 0;
}

/* ------------------------------------------------------------------ writes */

export async function create(input: CreateUserInput): Promise<UserRecord> {
  const db = await getD1();
  const now = nowIso();
  // Post-cutover rows carry a UUID rather than a minted ObjectId, so "was this row migrated
  // or created here?" stays answerable. See `_shared.ts`.
  const id = crypto.randomUUID();

  const row: typeof users.$inferInsert = {
    id,
    organizationId: input.organizationId,
    // Mongoose applied `lowercase: true` on write; SQL has no such hook, so it is explicit.
    email: input.email.toLowerCase(),
    emailDomain: input.emailDomain.toLowerCase(),
    name: input.name,
    jobTitle: input.jobTitle ?? null,
    status: input.status,
    departmentId: input.departmentId ?? null,
    storageQuotaBytes: input.storageQuotaBytes,
    storageUsedBytes: 0,
    passwordHash: input.passwordHash ?? null,
    passwordUpdatedAt: input.passwordHash ? now : null,
    mustChangePassword: false,
    mfa: '{"enabled":false}',
    preferences: '{}',
    isSuperAdmin: input.isSuperAdmin ?? false,
    failedLoginCount: 0,
    invitedBy: input.invitedBy ?? null,
    invitedAt: now,
    activatedAt: input.status === 'active' ? now : null,
    createdAt: now,
    updatedAt: now,
  };

  const statements: BatchItem<'sqlite'>[] = [db.insert(users).values(row)];
  if (input.authProvider) {
    statements.push(
      db.insert(userAuthProviders).values({
        id: crypto.randomUUID(),
        userId: id,
        provider: input.authProvider,
        providerAccountId: null,
        linkedAt: now,
      }),
    );
  }

  // One atomic list: a user without the auth provider row it was created with would be an
  // account nobody can sign into. `withBatch` is the Phase 2 replacement for the Mongo
  // session — D1 runs the list in one implicit transaction and rolls back entirely on failure.
  await withBatch(db, statements);

  const created = await findById(id);
  if (!created) throw new Error(`User ${id} disappeared immediately after insert`);
  return created;
}

/** Translates the neutral patch into columns, dropping `undefined` and preserving `null`. */
function toColumns(patch: UserPatch): Partial<typeof users.$inferInsert> {
  const columns: Partial<typeof users.$inferInsert> = {};

  if (patch.name !== undefined) columns.name = patch.name;
  if (patch.jobTitle !== undefined) columns.jobTitle = patch.jobTitle;
  if (patch.departmentId !== undefined) columns.departmentId = patch.departmentId;
  if (patch.storageQuotaBytes !== undefined) columns.storageQuotaBytes = patch.storageQuotaBytes;
  if (patch.storageUsedBytes !== undefined) columns.storageUsedBytes = patch.storageUsedBytes;
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.activatedAt !== undefined) columns.activatedAt = iso(patch.activatedAt);
  if (patch.deactivatedAt !== undefined) columns.deactivatedAt = iso(patch.deactivatedAt);
  if (patch.deactivatedBy !== undefined) columns.deactivatedBy = patch.deactivatedBy;
  if (patch.deactivationReason !== undefined) {
    columns.deactivationReason = patch.deactivationReason;
  }
  if (patch.failedLoginCount !== undefined) columns.failedLoginCount = patch.failedLoginCount;
  if (patch.lockedUntil !== undefined) columns.lockedUntil = iso(patch.lockedUntil);
  if (patch.lastActiveAt !== undefined) columns.lastActiveAt = iso(patch.lastActiveAt);
  if (patch.mustChangePassword !== undefined) {
    columns.mustChangePassword = patch.mustChangePassword;
  }

  return columns;
}

export async function updateById(id: string, patch: UserPatch): Promise<UserRecord | null> {
  if (!id) return null;
  const columns = toColumns(patch);
  if (Object.keys(columns).length === 0) return findById(id);

  const db = await getD1();
  const updated = await db
    .update(users)
    .set({ ...columns, updatedAt: nowIso() })
    .where(eq(users.id, id))
    .returning();

  if (updated.length === 0) return null;
  return findById(id);
}

export async function setPasswordHash(id: string, passwordHash: string): Promise<void> {
  if (!id) return;
  const db = await getD1();
  const now = nowIso();
  await db
    .update(users)
    .set({ passwordHash, passwordUpdatedAt: now, mustChangePassword: false, updatedAt: now })
    .where(eq(users.id, id));
}

/**
 * Mongo did this with `$inc` and read the new value back from `findOneAndUpdate`. The SQL
 * equivalent is `RETURNING`, and it matters that it is one statement rather than
 * read-then-write: two failed logins arriving together must count as two, or a lockout
 * threshold can be walked past by racing it.
 */
export async function recordFailedLogin(id: string, lockThreshold: number): Promise<number> {
  if (!id) return 0;
  const db = await getD1();

  const [row] = await db
    .update(users)
    .set({
      failedLoginCount: sql`${users.failedLoginCount} + 1`,
      updatedAt: nowIso(),
    })
    .where(eq(users.id, id))
    .returning({ failedLoginCount: users.failedLoginCount });

  const count = row?.failedLoginCount ?? 0;

  if (count >= lockThreshold) {
    // Exponential backoff: 15 min for the first lock, doubling, capped at 24 h.
    const excess = count - lockThreshold;
    const minutes = Math.min(15 * 2 ** excess, 24 * 60);
    await db
      .update(users)
      .set({
        lockedUntil: new Date(Date.now() + minutes * 60_000).toISOString(),
        updatedAt: nowIso(),
      })
      .where(eq(users.id, id));
  }

  return count;
}

export async function recordSuccessfulLogin(id: string): Promise<void> {
  if (!id) return;
  const db = await getD1();
  const now = nowIso();
  await db
    .update(users)
    .set({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: now,
      lastActiveAt: now,
      updatedAt: now,
    })
    .where(eq(users.id, id));
}

/**
 * Mongo expressed "link it unless it is already linked" as a conditional update
 * (`'authProviders.provider': { $ne: provider }`). The SQL equivalent leans on the
 * `ux_user_auth_providers` unique index instead of a read-then-write, so two concurrent
 * OAuth callbacks cannot both decide the provider is absent.
 */
export async function linkAuthProvider(
  id: string,
  provider: 'password' | 'google' | 'microsoft',
  providerAccountId: string | null,
): Promise<void> {
  if (!id) return;
  const db = await getD1();
  await db
    .insert(userAuthProviders)
    .values({
      id: crypto.randomUUID(),
      userId: id,
      provider,
      providerAccountId,
      linkedAt: nowIso(),
    })
    .onConflictDoNothing({ target: [userAuthProviders.userId, userAuthProviders.provider] });
}

export const d1UserRepository: UserRepository = {
  findById,
  findByIds,
  findByEmail,
  findByEmailWithSecrets,
  findForMentions,
  list,
  create,
  updateById,
  setPasswordHash,
  recordFailedLogin,
  recordSuccessfulLogin,
  linkAuthProvider,
  countByOrganization,
};
