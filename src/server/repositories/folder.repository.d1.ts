/**
 * The D1 folder repository.
 *
 * Two things in the MongoDB folder model have no direct SQL equivalent, and both of them are
 * load-bearing for permissions. How they are expressed here is most of what this file is.
 *
 * ── 1. `pathAncestors[]` became a closure table ─────────────────────────────────────────
 *
 * `folder_ancestors(folder_id, ancestor_id, depth)`, one row per ancestor, `depth` reproducing
 * the array's order (0 = drive root). Every hierarchy mutation therefore writes two tables that
 * must agree, and "must agree" is not a property a comment can enforce — so each mutation is a
 * single `db.batch()`, and `checkHierarchyIntegrity()` exists to prove the two representations
 * still say the same thing.
 *
 * ── 2. There is no interactive transaction ──────────────────────────────────────────────
 *
 * Mongo's `moveSubtree` runs two statements inside the caller's session, and the caller decides
 * the second one *after* seeing the first. D1 cannot do that: a batch is fixed before the first
 * statement runs. Every subtree mutation here is therefore rewritten as a set of statements
 * that need no intermediate result — and, because their *inputs* were read before the batch
 * began, each statement carries a guard on the row version those inputs came from. Either the
 * whole move applies to the state it was computed against, or none of it does and the caller
 * retries. `moveSubtree` documents the ordering that makes that work.
 *
 * ── Permission enforcement ──────────────────────────────────────────────────────────────
 *
 * Every actor-facing read applies its predicate **inside** the SQL — to the rows and to the
 * `COUNT(*)` that produces `total`, from the same builder, so the two cannot drift and a hidden
 * folder cannot be inferred from a short page or an inflated count. Nothing is filtered in
 * JavaScript afterwards.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { withBatch, type Database } from '@/server/db/d1';
import { getD1 } from '@/server/db/d1-context';
import { folders, folderAncestors } from '@/server/db/schema/drive';
import { resourcePermissions } from '@/server/db/schema/access';
import { ConflictError } from '@/server/errors/app-error';
import type { AclEntry, Actor } from '@/server/permissions/actor';
import {
  childVisibility,
  lookupVisibility,
  resourceVisibility,
} from '@/server/permissions/visibility.d1';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type {
  AclEntryWrite,
  CreateFolderInput,
  EnsureRootInput,
  FolderPage,
  FolderPatch,
  FolderRecord,
  FolderRepository,
  FolderSortField,
  HierarchyProblem,
  ListChildrenInput,
  ListForActorInput,
  ListSharedWithInput,
  MoveSubtreeInput,
  SearchFoldersInput,
} from './folder.repository.contract';

type FolderRow = typeof folders.$inferSelect;

/** Mongo's implicit cap on `takenChildNames`. Reproduced rather than removed. */
const TAKEN_NAMES_LIMIT = 5000;

/** How many times a subtree mutation re-reads and re-applies before giving up. */
const MOVE_ATTEMPTS = 3;

function nowIso(): string {
  return new Date().toISOString();
}

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/* ------------------------------------------------------------------ hydration */

/**
 * Rows → records, with the ancestor chain and the ACL loaded for the whole page in two
 * queries rather than two per row.
 *
 * A drive listing is the first screen every employee sees, so an N+1 here is an N+1 on the
 * hot path.
 */
async function hydrate(db: Database, rows: FolderRow[]): Promise<FolderRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [ancestorRows, aclRows] = await Promise.all([
    db
      .select({
        folderId: folderAncestors.folderId,
        ancestorId: folderAncestors.ancestorId,
        depth: folderAncestors.depth,
      })
      .from(folderAncestors)
      .where(inArray(folderAncestors.folderId, ids))
      .orderBy(asc(folderAncestors.folderId), asc(folderAncestors.depth)),
    db
      .select()
      .from(resourcePermissions)
      .where(
        and(
          eq(resourcePermissions.resourceType, 'folder'),
          inArray(resourcePermissions.resourceId, ids),
        ),
      )
      .orderBy(asc(resourcePermissions.grantedAt), asc(resourcePermissions.id)),
  ]);

  const chains = new Map<string, string[]>();
  for (const row of ancestorRows) {
    const chain = chains.get(row.folderId);
    if (chain) chain.push(row.ancestorId);
    else chains.set(row.folderId, [row.ancestorId]);
  }

  const acls = new Map<string, AclEntry[]>();
  for (const row of aclRows) {
    const entry: AclEntry = {
      principalType: row.principalType as AclEntry['principalType'],
      principalId: row.principalId,
      accessLevel: row.accessLevel,
      deny: Boolean(row.deny),
      expiresAt: toDate(row.expiresAt),
    };
    const list = acls.get(row.resourceId);
    if (list) list.push(entry);
    else acls.set(row.resourceId, [entry]);
  }

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    parentFolderId: row.parentFolderId ?? null,
    pathAncestors: chains.get(row.id) ?? [],
    depth: row.depth ?? 0,
    driveType: row.driveType as FolderRecord['driveType'],
    rootKey: row.rootKey ?? null,
    ownerId: row.ownerId,
    departmentId: row.departmentId ?? null,
    projectId: row.projectId ?? null,
    permissions: acls.get(row.id) ?? [],
    inheritPermissions: row.inheritPermissions !== false,
    confidentiality: row.confidentiality as ConfidentialityLevel,
    status: row.status ?? 'active',
    description: row.description ?? '',
    color: row.color ?? null,
    templateKey: row.templateKey ?? null,
    isSystem: Boolean(row.isSystem),
    childFolderCount: row.childFolderCount ?? 0,
    fileCount: row.fileCount ?? 0,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    deletedAt: toDate(row.deletedAt),
    trashedWithFolderId: row.trashedWithFolderId ?? null,
  }));
}

async function hydrateOne(db: Database, row: FolderRow | undefined): Promise<FolderRecord | null> {
  if (!row) return null;
  const [record] = await hydrate(db, [row]);
  return record ?? null;
}

/* ------------------------------------------------------------------ predicates */

const live = () => isNull(folders.deletedAt);

/** `LIKE` treats these as wildcards; a folder called "100%" must not match everything. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function prefixMatch(value: string): SQL {
  return sql`${folders.nameLower} LIKE ${`${escapeLike(value.toLowerCase())}%`} ESCAPE '\\'`;
}

function substringMatch(value: string): SQL {
  return sql`${folders.nameLower} LIKE ${`%${escapeLike(value.toLowerCase())}%`} ESCAPE '\\'`;
}

/**
 * Rows and `total` from one predicate.
 *
 * Both queries take the *same* `where`, by construction rather than by convention — passing the
 * predicate twice from the call site is how a count eventually stops matching its page.
 */
async function paged(
  db: Database,
  where: SQL,
  order: SQL[],
  page: number,
  pageSize: number,
): Promise<FolderPage> {
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(folders)
      .where(where)
      .orderBy(...order)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(folders).where(where),
  ]);

  return { items: await hydrate(db, rows), total: totals[0]?.value ?? 0 };
}

/** The stable sort every listing uses: the requested field, then `id` to break ties. */
function orderFor(sort: FolderSortField, order: 'asc' | 'desc'): SQL[] {
  const column =
    sort === 'name' ? folders.name : sort === 'createdAt' ? folders.createdAt : folders.updatedAt;
  const direction = order === 'desc' ? desc : asc;
  return [direction(column), asc(folders.id)];
}

/* ------------------------------------------------------------------ actor-facing reads */

export async function findById(
  actor: Actor,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FolderRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const conditions = [eq(folders.id, id), lookupVisibility('folder', actor)];
  if (!options.includeDeleted) conditions.push(live());

  const [row] = await db.select().from(folders).where(and(...conditions)).limit(1);
  return hydrateOne(db, row);
}

export async function findByIds(
  actor: Actor,
  ids: string[],
  options: { includeDeleted?: boolean } = {},
): Promise<FolderRecord[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();
  const conditions = [inArray(folders.id, unique), lookupVisibility('folder', actor)];
  if (!options.includeDeleted) conditions.push(live());

  const rows = await db.select().from(folders).where(and(...conditions));
  return hydrate(db, rows);
}

function childrenWhere(
  input: Omit<ListChildrenInput, 'page' | 'pageSize' | 'sort' | 'order'>,
): SQL {
  const conditions: SQL[] = [
    eq(folders.organizationId, input.actor.organizationId),
    eq(folders.parentFolderId, input.parentFolderId),
    live(),
    childVisibility('folder', input.actor),
  ];
  if (!input.includeArchived) conditions.push(ne(folders.status, 'archived'));
  if (input.searchPrefix) conditions.push(prefixMatch(input.searchPrefix));
  return and(...conditions)!;
}

export async function listChildrenOf(input: ListChildrenInput): Promise<FolderPage> {
  if (!input.parentFolderId) return { items: [], total: 0 };
  const db = await getD1();
  return paged(
    db,
    childrenWhere(input),
    orderFor(input.sort, input.order),
    input.page,
    input.pageSize,
  );
}

export async function countChildrenOf(
  input: Omit<ListChildrenInput, 'page' | 'pageSize' | 'sort' | 'order'>,
): Promise<number> {
  if (!input.parentFolderId) return 0;
  const db = await getD1();
  const [row] = await db.select({ value: count() }).from(folders).where(childrenWhere(input));
  return row?.value ?? 0;
}

/** Folders the actor deleted themselves — not the descendants swept in with them. */
export async function listTrashed(input: ListForActorInput): Promise<FolderPage> {
  const db = await getD1();
  const where = and(
    eq(folders.organizationId, input.actor.organizationId),
    isNotNull(folders.deletedAt),
    isNull(folders.trashedWithFolderId),
    childVisibility('folder', input.actor),
  )!;
  return paged(db, where, [desc(folders.updatedAt), asc(folders.id)], input.page, input.pageSize);
}

export async function listArchived(input: ListForActorInput): Promise<FolderPage> {
  const db = await getD1();
  const where = and(
    eq(folders.organizationId, input.actor.organizationId),
    eq(folders.status, 'archived'),
    // Only the folder the user archived — its descendants carry the status but no
    // `archived_at`, so they do not clutter the list.
    isNotNull(folders.archivedAt),
    live(),
    childVisibility('folder', input.actor),
  )!;
  return paged(db, where, [desc(folders.updatedAt), asc(folders.id)], input.page, input.pageSize);
}

/**
 * Folder search.
 *
 * Roots are excluded (`parent_folder_id IS NOT NULL`), exactly as in MongoDB: matching
 * "My Drive" or a department root adds nothing a user did not already have in the sidebar,
 * and they would otherwise dominate every result set.
 *
 * The predicate is `resourceVisibility`, not the broader `lookupVisibility` a single-row
 * lookup uses. A listing is allowed to be narrower than the permission layer, file search
 * already applies exactly this one, and the two halves of a search response showing different
 * amounts of the drive would be worse than either.
 */
export async function search(input: SearchFoldersInput): Promise<FolderPage> {
  const db = await getD1();
  const conditions: SQL[] = [
    eq(folders.organizationId, input.actor.organizationId),
    isNotNull(folders.parentFolderId),
    live(),
    resourceVisibility('folder', input.actor),
  ];

  if (input.text) conditions.push(substringMatch(input.text));
  if (input.departmentId) conditions.push(eq(folders.departmentId, input.departmentId));
  if (input.projectId) conditions.push(eq(folders.projectId, input.projectId));
  if (input.underFolderId) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${folderAncestors}
                   WHERE ${folderAncestors.folderId} = ${folders.id}
                     AND ${folderAncestors.ancestorId} = ${input.underFolderId})`,
    );
  }
  if (!input.includeArchived) conditions.push(ne(folders.status, 'archived'));

  return paged(
    db,
    and(...conditions)!,
    [asc(folders.nameLower), asc(folders.id)],
    input.page,
    input.pageSize,
  );
}

/**
 * Folders handed to this actor by an explicit grant.
 *
 * Deliberately not "everything you can see": a department head can see their whole department,
 * and listing all of it here would make the page useless. A live, non-deny entry naming one of
 * the actor's principals is the whole definition — so an expired share and a denial both drop
 * out, which is what tests 28 and 5 of the brief ask for.
 */
export async function listSharedWith(input: ListSharedWithInput): Promise<FolderPage> {
  const principals = [...new Set(input.principalIds.filter(Boolean))];
  if (principals.length === 0) return { items: [], total: 0 };

  const db = await getD1();
  const now = nowIso();
  const where = and(
    eq(folders.organizationId, input.actor.organizationId),
    ne(folders.ownerId, input.actor.userId),
    ne(folders.status, 'archived'),
    live(),
    sql`EXISTS (SELECT 1 FROM ${resourcePermissions}
                 WHERE ${resourcePermissions.resourceType} = 'folder'
                   AND ${resourcePermissions.resourceId} = ${folders.id}
                   AND ${inArray(resourcePermissions.principalId, principals)}
                   AND ${resourcePermissions.deny} = 0
                   AND (${resourcePermissions.expiresAt} IS NULL
                        OR ${resourcePermissions.expiresAt} > ${now}))`,
  )!;

  return paged(db, where, [desc(folders.updatedAt), asc(folders.id)], input.page, input.pageSize);
}

/* ------------------------------------------------------------------ structural reads */

export async function existsWithName(
  parentFolderId: string,
  nameLower: string,
  excludeId?: string,
): Promise<boolean> {
  if (!parentFolderId) return false;
  const db = await getD1();
  const conditions: SQL[] = [
    eq(folders.parentFolderId, parentFolderId),
    eq(folders.nameLower, nameLower),
    live(),
  ];
  if (excludeId) conditions.push(ne(folders.id, excludeId));

  const [row] = await db.select({ value: count() }).from(folders).where(and(...conditions));
  return (row?.value ?? 0) > 0;
}

export async function findChildByName(
  parentFolderId: string,
  nameLower: string,
): Promise<FolderRecord | null> {
  if (!parentFolderId) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(folders)
    .where(
      and(eq(folders.parentFolderId, parentFolderId), eq(folders.nameLower, nameLower), live()),
    )
    .limit(1);
  return hydrateOne(db, row);
}

export async function takenChildNames(parentFolderId: string): Promise<Set<string>> {
  if (!parentFolderId) return new Set();
  const db = await getD1();
  const rows = await db
    .select({ nameLower: folders.nameLower })
    .from(folders)
    .where(and(eq(folders.parentFolderId, parentFolderId), live()))
    .limit(TAKEN_NAMES_LIMIT);
  return new Set(rows.map((row) => row.nameLower));
}

export async function countDescendants(folderId: string): Promise<number> {
  if (!folderId) return 0;
  const db = await getD1();
  const [row] = await db
    .select({ value: count() })
    .from(folders)
    .innerJoin(folderAncestors, eq(folderAncestors.folderId, folders.id))
    .where(and(eq(folderAncestors.ancestorId, folderId), live()));
  return row?.value ?? 0;
}

/* ------------------------------------------------------------------ bypasses */

export async function findByIdInternal(
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FolderRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const conditions: SQL[] = [eq(folders.id, id)];
  if (!options.includeDeleted) conditions.push(live());
  const [row] = await db.select().from(folders).where(and(...conditions)).limit(1);
  return hydrateOne(db, row);
}

export async function findByIdsInternal(ids: string[]): Promise<FolderRecord[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();
  // Trashed rows included, matching Mongo's `withDeleted`: an ancestor in the trash still
  // carries the ACL entries a permission decision has to see.
  const rows = await db.select().from(folders).where(inArray(folders.id, unique));
  return hydrate(db, rows);
}

export async function findByDriveFolderIdInternal(
  googleDriveFolderId: string,
): Promise<FolderRecord | null> {
  if (!googleDriveFolderId) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(folders)
    .where(eq(folders.googleDriveFolderId, googleDriveFolderId))
    .limit(1);
  return hydrateOne(db, row);
}

export async function findByRootKeyInternal(rootKey: string): Promise<FolderRecord | null> {
  if (!rootKey) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.rootKey, rootKey), live()))
    .limit(1);
  return hydrateOne(db, row);
}

export async function findByRootKeysInternal(rootKeys: string[]): Promise<FolderRecord[]> {
  const unique = [...new Set(rootKeys.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();
  const rows = await db
    .select()
    .from(folders)
    .where(and(inArray(folders.rootKey, unique), live()));
  return hydrate(db, rows);
}

export async function listDescendantsInternal(
  folderId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FolderRecord[]> {
  if (!folderId) return [];
  const db = await getD1();
  const conditions: SQL[] = [eq(folderAncestors.ancestorId, folderId)];
  if (!options.includeDeleted) conditions.push(live());

  const rows = await db
    .select()
    .from(folders)
    .innerJoin(folderAncestors, eq(folderAncestors.folderId, folders.id))
    .where(and(...conditions))
    .orderBy(asc(folders.depth), asc(folders.name));

  return hydrate(
    db,
    rows.map((row) => row.folders),
  );
}

export async function findExpiredTrashInternal(
  before: Date,
  limit = 200,
): Promise<FolderRecord[]> {
  const db = await getD1();
  const rows = await db
    .select()
    .from(folders)
    .where(
      and(isNotNull(folders.deletedAt), sql`${folders.deletedAt} <= ${before.toISOString()}`),
    )
    .limit(limit);
  return hydrate(db, rows);
}

/* ------------------------------------------------------------------ writes */

function aclStatements(
  db: Database,
  organizationId: string,
  folderId: string,
  entries: AclEntryWrite[],
  now: string,
): BatchItem<'sqlite'>[] {
  // Replace the whole set: the sharing service computes the complete ACL and hands it over,
  // which is what `$set: { permissions }` did.
  const statements: BatchItem<'sqlite'>[] = [
    db
      .delete(resourcePermissions)
      .where(
        and(
          eq(resourcePermissions.resourceType, 'folder'),
          eq(resourcePermissions.resourceId, folderId),
        ),
      ),
  ];

  // One entry per principal, matching the unique index — a second grant to the same principal
  // replaced the first in the array model too.
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.principalType}:${entry.principalId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    statements.push(
      db.insert(resourcePermissions).values({
        id: crypto.randomUUID(),
        organizationId,
        resourceType: 'folder',
        resourceId: folderId,
        principalType: entry.principalType,
        principalId: entry.principalId,
        accessLevel: entry.accessLevel as typeof resourcePermissions.$inferInsert.accessLevel,
        deny: Boolean(entry.deny),
        expiresAt: entry.expiresAt ? entry.expiresAt.toISOString() : null,
        grantedBy: entry.grantedBy ?? null,
        grantedAt: now,
      }),
    );
  }

  return statements;
}

/**
 * Inserts the folder and its ancestor rows as one atomic list.
 *
 * A folder row whose ancestor rows did not land would be invisible to every subtree query and
 * every inheritance check — reachable by id, but outside the tree. That is worse than the
 * folder not existing, so the two land together or not at all.
 */
export async function create(input: CreateFolderInput): Promise<FolderRecord> {
  const db = await getD1();

  // The parent has to exist and has to be in the same tenant. Permission is the service's
  // business; *structure* is this layer's, and a folder hung off a parent in another
  // organization would be a tenancy breach that no permission check downstream would catch.
  const [parent] = await db
    .select({ organizationId: folders.organizationId })
    .from(folders)
    .where(and(eq(folders.id, input.parentFolderId), live()))
    .limit(1);
  if (!parent) throw new ConflictError('The parent folder no longer exists');
  if (parent.organizationId !== input.organizationId) {
    throw new ConflictError('A folder cannot be created in another organization');
  }

  const id = crypto.randomUUID();
  const now = nowIso();

  const statements: BatchItem<'sqlite'>[] = [
    db.insert(folders).values({
      id,
      organizationId: input.organizationId,
      name: input.name,
      nameLower: input.name.toLowerCase(),
      parentFolderId: input.parentFolderId,
      depth: input.depth,
      driveType: input.driveType,
      rootKey: null,
      ownerId: input.ownerId,
      departmentId: input.departmentId,
      projectId: input.projectId,
      inheritPermissions: true,
      confidentiality: input.confidentiality,
      status: 'active',
      description: input.description ?? '',
      color: input.color ?? null,
      templateKey: input.templateKey ?? null,
      isSystem: false,
      childFolderCount: 0,
      fileCount: 0,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }),
  ];

  // The complete chain, root → parent, `depth` reproducing the array index it came from.
  input.pathAncestors.forEach((ancestorId, index) => {
    statements.push(
      db.insert(folderAncestors).values({ folderId: id, ancestorId, depth: index }),
    );
  });

  await withBatch(db, statements);

  const created = await findByIdInternal(id);
  if (!created) throw new Error(`Folder ${id} disappeared immediately after insert`);
  return created;
}

/**
 * Race-safe root creation: two simultaneous first requests from the same user must not produce
 * two "My Drive" roots. The unique index on `root_key` decides the winner and the loser
 * re-reads — the same contract as the Mongo implementation, with `UNIQUE constraint failed`
 * standing in for error 11000.
 */
export async function ensureRoot(input: EnsureRootInput): Promise<FolderRecord> {
  const db = await getD1();
  const existing = await findByRootKeyInternal(input.rootKey);
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = nowIso();

  try {
    await db.insert(folders).values({
      id,
      organizationId: input.organizationId,
      name: input.name,
      nameLower: input.name.toLowerCase(),
      parentFolderId: null,
      depth: 0,
      driveType: input.driveType,
      rootKey: input.rootKey,
      ownerId: input.ownerId,
      departmentId: input.departmentId ?? null,
      projectId: input.projectId ?? null,
      inheritPermissions: true,
      confidentiality: input.confidentiality,
      status: 'active',
      description: '',
      isSystem: true,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    const raced = await findByRootKeyInternal(input.rootKey);
    if (raced) return raced;
    throw error;
  }

  const created = await findByIdInternal(id);
  if (!created) throw new Error(`Drive root ${input.rootKey} disappeared immediately after insert`);
  return created;
}

function toColumns(patch: FolderPatch, now: string): Partial<typeof folders.$inferInsert> {
  const columns: Partial<typeof folders.$inferInsert> = {};

  if (patch.name !== undefined) {
    columns.name = patch.name;
    // Never written separately: the two must not be able to disagree.
    columns.nameLower = patch.name.toLowerCase();
  }
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.color !== undefined) columns.color = patch.color;
  if (patch.confidentiality !== undefined) columns.confidentiality = patch.confidentiality;
  if (patch.inheritPermissions !== undefined) columns.inheritPermissions = patch.inheritPermissions;
  if (patch.syncStatus !== undefined) columns.syncStatus = patch.syncStatus;
  if (patch.updatedBy !== undefined) columns.updatedBy = patch.updatedBy;
  if (Object.keys(columns).length > 0) columns.updatedAt = now;

  return columns;
}

export async function updateById(id: string, patch: FolderPatch): Promise<FolderRecord | null> {
  if (!id) return null;
  const db = await getD1();

  // Live rows only, matching Mongoose's soft-delete hook: `findOneAndUpdate` on a trashed
  // folder finds nothing there, and a caller that gets `null` from one engine must get `null`
  // from the other.
  const [existing] = await db
    .select({ organizationId: folders.organizationId })
    .from(folders)
    .where(and(eq(folders.id, id), live()))
    .limit(1);
  if (!existing) return null;

  const now = nowIso();
  const columns = toColumns(patch, now);
  const statements: BatchItem<'sqlite'>[] = [];

  if (Object.keys(columns).length > 0) {
    statements.push(db.update(folders).set(columns).where(and(eq(folders.id, id), live())));
  }
  if (patch.fileCountDelta !== undefined) {
    statements.push(
      db
        .update(folders)
        .set({ fileCount: sql`${folders.fileCount} + ${patch.fileCountDelta}` })
        .where(and(eq(folders.id, id), live())),
    );
  }
  if (patch.permissions !== undefined) {
    statements.push(
      ...aclStatements(db, existing.organizationId, id, patch.permissions, now),
    );
  }

  // The ACL replacement and the row update land together: a folder whose entries were deleted
  // but not re-inserted is a folder that silently lost everybody's access.
  if (statements.length > 0) await withBatch(db, statements);
  return findByIdInternal(id);
}

export async function adjustChildFolderCount(folderId: string, delta: number): Promise<void> {
  if (!folderId || delta === 0) return;
  const db = await getD1();
  await db
    .update(folders)
    .set({ childFolderCount: sql`${folders.childFolderCount} + ${delta}` })
    .where(eq(folders.id, folderId));
}

/**
 * Re-parents a whole subtree atomically.
 *
 * ── The problem ─────────────────────────────────────────────────────────────────────────
 *
 * The statements need values only a prior read can supply — the folder's current depth, and
 * therefore the shift every descendant's ancestor rows need. D1 fixes a batch before it runs,
 * so those values are inevitably read *outside* the transaction that uses them, and a
 * concurrent move or rename in between would make them wrong. Applying half a shift to a
 * closure table does not fail loudly; it produces a tree that is quietly in the wrong shape.
 *
 * ── The shape that solves it ────────────────────────────────────────────────────────────
 *
 * Every statement carries the same guard — *"`folders.updated_at` for the moved folder is
 * still the value the plan was computed from"* — and the moved folder's own row is updated
 * **last**, so that guard holds for every earlier statement and is invalidated by the final
 * one. Either the state is untouched and all seven statements apply to exactly what was read,
 * or something moved first and every statement matches nothing. There is no partial outcome to
 * clean up.
 *
 * A no-op is then detected by re-reading, and the whole operation is retried against the new
 * state — which is what makes two concurrent moves, or a rename racing a move, resolve into
 * one winner and one retry rather than a corrupted subtree.
 *
 * ── The statements ──────────────────────────────────────────────────────────────────────
 *
 * Descendants are identified throughout by `folder_ancestors.ancestor_id = <moved folder>`,
 * a marker row that survives every step (its `depth` shifts; the row itself is never deleted),
 * so the set stays stable as the table is rewritten underneath it.
 */
/**
 * The structural refusals, restated here rather than trusted to the caller.
 *
 * `folder.service.ts` checks all of these before it gets this far, and it should — it can
 * produce a better message. But a circular move corrupts the closure table in a way that no
 * later read reports as an error, so the last layer that can still refuse does.
 *
 * Shared by `moveSubtree` and by the atomic folder+file unit of work, so a move composed with
 * files cannot skip a check a folder-only move applies.
 */
export async function assertMoveIsStructurallyLegal(
  db: Database,
  input: Pick<MoveSubtreeInput, 'folderId' | 'newParentId' | 'newPathAncestors'>,
): Promise<void> {
  if (input.newParentId === input.folderId || input.newPathAncestors.includes(input.folderId)) {
    throw new ConflictError('A folder cannot be moved into itself or one of its own subfolders');
  }

  const [target] = await db
    .select({ id: folders.id, organizationId: folders.organizationId })
    .from(folders)
    .where(and(eq(folders.id, input.newParentId), live()))
    .limit(1);
  if (!target) throw new ConflictError('The destination folder no longer exists');

  const [source] = await db
    .select({ organizationId: folders.organizationId })
    .from(folders)
    .where(eq(folders.id, input.folderId))
    .limit(1);
  if (!source) throw new ConflictError('The folder being moved no longer exists');
  if (source.organizationId !== target.organizationId) {
    throw new ConflictError('A folder cannot be moved into another organization');
  }
}

/**
 * Everything the move statements need that only a read can supply.
 *
 * Computed once, before any statement is built, and carried through unchanged — `stamp` is
 * what every statement is guarded on, so a plan and the statements built from it describe one
 * consistent moment.
 */
export interface FolderMovePlan {
  oldDepth: number;
  newDepth: number;
  shift: number;
  /** `folders.updated_at` for the moved folder at planning time. The concurrency token. */
  stamp: string;
  now: string;
}

export async function planFolderMove(
  db: Database,
  folderId: string,
  newPathAncestors: string[],
): Promise<FolderMovePlan> {
  const [current] = await db
    .select({ depth: folders.depth, updatedAt: folders.updatedAt })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1);
  if (!current) throw new ConflictError('The folder being moved no longer exists');

  const newDepth = newPathAncestors.length;
  return {
    oldDepth: current.depth,
    newDepth,
    shift: newDepth - current.depth,
    stamp: current.updatedAt,
    now: nowIso(),
  };
}

/**
 * "Nothing has touched the moved folder since the plan was computed."
 *
 * Exported because the *file* half of an atomic move must carry the identical guard — a file
 * statement that applied while the folder statements did not would be precisely the split this
 * design exists to prevent.
 */
export function moveGuard(folderId: string, stamp: string): SQL {
  return sql`(SELECT f.updated_at FROM ${folders} f WHERE f.id = ${folderId}) = ${stamp}`;
}

/**
 * The statements that move a folder subtree — built, not executed.
 *
 * ── The concurrency shape ───────────────────────────────────────────────────────────────
 *
 * The statements need values only a prior read can supply — the folder's current depth, and
 * therefore the shift every descendant's ancestor rows need. D1 fixes a batch before it runs,
 * so those values are inevitably read *outside* the transaction that uses them, and a
 * concurrent move or rename in between would make them wrong. Applying half a shift to a
 * closure table does not fail loudly; it produces a tree that is quietly in the wrong shape.
 *
 * So every statement carries the same guard, and the moved folder's own row is updated
 * **last** — the caller must keep it last — so the guard holds for every earlier statement and
 * is invalidated by the final one. Either the state is untouched and every statement applies to
 * exactly what was read, or something moved first and every statement matches nothing. There is
 * no partial outcome to clean up.
 *
 * ── The statements ──────────────────────────────────────────────────────────────────────
 *
 * Descendants are identified throughout by `folder_ancestors.ancestor_id = <moved folder>`, a
 * marker row that survives every step (its `depth` shifts; the row itself is never deleted), so
 * the set stays stable as the table is rewritten underneath it.
 *
 * Count is `6 + 2 × newDepth` — **independent of how large the subtree is**, because every
 * statement is set-wise. `MAX_FOLDER_DEPTH` therefore bounds this half at 70 statements.
 */
export function buildFolderMoveStatements(
  db: Database,
  input: MoveSubtreeInput,
  plan: FolderMovePlan,
): BatchItem<'sqlite'>[] {
  // `newDepth` belongs to the commit statement, not to these — it is applied to the moved
  // folder's own row by `buildFolderMoveCommitStatement`.
  const { oldDepth, shift, stamp, now } = plan;
  const unchanged = moveGuard(input.folderId, stamp);
  const descendants = sql`(SELECT a.folder_id FROM ${folderAncestors} a WHERE a.ancestor_id = ${input.folderId})`;

  const statements: BatchItem<'sqlite'>[] = [
    // 1. The descendants' own rows: everything that follows the moved folder rather than
    //    describing it. `owner_id` deliberately stays put, matching the Mongo pipeline.
    db
      .update(folders)
      .set({
        depth: sql`${folders.depth} + ${shift}`,
        driveType: input.driveType,
        departmentId: input.departmentId,
        projectId: input.projectId,
        updatedAt: now,
      })
      .where(and(sql`${folders.id} IN ${descendants}`, unchanged)),

    // 2. The moved folder's *old* ancestors drop out of every descendant's chain. Rows at
    //    `depth >= oldDepth` are the moved folder itself and what lies between, and they stay
    //    — which is also what keeps the `descendants` sub-select above stable as this runs.
    db
      .delete(folderAncestors)
      .where(
        and(
          sql`${folderAncestors.folderId} IN ${descendants}`,
          lt(folderAncestors.depth, oldDepth),
          unchanged,
        ),
      ),

    // 3. What remains keeps its relative order, shifted to the new depth.
    db
      .update(folderAncestors)
      .set({ depth: sql`${folderAncestors.depth} + ${shift}` })
      .where(and(sql`${folderAncestors.folderId} IN ${descendants}`, unchanged)),
  ];

  // 4. The destination's chain is prepended to every descendant. One statement per new
  //    ancestor, each inserting exactly one row per descendant.
  input.newPathAncestors.forEach((ancestorId, index) => {
    statements.push(
      db
        .insert(folderAncestors)
        .select(
          sql`select a.folder_id, ${ancestorId}, ${index}
                from ${folderAncestors} a
               where a.ancestor_id = ${input.folderId} and ${unchanged}`,
        ),
    );
  });

  // 5–6. The moved folder's own chain is replaced outright — it is short and known.
  statements.push(
    db.delete(folderAncestors).where(and(eq(folderAncestors.folderId, input.folderId), unchanged)),
  );
  input.newPathAncestors.forEach((ancestorId, index) => {
    statements.push(
      db
        .insert(folderAncestors)
        .select(sql`select ${input.folderId}, ${ancestorId}, ${index} where ${unchanged}`),
    );
  });

  return statements;
}

/**
 * The moved folder's own row — the statement that invalidates the guard.
 *
 * Separate from `buildFolderMoveStatements` so a composed batch can put the file statements
 * *before* it. Everything guarded must run while the stamp still matches; this is what stops
 * matching.
 */
export function buildFolderMoveCommitStatement(
  db: Database,
  input: MoveSubtreeInput,
  plan: FolderMovePlan,
): BatchItem<'sqlite'> {
  return db
    .update(folders)
    .set({
      parentFolderId: input.newParentId,
      depth: plan.newDepth,
      driveType: input.driveType,
      departmentId: input.departmentId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      updatedBy: input.updatedBy,
      updatedAt: plan.now,
    })
    .where(and(eq(folders.id, input.folderId), eq(folders.updatedAt, plan.stamp)));
}

/** The child-count adjustments, as statements, so they join the move's batch. */
export function buildChildFolderCountStatement(
  db: Database,
  folderId: string,
  delta: number,
): BatchItem<'sqlite'> {
  return db
    .update(folders)
    .set({ childFolderCount: sql`${folders.childFolderCount} + ${delta}` })
    .where(eq(folders.id, folderId));
}

/** Did the move actually apply? A no-op means the guard failed and the caller should retry. */
export async function moveDidApply(
  db: Database,
  input: MoveSubtreeInput,
  plan: FolderMovePlan,
): Promise<boolean> {
  const [after] = await db
    .select({ parentFolderId: folders.parentFolderId, depth: folders.depth })
    .from(folders)
    .where(eq(folders.id, input.folderId))
    .limit(1);
  return after?.parentFolderId === input.newParentId && after.depth === plan.newDepth;
}

export const MOVE_CONTENTION_MESSAGE =
  'This folder could not be moved because it kept changing underneath the move. ' +
  'This usually means two people moved or renamed it at the same time.';

/**
 * Re-parents a whole subtree atomically — folders only.
 *
 * Still the right entry point when nothing else has to move with the folders. A move that must
 * also carry the *files* inside the subtree goes through `d1-unit-of-work.ts` instead, which
 * composes these same builders with the file repository's into one batch; the logic is not
 * duplicated there.
 *
 * A no-op is detected by re-reading and the whole operation retried against the new state,
 * which is what makes two concurrent moves resolve into one winner and one retry rather than a
 * corrupted subtree.
 */
export async function moveSubtree(input: MoveSubtreeInput): Promise<void> {
  const db = await getD1();
  await assertMoveIsStructurallyLegal(db, input);

  for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) {
    const plan = await planFolderMove(db, input.folderId, input.newPathAncestors);

    await withBatch(db, [
      ...buildFolderMoveStatements(db, input, plan),
      buildFolderMoveCommitStatement(db, input, plan),
    ]);

    if (await moveDidApply(db, input, plan)) return;
  }

  throw new ConflictError(MOVE_CONTENTION_MESSAGE);
}

/**
 * Trashes or restores a folder together with its subtree.
 *
 * `trashed_with_folder_id` records which deletion swept a descendant in, so restoring the
 * parent restores exactly that set — and not folders the user had trashed individually
 * beforehand, which must stay in the trash. Behaviour, including the returned count, is
 * matched to the Mongo implementation statement for statement.
 */
export async function setSubtreeDeleted(input: {
  folderId: string;
  deleted: boolean;
  userId: string;
}): Promise<number> {
  const db = await getD1();
  const now = nowIso();
  const descendants = sql`(SELECT a.folder_id FROM ${folderAncestors} a WHERE a.ancestor_id = ${input.folderId})`;

  if (input.deleted) {
    const [, swept] = await withBatch(db, [
      db
        .update(folders)
        .set({
          deletedAt: now,
          deletedBy: input.userId,
          status: 'trashed',
          trashedWithFolderId: null,
          updatedAt: now,
        })
        .where(and(eq(folders.id, input.folderId), isNull(folders.deletedAt))),
      db
        .update(folders)
        .set({
          deletedAt: now,
          deletedBy: input.userId,
          status: 'trashed',
          trashedWithFolderId: input.folderId,
          updatedAt: now,
        })
        .where(and(sql`${folders.id} IN ${descendants}`, isNull(folders.deletedAt)))
        .returning({ id: folders.id }),
    ]);

    return (swept as { id: string }[]).length + 1;
  }

  const [, restored] = await withBatch(db, [
    db
      .update(folders)
      .set({
        deletedAt: null,
        deletedBy: null,
        status: 'active',
        trashedWithFolderId: null,
        updatedAt: now,
      })
      .where(and(eq(folders.id, input.folderId), isNotNull(folders.deletedAt))),
    db
      .update(folders)
      .set({
        deletedAt: null,
        deletedBy: null,
        status: 'active',
        trashedWithFolderId: null,
        updatedAt: now,
      })
      .where(
        and(
          sql`${folders.id} IN ${descendants}`,
          eq(folders.trashedWithFolderId, input.folderId),
          isNotNull(folders.deletedAt),
        ),
      )
      .returning({ id: folders.id }),
  ]);

  return (restored as { id: string }[]).length + 1;
}

export async function setSubtreeStatus(input: {
  folderId: string;
  status: 'active' | 'archived';
  userId: string;
}): Promise<number> {
  const db = await getD1();
  const now = nowIso();
  const archivedAt = input.status === 'archived' ? now : null;
  const descendants = sql`(SELECT a.folder_id FROM ${folderAncestors} a WHERE a.ancestor_id = ${input.folderId})`;

  const [, changed] = await withBatch(db, [
    db
      .update(folders)
      .set({ status: input.status, archivedAt, updatedBy: input.userId, updatedAt: now })
      .where(eq(folders.id, input.folderId)),
    // Descendants change status but keep `archived_at` null. That is what marks the one folder
    // the user actually archived, so the Archive view lists it and not its whole subtree.
    db
      .update(folders)
      .set({ status: input.status, updatedAt: now })
      .where(sql`${folders.id} IN ${descendants}`)
      .returning({ id: folders.id }),
  ]);

  return (changed as { id: string }[]).length + 1;
}

/** Hard delete, used only by the trash-retention purge job and by tests. */
export async function purge(folderIds: string[]): Promise<number> {
  const unique = [...new Set(folderIds.filter(Boolean))];
  if (unique.length === 0) return 0;
  const db = await getD1();

  // The closure rows go first, in both directions: `ON DELETE CASCADE` covers the rows that
  // point *at* a purged folder, but a purge that leaves a dangling ancestor row would leave
  // the surviving folder with a chain that no longer resolves.
  //
  // `trashed_with_folder_id` is then cleared on anything that survives, because the tag only
  // means "restoring *that* folder brings me back" and that folder is about to stop existing.
  // `parent_folder_id` is deliberately **not** cleared: a surviving child of a purged parent is
  // a corrupt tree, and the foreign key refusing the delete is a better outcome than silently
  // promoting the child to a drive root. MongoDB, having no foreign keys, left the dangling
  // pointer instead — which `checkHierarchyIntegrity` is what finds.
  const [, , deleted] = await withBatch(db, [
    db
      .delete(folderAncestors)
      .where(
        or(
          inArray(folderAncestors.folderId, unique),
          inArray(folderAncestors.ancestorId, unique),
        ),
      ),
    db
      .update(folders)
      .set({ trashedWithFolderId: null })
      .where(inArray(folders.trashedWithFolderId, unique)),
    db.delete(folders).where(inArray(folders.id, unique)).returning({ id: folders.id }),
  ]);

  return (deleted as { id: string }[]).length;
}

/* ------------------------------------------------------------------ integrity */

/**
 * Everything wrong with the stored hierarchy, or an empty list.
 *
 * The parent pointer and the closure table are two representations of one truth. A bug in a
 * subtree mutation shows up here as a disagreement between them — long before a user notices a
 * folder in the wrong place, and in a form a test can assert on.
 */
export async function checkHierarchyIntegrity(
  organizationId: string,
): Promise<HierarchyProblem[]> {
  const db = await getD1();
  const problems: HierarchyProblem[] = [];

  const rows = await db
    .select({
      id: folders.id,
      parentFolderId: folders.parentFolderId,
      depth: folders.depth,
    })
    .from(folders)
    .where(eq(folders.organizationId, organizationId));

  const chains = new Map<string, Array<{ ancestorId: string; depth: number }>>();
  const ancestorRows = await db
    .select({
      folderId: folderAncestors.folderId,
      ancestorId: folderAncestors.ancestorId,
      depth: folderAncestors.depth,
    })
    .from(folderAncestors)
    .innerJoin(folders, eq(folders.id, folderAncestors.folderId))
    .where(eq(folders.organizationId, organizationId))
    .orderBy(asc(folderAncestors.folderId), asc(folderAncestors.depth));

  for (const row of ancestorRows) {
    const chain = chains.get(row.folderId);
    if (chain) chain.push({ ancestorId: row.ancestorId, depth: row.depth });
    else chains.set(row.folderId, [{ ancestorId: row.ancestorId, depth: row.depth }]);
  }

  const organizationOf = new Map<string, string>();
  const foreign = await db
    .select({ id: folders.id, organizationId: folders.organizationId })
    .from(folders);
  for (const row of foreign) organizationOf.set(row.id, row.organizationId);

  for (const row of rows) {
    const chain = chains.get(row.id) ?? [];

    if (chain.some((link) => link.ancestorId === row.id)) {
      problems.push({ kind: 'cycle', folderId: row.id, detail: 'the folder is its own ancestor' });
      continue;
    }
    if (chain.length !== row.depth) {
      problems.push({
        kind: chain.length < row.depth ? 'missing_ancestor_rows' : 'wrong_depth',
        folderId: row.id,
        detail: `depth ${row.depth} but ${chain.length} ancestor rows`,
      });
    }
    // `depth` on a closure row is the ancestor's own depth, so the chain must read 0, 1, 2…
    chain.forEach((link, index) => {
      if (link.depth !== index) {
        problems.push({
          kind: 'wrong_depth',
          folderId: row.id,
          detail: `ancestor ${link.ancestorId} sits at depth ${link.depth}, expected ${index}`,
        });
      }
      const ancestorOrganization = organizationOf.get(link.ancestorId);
      if (ancestorOrganization !== undefined && ancestorOrganization !== organizationId) {
        problems.push({
          kind: 'cross_organization_ancestor',
          folderId: row.id,
          detail: `ancestor ${link.ancestorId} belongs to another organization`,
        });
      }
      if (ancestorOrganization === undefined) {
        problems.push({
          kind: 'missing_ancestor_rows',
          folderId: row.id,
          detail: `ancestor ${link.ancestorId} does not exist`,
        });
      }
    });

    const last = chain.at(-1)?.ancestorId ?? null;
    if (row.parentFolderId !== last) {
      problems.push({
        kind: 'parent_not_in_ancestors',
        folderId: row.id,
        detail: `parent ${row.parentFolderId ?? 'none'} but deepest ancestor ${last ?? 'none'}`,
      });
    }
  }

  return problems;
}

export const d1FolderRepository: FolderRepository = {
  findById,
  findByIds,
  listChildrenOf,
  countChildrenOf,
  listTrashed,
  listArchived,
  search,
  listSharedWith,
  existsWithName,
  findChildByName,
  takenChildNames,
  countDescendants,
  findByIdInternal,
  findByIdsInternal,
  findByDriveFolderIdInternal,
  findByRootKeyInternal,
  findByRootKeysInternal,
  listDescendantsInternal,
  findExpiredTrashInternal,
  create,
  ensureRoot,
  updateById,
  adjustChildFolderCount,
  moveSubtree,
  setSubtreeDeleted,
  setSubtreeStatus,
  purge,
  checkHierarchyIntegrity,
};
