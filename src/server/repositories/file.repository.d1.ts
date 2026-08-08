/**
 * The D1 file repository.
 *
 * The MongoDB file document is one object; in D1 it is five tables. What this file mostly is,
 * is the reassembly — and the guarantee that the five never disagree.
 *
 *   `files`                  the base row
 *   `file_folder_ancestors`  the ordered folder chain (`folderPathAncestors[]`)
 *   `file_metadata`          the research metadata sub-document, one row per key
 *   `resource_tags`          the tag array
 *   `resource_permissions`   the ACL array
 *
 * ── 1. Permission is enforced in SQL, never after the fetch ─────────────────────────────
 *
 * Every actor-facing read applies its predicate **inside** the query — to the rows and to the
 * `COUNT(*)` that produces `total`, built once and used twice, so the two cannot drift. A file
 * the actor may not see cannot be inferred from a page that is one item short, from an inflated
 * total, or from a facet count. Nothing is filtered in JavaScript afterwards.
 *
 * The predicates come from `visibility.d1.ts`, which already handles `kind: 'file'` including
 * the `file_folder_ancestors` join for inherited grants and inheritance boundaries. They are
 * not reimplemented here.
 *
 * Which read uses which predicate is the same mapping the Mongo implementation documents, so
 * the flag cannot change who sees what:
 *
 *   findById / findByIds        `lookupVisibility`   — see §2
 *   listInFolder / listTrashed  `childVisibility`    — children of an already-authorised folder
 *   search / searchFacets       `resourceVisibility`
 *   findRelated                 `resourceVisibility`
 *   projectContentBreakdown     `resourceVisibility`
 *   listSharedWith              principals only — an explicit grant *is* the definition
 *
 * ── 2. `findById` is stricter here than on MongoDB, and that is the point ───────────────
 *
 * The Mongo lookup applies `lookupGuardFilter`: organization isolation and the live deny guard,
 * and nothing more. It is deliberately weak because a file's access is usually *inherited* from
 * its folder, and MongoDB cannot check an ancestor's ACL inside a `find` filter — a narrower
 * predicate there would 404 the ordinary case of "somebody shared a folder and I opened a file
 * in it".
 *
 * D1 has no such limitation. `file_folder_ancestors` turns "does an in-scope ancestor grant this
 * actor?" into a correlated sub-query, so `lookupVisibility('file', actor)` — a documented
 * superset of `canAccess`'s allow set — applies in full. A guessed id cannot load a row the
 * actor has no route to at all, rather than merely no route past the two guards.
 *
 * `assertCan` still runs afterwards and still makes the real decision. This is the half that
 * stops the row being read.
 *
 * ── 3. Soft delete: one deliberate divergence from MongoDB ──────────────────────────────
 *
 * `applySoftDeleteFilter` hooks `find`, `findOne`, `findOneAndUpdate`, `countDocuments`,
 * `updateMany` and `updateOne` — but **not** `aggregate`. So on MongoDB `searchFacets` and four
 * of the five `projectContentBreakdown` figures count trashed files, while the fifth
 * (`linkedToExperiment`, a `countDocuments`) does not. The dashboard is internally inconsistent
 * with itself.
 *
 * This implementation excludes soft-deleted rows everywhere, consistently. Reproducing the
 * inconsistency would mean carrying a known reporting bug into the new engine and then
 * defending it in the Phase 6 comparison — the same reasoning that reversed the plan to
 * reproduce the ACL leak in module 4. The Mongo side needs the same fix; it is recorded in
 * §11 of the module document rather than made here, because changing it would alter a live
 * dashboard in a session whose remit is the D1 implementation.
 *
 * ── 4. There is no interactive transaction ──────────────────────────────────────────────
 *
 * `FileTx` is a Mongoose `ClientSession` and is **not honoured** here — it cannot be. What
 * replaces it is that every multi-table mutation is a single `db.batch()`: all statements
 * commit or none do. A file whose ancestor rows did not land would be invisible to every
 * subtree query and every inheritance check, so the base row and its chain land together.
 *
 * What one batch cannot span is two *repositories* — and a folder move, trash, restore or
 * archive has to change both. Those operations therefore do not run from here: the mutation
 * logic is exposed as statement *builders* (`buildFileReparentStatements`,
 * `buildFileSubtreeDeletedStatements`, `buildFileSubtreeStatusStatements`) which
 * `d1-unit-of-work.ts` composes with the folder half into a single batch. The self-executing
 * methods beside them remain for the standalone callers and share the same builders.
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
  lte,
  ne,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { withBatch, type Database } from '@/server/db/d1';
import { getD1 } from '@/server/db/d1-context';
import {
  fileFolderAncestors,
  fileMetadata,
  fileVersions,
  files,
  folderAncestors,
  folders,
  resourceTags,
} from '@/server/db/schema/drive';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { resourcePermissions } from '@/server/db/schema/access';
import { ConflictError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';
import type { AclEntry, Actor } from '@/server/permissions/actor';
import {
  childVisibility,
  lookupVisibility,
  resourceVisibility,
} from '@/server/permissions/visibility.d1';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { FileCategory } from '@/server/domain/file-types';
import { AmbiguousDriveFileError } from './file.repository.contract';
import type {
  AclEntryWrite,
  CreateFileInput,
  FileGuard,
  FileHierarchyProblem,
  FilePage,
  FilePatch,
  FileRecord,
  FileRepository,
  FileSortField,
  FindRelatedInput,
  ListForActorInput,
  ListInFolderInput,
  ListSharedWithInput,
  ProjectContentBreakdown,
  ReparentSubtreeInput,
  SearchFacets,
  SearchFilesInput,
} from './file.repository.contract';

type FileRow = typeof files.$inferSelect;

/**
 * One folder in a moved subtree, and the ancestor chain its files will have afterwards.
 *
 * The unit of exchange between planning and statement building: whoever knows the new shape of
 * the folder tree produces these, and the file statements are built from them without going
 * back to the database. That is what lets the atomic move plan the file half *before* the
 * folder half has been executed.
 */
export interface FolderChain {
  folderId: string;
  /** Ordered root → the folder itself, which is always the last element. */
  chain: string[];
}

/** Mongo's implicit cap on `takenNamesInFolder`. Reproduced rather than removed. */
const TAKEN_NAMES_LIMIT = 5000;

function nowIso(): string {
  return new Date().toISOString();
}

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/* ------------------------------------------------------------------ hydration */

/**
 * Rows → records: the base rows plus the four side tables, in four queries for the whole page
 * rather than four per row.
 *
 * A drive listing is the first screen every employee sees, so an N+1 here is an N+1 on the hot
 * path. `IN (...)` over the page's ids is bounded by `pageSize`, which the schemas cap.
 *
 * Every default matches `toRecord` in the Mongo implementation field for field — an absent
 * metadata row is `{}` and not `null`, an absent tag set is `[]` and not `null` — because the
 * API response shape must not change with the flag.
 */
async function hydrate(db: Database, rows: FileRow[]): Promise<FileRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [ancestorRows, aclRows, metadataRows, tagRows] = await Promise.all([
    db
      .select({
        fileId: fileFolderAncestors.fileId,
        ancestorId: fileFolderAncestors.ancestorId,
        depth: fileFolderAncestors.depth,
      })
      .from(fileFolderAncestors)
      .where(inArray(fileFolderAncestors.fileId, ids))
      .orderBy(asc(fileFolderAncestors.fileId), asc(fileFolderAncestors.depth)),
    db
      .select()
      .from(resourcePermissions)
      .where(
        and(
          eq(resourcePermissions.resourceType, 'file'),
          inArray(resourcePermissions.resourceId, ids),
        ),
      )
      .orderBy(asc(resourcePermissions.grantedAt), asc(resourcePermissions.id)),
    db
      .select()
      .from(fileMetadata)
      .where(inArray(fileMetadata.fileId, ids))
      .orderBy(asc(fileMetadata.fileId), asc(fileMetadata.key)),
    db
      .select()
      .from(resourceTags)
      .where(
        and(eq(resourceTags.resourceType, 'file'), inArray(resourceTags.resourceId, ids)),
      )
      .orderBy(asc(resourceTags.resourceId), asc(resourceTags.tag)),
  ]);

  const chains = new Map<string, string[]>();
  for (const row of ancestorRows) {
    const chain = chains.get(row.fileId);
    if (chain) chain.push(row.ancestorId);
    else chains.set(row.fileId, [row.ancestorId]);
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

  const metadata = new Map<string, Record<string, unknown>>();
  for (const row of metadataRows) {
    const bag = metadata.get(row.fileId);
    if (bag) bag[row.key] = row.value;
    else metadata.set(row.fileId, { [row.key]: row.value });
  }

  const tags = new Map<string, string[]>();
  for (const row of tagRows) {
    const list = tags.get(row.resourceId);
    if (list) list.push(row.tag);
    else tags.set(row.resourceId, [row.tag]);
  }

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    displayName: row.displayName,
    originalFilename: row.originalFilename,
    extension: row.extension,
    category: row.category as FileCategory,
    folderId: row.folderId,
    folderPathAncestors: chains.get(row.id) ?? [],
    driveType: row.driveType as FileRecord['driveType'],
    ownerId: row.ownerId,
    departmentId: row.departmentId ?? null,
    projectId: row.projectId ?? null,
    experimentId: row.experimentId ?? null,
    currentVersionId: row.currentVersionId ?? null,
    approvedVersionId: row.approvedVersionId ?? null,
    versionCount: row.versionCount ?? 0,
    sizeBytes: row.sizeBytes ?? 0,
    mimeType: row.mimeType ?? 'application/octet-stream',
    checksumSha256: row.checksumSha256 ?? null,
    tags: tags.get(row.id) ?? [],
    metadata: metadata.get(row.id) ?? {},
    confidentiality: row.confidentiality as ConfidentialityLevel,
    reviewStatus: row.reviewStatus ?? 'draft',
    approvalStatus: row.approvalStatus ?? 'none',
    status: row.status ?? 'active',
    permissions: acls.get(row.id) ?? [],
    inheritPermissions: row.inheritPermissions !== false,
    downloadCount: row.downloadCount ?? 0,
    hasGoogleNativeContent: row.hasGoogleNativeContent === true,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    deletedAt: toDate(row.deletedAt),
    trashedWithFolderId: row.trashedWithFolderId ?? null,
  }));
}

async function hydrateOne(db: Database, row: FileRow | undefined): Promise<FileRecord | null> {
  if (!row) return null;
  const [record] = await hydrate(db, [row]);
  return record ?? null;
}

/* ------------------------------------------------------------------ full-text index */

/**
 * `files_fts`, declared so its rows can be written through the query builder.
 *
 * Deliberately **not** exported into `schema/index.ts`: it is a virtual FTS5 table created by
 * migration 0001, and putting it in the schema object would have drizzle-kit try to emit a
 * `CREATE TABLE files_fts` of its own on the next generate. Drizzle does not require a table to
 * be in the schema object to query it.
 *
 * A local declaration rather than raw SQL because **a batch cannot carry parameterised raw
 * SQL**. `SQLiteD1Session.batch` reads `preparedQuery.stmt` for any query with bound
 * parameters, and `db.run(sql\`...\`)` does not set it — the batch dies with "cannot read
 * properties of undefined". Statements built through the query builder do set it. That rules
 * out the `INSERT ... SELECT` form below, which is why the content is computed in JavaScript
 * and bound as values.
 */
const filesFts = sqliteTable('files_fts', {
  fileId: text('file_id'),
  displayName: text('display_name'),
  originalFilename: text('original_filename'),
  keywords: text('keywords'),
  description: text('description'),
});

/** The searchable projection of a file, in the column layout `files_fts` declares. */
interface FtsContent {
  displayName: string;
  originalFilename: string;
  keywords: string;
  description: string;
}

/**
 * Builds the indexed text exactly as `trg_files_fts_update` does.
 *
 * The two must agree: the trigger still fires on every `files` UPDATE, so a file whose row was
 * rebuilt by the trigger and a file whose row was rebuilt here have to end up with the same
 * text, or search results would depend on which path last touched the record. If that trigger's
 * definition changes, this must change with it.
 */
function ftsContentOf(
  displayName: string,
  originalFilename: string,
  tags: string[],
  metadata: Record<string, unknown>,
): FtsContent {
  const keywordMetadata = ['sampleId', 'experimentCode']
    .map((key) => metadata[key])
    .filter((value) => value !== undefined && value !== null)
    .map(String);

  return {
    displayName,
    originalFilename,
    // `tags || ' ' || metadata` — the trigger's own concatenation, including the separator it
    // emits even when one side is empty.
    keywords: `${tags.join(' ')} ${keywordMetadata.join(' ')}`,
    description: metadata.description === undefined ? '' : String(metadata.description),
  };
}

/**
 * Rewrites one file's `files_fts` row.
 *
 * ── The correctness problem this fixes ──────────────────────────────────────────────────
 *
 * The Phase 2 triggers fire on `files` only. `trg_files_fts_update` re-reads tags and metadata
 * when it runs, which is correct as far as it goes — but a write that touches *only*
 * `file_metadata` or *only* `resource_tags` fires no trigger at all. Editing a sample id or
 * adding a tag therefore left the index holding the previous value: a search for the new one
 * returned nothing, while a search for the old one still matched. Nothing in the schema fixes
 * this — a trigger on `file_metadata` would have to be trusted by every path that writes it,
 * which is the same trust the trigger was supposed to remove.
 *
 * So every mutation here that can change searchable content appends these statements to its own
 * batch. They commit with the write that made them necessary, so the index cannot be left stale
 * by a later failure — there is no later.
 *
 * DELETE-then-INSERT rather than UPDATE: `files_fts` is a standalone FTS5 table with no unique
 * constraint on `file_id`, so an INSERT alone would accumulate a row per write and every search
 * would return the file once per stale copy. The pair is idempotent, which also makes it safe
 * to append after a statement whose trigger already rebuilt the row.
 *
 * `content: null` deletes without reinserting, reproducing the trigger's `WHERE deleted_at IS
 * NULL` guard: an index that cannot produce a trashed file is a stronger guarantee than a
 * `WHERE` clause every search has to remember.
 */
function refreshFileFts(
  db: Database,
  fileId: string,
  content: FtsContent | null,
): BatchItem<'sqlite'>[] {
  const statements: BatchItem<'sqlite'>[] = [
    db.delete(filesFts).where(eq(filesFts.fileId, fileId)),
  ];
  if (content) statements.push(db.insert(filesFts).values({ fileId, ...content }));
  return statements;
}

/**
 * User text → an FTS5 MATCH expression that cannot be a syntax error.
 *
 * Every token is wrapped in double quotes, which makes it a literal string to FTS5 rather than
 * an operator: a user searching for `NEAR` or `sample-1 OR *` gets those characters looked up
 * instead of a parse failure or an accidental operator. Embedded quotes are doubled, which is
 * FTS5's own escape.
 *
 * Tokens are joined with `OR` to match MongoDB `$text`, which treats a bare multi-word search
 * as any-term and ranks by score. Switching to `AND` would silently narrow every existing
 * search.
 */
function ftsQuery(text: string): string | null {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/"/g, '""').trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

/**
 * The bm25 weighting, with the leading placeholder for the UNINDEXED `file_id` column.
 *
 * The placeholder is not optional: `bm25()` takes one weight per column *including* the
 * unindexed one, and omitting it shifts every weight by one — assigning 10.0 to a column that
 * can never match and leaving `description` on the default. Phase 3 module 3 found and
 * corrected exactly this mistake in the migration comments; `0001_fts_triggers_and_seed.sql`
 * records it.
 */
const BM25 = sql`bm25(files_fts, 0.0, 10.0, 6.0, 5.0, 1.0)`;

/* ------------------------------------------------------------------ predicates */

const live = () => isNull(files.deletedAt);

/** `LIKE` treats these as wildcards; a file called "100%" must not match everything. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function prefixMatch(value: string): SQL {
  return sql`${files.displayNameLower} LIKE ${`${escapeLike(value.toLowerCase())}%`} ESCAPE '\\'`;
}

/** "This file is the folder, or somewhere beneath it." */
function underFolder(folderId: string): SQL {
  return or(
    eq(files.folderId, folderId),
    sql`EXISTS (SELECT 1 FROM ${fileFolderAncestors} anc
                 WHERE anc.file_id = ${files.id} AND anc.ancestor_id = ${folderId})`,
  )!;
}

function hasMetadata(key: string, value: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${fileMetadata} md
                      WHERE md.file_id = ${files.id} AND md.key = ${key} AND md.value = ${value})`;
}

function hasTag(tag: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${resourceTags} rt
                      WHERE rt.resource_type = 'file' AND rt.resource_id = ${files.id}
                        AND rt.tag = ${tag})`;
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
): Promise<FilePage> {
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(files)
      .where(where)
      .orderBy(...order)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(files).where(where),
  ]);

  return { items: await hydrate(db, rows), total: totals[0]?.value ?? 0 };
}

/** The stable sort every listing uses: the requested field, then `id` to break ties. */
function orderFor(sort: FileSortField, order: 'asc' | 'desc'): SQL[] {
  const column =
    sort === 'displayName'
      ? files.displayNameLower
      : sort === 'createdAt'
        ? files.createdAt
        : sort === 'sizeBytes'
          ? files.sizeBytes
          : files.updatedAt;
  const direction = order === 'desc' ? desc : asc;
  return [direction(column), asc(files.id)];
}

/* ------------------------------------------------------------------ actor-facing reads */

export async function findById(
  actor: Actor,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FileRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const conditions = [eq(files.id, id), lookupVisibility('file', actor)];
  if (!options.includeDeleted) conditions.push(live());

  const [row] = await db.select().from(files).where(and(...conditions)).limit(1);
  return hydrateOne(db, row);
}

export async function findByIds(actor: Actor, ids: string[]): Promise<FileRecord[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();

  const rows = await db
    .select()
    .from(files)
    .where(and(inArray(files.id, unique), lookupVisibility('file', actor), live()));
  return hydrate(db, rows);
}

export async function listInFolder(input: ListInFolderInput): Promise<FilePage> {
  if (!input.folderId) return { items: [], total: 0 };
  const db = await getD1();

  const conditions: SQL[] = [
    eq(files.folderId, input.folderId),
    live(),
    childVisibility('file', input.actor),
  ];
  if (!input.includeArchived) conditions.push(ne(files.status, 'archived'));
  if (input.searchPrefix) conditions.push(prefixMatch(input.searchPrefix));

  return paged(
    db,
    and(...conditions)!,
    orderFor(input.sort, input.order),
    input.page,
    input.pageSize,
  );
}

/** Files the actor trashed themselves — not the ones swept in with a folder. */
export async function listTrashed(input: ListForActorInput): Promise<FilePage> {
  const db = await getD1();
  const where = and(
    eq(files.organizationId, input.actor.organizationId),
    isNotNull(files.deletedAt),
    isNull(files.trashedWithFolderId),
    childVisibility('file', input.actor),
  )!;
  return paged(db, where, [desc(files.updatedAt), asc(files.id)], input.page, input.pageSize);
}

/**
 * Cross-drive search.
 *
 * With a text term the match runs through `files_fts` and the sort is by bm25 relevance;
 * without one it is an ordinary indexed filter query, which is what makes "everything in this
 * project tagged qpcr" fast with no search term at all — the same split the Mongo
 * implementation makes between `$text` and a plain filter.
 *
 * The dedicated D1 search module (Phase 3, module 8) owns cross-entity search and result
 * ranking. This is the file repository's own `search`, present because the contract has always
 * had it and because FTS synchronisation cannot be proved without a reader.
 */
export async function search(input: SearchFilesInput): Promise<FilePage> {
  const db = await getD1();

  const conditions: SQL[] = [
    eq(files.organizationId, input.actor.organizationId),
    live(),
    resourceVisibility('file', input.actor),
  ];

  const match = input.text ? ftsQuery(input.text) : null;
  if (match) {
    conditions.push(
      sql`${files.id} IN (SELECT file_id FROM files_fts WHERE files_fts MATCH ${match})`,
    );
  }

  if (input.folderId) conditions.push(eq(files.folderId, input.folderId));
  if (input.underFolderId) conditions.push(underFolder(input.underFolderId));
  if (input.departmentId) conditions.push(eq(files.departmentId, input.departmentId));
  if (input.projectId) conditions.push(eq(files.projectId, input.projectId));
  if (input.experimentId) conditions.push(eq(files.experimentId, input.experimentId));
  if (input.ownerId) conditions.push(eq(files.ownerId, input.ownerId));
  if (input.category) conditions.push(eq(files.category, input.category as FileCategory));
  if (input.extension) conditions.push(eq(files.extension, input.extension.toLowerCase()));
  if (input.confidentiality) {
    conditions.push(eq(files.confidentiality, input.confidentiality as ConfidentialityLevel));
  }
  if (input.reviewStatus) {
    conditions.push(eq(files.reviewStatus, input.reviewStatus as FileRow['reviewStatus']));
  }
  if (input.approvalStatus) {
    conditions.push(eq(files.approvalStatus, input.approvalStatus as FileRow['approvalStatus']));
  }
  // `$all`: every tag must be present, so one EXISTS each rather than one `IN`.
  for (const tag of input.tags ?? []) conditions.push(hasTag(tag));
  // Keys come from the research-metadata allow-list, and reach SQL as bound parameters either
  // way — there is no dotted path to build here.
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    conditions.push(hasMetadata(key, value));
  }

  if (input.updatedFrom) conditions.push(sql`${files.updatedAt} >= ${input.updatedFrom.toISOString()}`);
  if (input.updatedTo) conditions.push(sql`${files.updatedAt} <= ${input.updatedTo.toISOString()}`);
  if (input.minSize !== undefined) conditions.push(sql`${files.sizeBytes} >= ${input.minSize}`);
  if (input.maxSize !== undefined) conditions.push(sql`${files.sizeBytes} <= ${input.maxSize}`);
  if (!input.includeArchived) conditions.push(ne(files.status, 'archived'));

  const where = and(...conditions)!;

  // Relevance is only meaningful with a text term; without one it degrades to most-recently
  // touched, which is the useful answer for a pure filter query. Same rule as MongoDB.
  const useRelevance = input.sort === 'relevance' && Boolean(match);
  const order: SQL[] = useRelevance
    ? [
        // bm25 returns a negative score where more negative is a better match, so ascending is
        // best-first. Correlated because the row set is driven by `files`, not by the index.
        sql`(SELECT ${BM25} FROM files_fts
              WHERE files_fts MATCH ${match} AND files_fts.file_id = ${files.id}) ASC`,
        desc(files.updatedAt),
        asc(files.id),
      ]
    : input.sort === 'relevance'
      ? [desc(files.updatedAt), asc(files.id)]
      : orderFor(input.sort, input.order);

  return paged(db, where, order, input.page, input.pageSize);
}

/**
 * Files reachable through an explicit grant to this actor.
 *
 * Not "everything visible": role scope already gives a department head their whole department,
 * and listing that here would drown the one file a colleague actually handed over.
 * `excludeOwnerId` drops the actor's own files for the same reason.
 *
 * Denies are excluded in the query rather than filtered afterwards — an entry saying "you may
 * not open this" is not a share, and surfacing it would announce the existence of something the
 * actor was specifically blocked from.
 */
export async function listSharedWith(input: ListSharedWithInput): Promise<FilePage> {
  const principals = [...new Set(input.principalIds.filter(Boolean))];
  if (principals.length === 0) return { items: [], total: 0 };

  const db = await getD1();
  const now = nowIso();

  const where = and(
    eq(files.organizationId, input.actor.organizationId),
    ne(files.ownerId, input.excludeOwnerId),
    ne(files.status, 'archived'),
    live(),
    sql`EXISTS (SELECT 1 FROM ${resourcePermissions} rp
                 WHERE rp.resource_type = 'file'
                   AND rp.resource_id = ${files.id}
                   AND ${inArray(sql`rp.principal_id`, principals)}
                   AND rp.deny = 0
                   AND (rp.expires_at IS NULL OR rp.expires_at > ${now}))`,
  )!;

  return paged(db, where, [desc(files.updatedAt), asc(files.id)], input.page, input.pageSize);
}

/** Distinct values for the facet chips shown beside search results. */
export async function searchFacets(actor: Actor): Promise<SearchFacets> {
  const db = await getD1();
  const visible = and(
    eq(files.organizationId, actor.organizationId),
    live(),
    resourceVisibility('file', actor),
  )!;

  const [categories, tags] = await Promise.all([
    db
      .select({ value: files.category, total: count() })
      .from(files)
      .where(visible)
      .groupBy(files.category)
      .orderBy(desc(count()))
      .limit(20),
    // Counted over the *visible* files only: a tag chip whose count included files the actor
    // cannot open would disclose exactly what the visibility predicate exists to hide.
    db
      .select({ value: resourceTags.tag, total: count() })
      .from(resourceTags)
      .innerJoin(files, eq(files.id, resourceTags.resourceId))
      .where(and(eq(resourceTags.resourceType, 'file'), visible))
      .groupBy(resourceTags.tag)
      .orderBy(desc(count()))
      .limit(30),
  ]);

  return {
    categories: categories.map((row) => ({ value: String(row.value), count: row.total })),
    tags: tags.map((row) => ({ value: row.value, count: row.total })),
  };
}

/**
 * Files related to one file, in a single indexed query.
 *
 * "Related" is four questions the platform is asked constantly — same experiment, same sample
 * id, same experiment code, same checksum — and answering them separately would mean four round
 * trips and four permission passes.
 */
export async function findRelated(input: FindRelatedInput): Promise<FileRecord[]> {
  const branches: SQL[] = [];
  if (input.experimentId) branches.push(eq(files.experimentId, input.experimentId));
  if (input.sampleId) branches.push(hasMetadata('sampleId', input.sampleId));
  if (input.experimentCode) branches.push(hasMetadata('experimentCode', input.experimentCode));
  if (input.checksumSha256) branches.push(eq(files.checksumSha256, input.checksumSha256));
  if (branches.length === 0) return [];

  const db = await getD1();
  const rows = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.organizationId, input.actor.organizationId),
        live(),
        resourceVisibility('file', input.actor),
        ne(files.id, input.excludeFileId),
        or(...branches)!,
      ),
    )
    .orderBy(desc(files.updatedAt), asc(files.id))
    .limit(input.limit);

  return hydrate(db, rows);
}

/**
 * The project dashboard's numbers, computed over the caller's visible set.
 *
 * Every figure derives from the same visibility predicate the file listing uses, so a project
 * member without clearance for a restricted subfolder sees a smaller — and honest — dashboard
 * rather than a total that hints at what they cannot open.
 */
export async function projectContentBreakdown(
  actor: Actor,
  projectId: string,
): Promise<ProjectContentBreakdown> {
  const empty: ProjectContentBreakdown = {
    totalFiles: 0,
    totalBytes: 0,
    byCategory: [],
    byDocumentType: [],
    byReviewStatus: [],
    linkedToExperiment: 0,
  };
  if (!projectId) return empty;

  const db = await getD1();
  const where = and(
    eq(files.projectId, projectId),
    live(),
    resourceVisibility('file', actor),
  )!;

  // `documentType` is a metadata row, so its absence is the 'unclassified' bucket — the SQL
  // equivalent of `$ifNull: ['$metadata.documentType', 'unclassified']`.
  const documentType = sql<string>`COALESCE((SELECT md.value FROM ${fileMetadata} md
                                              WHERE md.file_id = ${files.id}
                                                AND md.key = 'documentType'), 'unclassified')`;

  const [totals, categories, documentTypes, reviewStatuses, linked] = await Promise.all([
    db
      .select({ total: count(), bytes: sum(files.sizeBytes) })
      .from(files)
      .where(where),
    db
      .select({ value: files.category, total: count(), bytes: sum(files.sizeBytes) })
      .from(files)
      .where(where)
      .groupBy(files.category)
      .orderBy(desc(count())),
    db
      .select({ value: documentType, total: count(), bytes: sum(files.sizeBytes) })
      .from(files)
      .where(where)
      .groupBy(documentType)
      .orderBy(desc(count())),
    db
      .select({ value: files.reviewStatus, total: count() })
      .from(files)
      .where(where)
      .groupBy(files.reviewStatus),
    db
      .select({ value: count() })
      .from(files)
      .where(and(where, isNotNull(files.experimentId))),
  ]);

  // `SUM()` is NULL over an empty set and returns text through the D1 driver.
  const bytes = (value: string | null) => Number(value ?? 0);

  return {
    totalFiles: totals[0]?.total ?? 0,
    totalBytes: bytes(totals[0]?.bytes ?? null),
    byCategory: categories.map((row) => ({
      value: String(row.value),
      count: row.total,
      bytes: bytes(row.bytes),
    })),
    byDocumentType: documentTypes.map((row) => ({
      value: String(row.value ?? 'unclassified'),
      count: row.total,
      bytes: bytes(row.bytes),
    })),
    byReviewStatus: reviewStatuses.map((row) => ({ value: String(row.value), count: row.total })),
    linkedToExperiment: linked[0]?.value ?? 0,
  };
}

/* ------------------------------------------------------------------ structural reads */

export async function existsWithName(
  folderId: string,
  displayNameLower: string,
  excludeId?: string,
): Promise<boolean> {
  if (!folderId) return false;
  const db = await getD1();
  const conditions: SQL[] = [
    eq(files.folderId, folderId),
    eq(files.displayNameLower, displayNameLower),
    live(),
  ];
  if (excludeId) conditions.push(ne(files.id, excludeId));

  const [row] = await db.select({ value: count() }).from(files).where(and(...conditions));
  return (row?.value ?? 0) > 0;
}

export async function takenNamesInFolder(folderId: string): Promise<Set<string>> {
  if (!folderId) return new Set();
  const db = await getD1();
  const rows = await db
    .select({ displayNameLower: files.displayNameLower })
    .from(files)
    .where(and(eq(files.folderId, folderId), live()))
    .limit(TAKEN_NAMES_LIMIT);
  return new Set(rows.map((row) => row.displayNameLower));
}

/** Same bytes already stored in the same folder — used to warn about duplicate uploads. */
export async function findByChecksumInFolder(
  folderId: string,
  checksum: string,
): Promise<FileRecord | null> {
  if (!folderId || !checksum) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.folderId, folderId), eq(files.checksumSha256, checksum), live()))
    .limit(1);
  return hydrateOne(db, row);
}

export async function countInFolder(folderId: string): Promise<number> {
  if (!folderId) return 0;
  const db = await getD1();
  const [row] = await db
    .select({ value: count() })
    .from(files)
    .where(and(eq(files.folderId, folderId), live()));
  return row?.value ?? 0;
}

export async function countForExperiment(experimentId: string): Promise<number> {
  if (!experimentId) return 0;
  const db = await getD1();
  const [row] = await db
    .select({ value: count() })
    .from(files)
    .where(and(eq(files.experimentId, experimentId), live()));
  return row?.value ?? 0;
}

/* ------------------------------------------------------------------ bypasses */

/**
 * The row, whoever is asking.
 *
 * ⚠️ Authorization bypass. Trusted server code only — the re-read a mutation performs on a file
 * whose permission it has already asserted, and the storage services. Never reachable from an
 * API route: routes go through `file-access.ts`, which calls the permission-aware `findById`.
 */
export async function findByIdInternal(
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FileRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const conditions: SQL[] = [eq(files.id, id)];
  if (!options.includeDeleted) conditions.push(live());

  const [row] = await db.select().from(files).where(and(...conditions)).limit(1);
  return hydrateOne(db, row);
}

/** ⚠️ Bypass: subtree and batch mutations, authorized at the root of the subtree. */
export async function findByIdsInternal(ids: string[]): Promise<FileRecord[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();
  const rows = await db
    .select()
    .from(files)
    .where(and(inArray(files.id, unique), live()));
  return hydrate(db, rows);
}

/**
 * The application file a mirrored Drive file belongs to.
 *
 * ⚠️ Authorization bypass. The Drive change feed starts from a Drive id and works backwards,
 * and runs as the sync worker rather than as a user.
 *
 * ── Why this reads `file_versions` ──────────────────────────────────────────────────────
 *
 * **No Drive id is stored on the file.** `file.model.ts` states the rule — a `File` never holds
 * a storage location, so a physical address cannot leak through a file listing however
 * carelessly it is serialized — and the `files` table repeats it. Drive ids live on versions,
 * so the lookup is `google_drive_file_id → file_versions.file_id → files.id`.
 *
 * That is the *only* thing this method takes from the version domain. It reads two columns to
 * resolve an id and returns a `FileRecord`; no version business logic, no version record, and
 * nothing about which version is current or approved. The file-version module has not started.
 *
 * ── Deliberately not organization-scoped ────────────────────────────────────────────────
 *
 * A Drive id is unique across the whole mirror and the change feed starts with no organization
 * in hand. Scoping this would make another tenant's change resolve to null, be filed as an
 * unmanaged item, and the mirror's disagreement would never be reported. Isolation is the
 * caller's obligation; `FileRecord.organizationId` is returned so it can discharge it. §5 of
 * the module document carries the full reasoning, and both engines are tested on it.
 *
 * Trashed files resolve on purpose: a change arriving for a file trashed here must still be
 * recognised as *ours*.
 */
export async function findByDriveFileIdInternal(
  googleDriveFileId: string,
): Promise<FileRecord | null> {
  if (!googleDriveFileId) return null;
  const db = await getD1();

  // Two, not one: the second row is what distinguishes "resolved" from "ambiguous", and a
  // single-row read could never tell the difference.
  const versions = await db
    .select({ fileId: fileVersions.fileId })
    .from(fileVersions)
    .where(eq(fileVersions.googleDriveFileId, googleDriveFileId))
    .limit(2);

  if (versions.length === 0) return null;

  const fileIds = [...new Set(versions.map((version) => version.fileId))];
  if (fileIds.length > 1) {
    getLogger().error(
      { googleDriveFileId, fileIds },
      'One Google Drive file is linked to several application files; refusing to resolve it',
    );
    throw new AmbiguousDriveFileError(googleDriveFileId, fileIds);
  }

  return findByIdInternal(fileIds[0]!, { includeDeleted: true });
}

/**
 * Any live file in this organization with exactly these bytes.
 *
 * ⚠️ Bypass, deliberately: a storage decision rather than a listing. The Drive import uses it to
 * avoid storing a third copy of a file two people already saved twice, and the caller reports
 * "already present" without ever disclosing where the existing copy is.
 */
export async function findByChecksumInternal(
  organizationId: string,
  checksumSha256: string,
): Promise<FileRecord | null> {
  if (!checksumSha256) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.organizationId, organizationId),
        eq(files.checksumSha256, checksumSha256),
        live(),
      ),
    )
    .limit(1);
  return hydrateOne(db, row);
}

/** ⚠️ Bypass: the retention purge job's cursor. Runs as no user. */
export async function findExpiredTrashInternal(
  before: Date,
  limit = 200,
): Promise<FileRecord[]> {
  const db = await getD1();
  const rows = await db
    .select()
    .from(files)
    .where(and(isNotNull(files.deletedAt), lte(files.deletedAt, before.toISOString())))
    .limit(limit);
  return hydrate(db, rows);
}

/* ------------------------------------------------------------------ write helpers */

/**
 * Replaces a file's ACL, matching `$set: { permissions }` — the sharing service always computes
 * the complete set and hands it over.
 */
function aclStatements(
  db: Database,
  organizationId: string,
  fileId: string,
  entries: AclEntryWrite[],
  now: string,
): BatchItem<'sqlite'>[] {
  const statements: BatchItem<'sqlite'>[] = [
    db
      .delete(resourcePermissions)
      .where(
        and(
          eq(resourcePermissions.resourceType, 'file'),
          eq(resourcePermissions.resourceId, fileId),
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
        resourceType: 'file',
        resourceId: fileId,
        principalType: entry.principalType,
        principalId: entry.principalId,
        accessLevel: entry.accessLevel as typeof resourcePermissions.$inferInsert.accessLevel,
        deny: Boolean(entry.deny),
        expiresAt: toIso(entry.expiresAt),
        grantedBy: entry.grantedBy ?? null,
        grantedAt: now,
      }),
    );
  }

  return statements;
}

/** Replaces the whole tag set, de-duplicated to match the unique index. */
function tagStatements(
  db: Database,
  organizationId: string,
  fileId: string,
  tags: string[],
): BatchItem<'sqlite'>[] {
  const statements: BatchItem<'sqlite'>[] = [
    db
      .delete(resourceTags)
      .where(and(eq(resourceTags.resourceType, 'file'), eq(resourceTags.resourceId, fileId))),
  ];

  for (const tag of [...new Set(tags.filter((tag) => tag.length > 0))]) {
    statements.push(
      db.insert(resourceTags).values({
        organizationId,
        resourceType: 'file',
        resourceId: fileId,
        tag,
      }),
    );
  }

  return statements;
}

/**
 * The ordered folder chain, root → containing folder.
 *
 * The containing folder is the **last** element, not an omission: `folderPathAncestors` has
 * always ended with `folderId`, `checkFileHierarchyIntegrity` asserts it, and the inheritance
 * predicate depends on it — a file inherits from the folder it is in, which it can only do if
 * that folder is one of its ancestor rows.
 */
function ancestorStatements(
  db: Database,
  fileId: string,
  chain: string[],
): BatchItem<'sqlite'>[] {
  return chain.map((ancestorId, depth) =>
    db.insert(fileFolderAncestors).values({ fileId, ancestorId, depth }),
  );
}

/* ------------------------------------------------------------------ writes */

/**
 * Mints an id before the row exists, because the storage key contains it.
 *
 * The bytes are moved into place before the metadata row is written, so the id has to exist
 * first. `crypto.randomUUID()` rather than an ObjectId: nothing in D1 requires the BSON shape,
 * and the folder repository already mints ids this way.
 */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Inserts the file, its ancestor chain, its metadata and its tags as one atomic list.
 *
 * A file row whose ancestor rows did not land would be invisible to every subtree query and
 * every inheritance check — reachable by id, but outside the tree, and *more* visible than it
 * should be because the inherited-deny guard would find no ancestors either. So they land
 * together or not at all.
 *
 * `input.id` is honoured when supplied: the caller has already built a storage key containing
 * it, and minting a second id here would orphan the bytes.
 */
export async function create(input: CreateFileInput): Promise<FileRecord> {
  const db = await getD1();

  // The folder has to exist and has to be in the same tenant. Permission is the service's
  // business; *structure* is this layer's, and a file hung inside a folder in another
  // organization is a tenancy breach no permission check downstream would catch.
  const [folder] = await db
    .select({ organizationId: folders.organizationId })
    .from(folders)
    .where(and(eq(folders.id, input.folderId), isNull(folders.deletedAt)))
    .limit(1);
  if (!folder) throw new ConflictError('The destination folder no longer exists');
  if (folder.organizationId !== input.organizationId) {
    throw new ConflictError('A file cannot be created in another organization');
  }

  const id = input.id ?? newId();
  const now = nowIso();
  // Only the Drive import supplies these: an archive whose files all claim to have been created
  // on migration day is useless for provenance.
  const createdAt = toIso(input.createdAt ?? null) ?? now;
  const updatedAt = toIso(input.updatedAt ?? null) ?? createdAt;

  const statements: BatchItem<'sqlite'>[] = [
    db.insert(files).values({
      id,
      organizationId: input.organizationId,
      displayName: input.displayName,
      displayNameLower: input.displayName.toLowerCase(),
      originalFilename: input.originalFilename,
      extension: input.extension,
      category: input.category,
      folderId: input.folderId,
      driveType: input.driveType,
      ownerId: input.ownerId,
      departmentId: input.departmentId,
      projectId: input.projectId,
      confidentiality: input.confidentiality,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      checksumSha256: input.checksumSha256,
      createdBy: input.createdBy,
      createdAt,
      updatedAt,
    }),
    ...ancestorStatements(db, id, input.folderPathAncestors),
  ];

  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (value === undefined || value === null) continue;
    statements.push(db.insert(fileMetadata).values({ fileId: id, key, value: String(value) }));
  }

  for (const tag of [...new Set((input.tags ?? []).filter((tag) => tag.length > 0))]) {
    statements.push(
      db.insert(resourceTags).values({
        organizationId: input.organizationId,
        resourceType: 'file',
        resourceId: id,
        tag,
      }),
    );
  }

  // The insert trigger writes an FTS row with empty keywords, because at that instant the
  // metadata and tag rows in this same batch have not been inserted yet. Refreshing at the end
  // of the batch is what makes a file findable by its sample id the moment it exists.
  statements.push(
    ...refreshFileFts(
      db,
      id,
      ftsContentOf(
        input.displayName,
        input.originalFilename,
        input.tags ?? [],
        input.metadata ?? {},
      ),
    ),
  );

  await withBatch(db, statements);

  const created = await findByIdInternal(id);
  if (!created) throw new Error(`File ${id} disappeared immediately after insert`);
  return created;
}

/**
 * Translates a `FilePatch` into the columns and side-table writes it implies.
 *
 * The mapping is explicit rather than a spread: an unknown key arriving from a caller must not
 * become a write to a column the schema has never heard of.
 */
function toColumns(patch: FilePatch, now: string): Partial<typeof files.$inferInsert> {
  const columns: Partial<typeof files.$inferInsert> = {};

  if (patch.displayName !== undefined) {
    columns.displayName = patch.displayName;
    // Never written separately: the two must not be able to disagree.
    columns.displayNameLower = patch.displayName.toLowerCase();
  }
  if (patch.originalFilename !== undefined) columns.originalFilename = patch.originalFilename;
  if (patch.category !== undefined) columns.category = patch.category;
  if (patch.folderId !== undefined) columns.folderId = patch.folderId;
  if (patch.driveType !== undefined) columns.driveType = patch.driveType;
  if (patch.ownerId !== undefined) columns.ownerId = patch.ownerId;
  if (patch.departmentId !== undefined) columns.departmentId = patch.departmentId;
  if (patch.projectId !== undefined) columns.projectId = patch.projectId;
  if (patch.experimentId !== undefined) columns.experimentId = patch.experimentId;
  if (patch.confidentiality !== undefined) columns.confidentiality = patch.confidentiality;
  if (patch.reviewStatus !== undefined) {
    columns.reviewStatus = patch.reviewStatus as typeof files.$inferInsert.reviewStatus;
  }
  if (patch.approvalStatus !== undefined) {
    columns.approvalStatus = patch.approvalStatus as typeof files.$inferInsert.approvalStatus;
  }
  if (patch.status !== undefined) {
    columns.status = patch.status as typeof files.$inferInsert.status;
  }
  if (patch.currentVersionId !== undefined) columns.currentVersionId = patch.currentVersionId;
  if (patch.approvedVersionId !== undefined) columns.approvedVersionId = patch.approvedVersionId;
  if (patch.sizeBytes !== undefined) columns.sizeBytes = patch.sizeBytes;
  if (patch.mimeType !== undefined) columns.mimeType = patch.mimeType;
  if (patch.checksumSha256 !== undefined) columns.checksumSha256 = patch.checksumSha256;
  if (patch.hasGoogleNativeContent !== undefined) {
    columns.hasGoogleNativeContent = patch.hasGoogleNativeContent;
  }
  if (patch.storageProvider !== undefined) columns.storageProvider = patch.storageProvider;
  if (patch.inheritPermissions !== undefined) columns.inheritPermissions = patch.inheritPermissions;
  if (patch.updatedBy !== undefined) columns.updatedBy = patch.updatedBy;
  if (patch.lastAccessedAt !== undefined) columns.lastAccessedAt = toIso(patch.lastAccessedAt);

  if (Object.keys(columns).length > 0) columns.updatedAt = now;
  return columns;
}

/**
 * Everything a patch implies, as one atomic list.
 *
 * The counters are the two the application ever incremented rather than set, and they are
 * applied as `column = column + delta` in SQL rather than read-modify-written in JavaScript —
 * two concurrent downloads must both count.
 */
function patchStatements(
  db: Database,
  id: string,
  organizationId: string,
  patch: FilePatch,
  where: SQL,
  now: string,
): BatchItem<'sqlite'>[] {
  const statements: BatchItem<'sqlite'>[] = [];
  const columns = toColumns(patch, now);

  const counters: Record<string, SQL> = {};
  if (patch.versionCountDelta !== undefined) {
    counters.versionCount = sql`${files.versionCount} + ${patch.versionCountDelta}`;
  }
  if (patch.downloadCountDelta !== undefined) {
    counters.downloadCount = sql`${files.downloadCount} + ${patch.downloadCountDelta}`;
  }

  if (Object.keys(columns).length > 0 || Object.keys(counters).length > 0) {
    statements.push(
      db
        .update(files)
        .set({ ...columns, ...counters, ...(Object.keys(counters).length ? { updatedAt: now } : {}) })
        .where(where),
    );
  }

  // The chain is rewritten wholesale, exactly as `$set: { folderPathAncestors }` replaced the
  // array. A partial rewrite would leave a file with two chains interleaved by depth.
  if (patch.folderPathAncestors !== undefined) {
    statements.push(
      db.delete(fileFolderAncestors).where(eq(fileFolderAncestors.fileId, id)),
      ...ancestorStatements(db, id, patch.folderPathAncestors),
    );
  }

  if (patch.permissions !== undefined) {
    statements.push(...aclStatements(db, organizationId, id, patch.permissions, now));
  }

  if (patch.tags !== undefined) {
    statements.push(...tagStatements(db, organizationId, id, patch.tags));
  }

  // Upsert the named keys and leave the others alone — the dotted-path `$set` that made a
  // partial metadata edit possible without replacing the whole sub-document.
  for (const [key, value] of Object.entries(patch.metadataSet ?? {})) {
    if (value === undefined || value === null) {
      statements.push(
        db.delete(fileMetadata).where(and(eq(fileMetadata.fileId, id), eq(fileMetadata.key, key))),
      );
      continue;
    }
    statements.push(
      db
        .insert(fileMetadata)
        .values({ fileId: id, key, value: String(value) })
        .onConflictDoUpdate({
          target: [fileMetadata.fileId, fileMetadata.key],
          set: { value: String(value) },
        }),
    );
  }

  for (const key of patch.metadataUnset ?? []) {
    statements.push(
      db.delete(fileMetadata).where(and(eq(fileMetadata.fileId, id), eq(fileMetadata.key, key))),
    );
  }

  return statements;
}

/** Whether a patch can change anything `files_fts` indexes. */
function touchesSearchableContent(patch: FilePatch): boolean {
  return (
    patch.displayName !== undefined ||
    patch.originalFilename !== undefined ||
    patch.tags !== undefined ||
    patch.metadataSet !== undefined ||
    patch.metadataUnset !== undefined ||
    patch.status !== undefined
  );
}

export async function updateById(id: string, patch: FilePatch): Promise<FileRecord | null> {
  return updateByIdWhere(id, {}, patch);
}

/**
 * A conditional update: applies only while the file still matches `guard`.
 *
 * The guard is the point. Clearing a file's approval because an older version's content drifted
 * is only correct if that version is still the one holding the approval — if a newer one has
 * been approved since, a read-then-write would silently undo it. Expressing the condition in
 * the statement makes a lost race a no-op rather than an overwrite.
 *
 * Returns null when nothing matched, which callers read as "somebody else changed it first".
 *
 * The guard is applied to the `files` UPDATE. The side-table statements in the same batch are
 * keyed by id alone, so a guard that matches nothing still runs them — which is why the row is
 * re-read first and the batch is skipped entirely when the guard does not hold. That read and
 * the batch are not atomic with respect to each other; the `files` UPDATE still carries the
 * guard, so the base row cannot be written against state it was not computed for.
 */
export async function updateByIdWhere(
  id: string,
  guard: FileGuard,
  patch: FilePatch,
): Promise<FileRecord | null> {
  if (!id) return null;
  const db = await getD1();

  const conditions: SQL[] = [eq(files.id, id), live()];
  if (guard.approvedVersionId !== undefined) {
    conditions.push(
      guard.approvedVersionId === null
        ? isNull(files.approvedVersionId)
        : eq(files.approvedVersionId, guard.approvedVersionId),
    );
  }
  if (guard.currentVersionId !== undefined) {
    conditions.push(
      guard.currentVersionId === null
        ? isNull(files.currentVersionId)
        : eq(files.currentVersionId, guard.currentVersionId),
    );
  }
  if (guard.folderId !== undefined) conditions.push(eq(files.folderId, guard.folderId));
  if (guard.displayName !== undefined) conditions.push(eq(files.displayName, guard.displayName));
  if (guard.reviewStatus !== undefined) {
    conditions.push(eq(files.reviewStatus, guard.reviewStatus as FileRow['reviewStatus']));
  }
  if (guard.approvalStatus !== undefined) {
    conditions.push(eq(files.approvalStatus, guard.approvalStatus as FileRow['approvalStatus']));
  }
  if (guard.status !== undefined) {
    conditions.push(eq(files.status, guard.status as FileRow['status']));
  }
  const where = and(...conditions)!;

  // The whole record, not just the id: the FTS row is rebuilt from the *post-patch* tags and
  // metadata, and a patch that sets one metadata key must not blank the others in the index.
  const [row] = await db.select().from(files).where(where).limit(1);
  if (!row) return null;
  const existing = (await hydrate(db, [row]))[0]!;

  const now = nowIso();
  const statements = patchStatements(db, id, existing.organizationId, patch, where, now);

  // An empty patch is a no-op read rather than an error: callers assemble patches
  // conditionally, and an UPDATE with no columns is not a statement.
  if (statements.length === 0) return findByIdInternal(id);

  if (touchesSearchableContent(patch)) {
    const metadata = { ...existing.metadata, ...(patch.metadataSet ?? {}) };
    for (const key of patch.metadataUnset ?? []) delete metadata[key];

    statements.push(
      ...refreshFileFts(
        db,
        id,
        ftsContentOf(
          patch.displayName ?? existing.displayName,
          patch.originalFilename ?? existing.originalFilename,
          patch.tags ?? existing.tags,
          metadata,
        ),
      ),
    );
  }

  await withBatch(db, statements);
  return findByIdInternal(id);
}

export async function setDeleted(
  input: { fileId: string; deleted: boolean; userId: string; withFolderId?: string | null },
): Promise<void> {
  const db = await getD1();
  const now = nowIso();

  if (input.deleted) {
    await db
      .update(files)
      .set({
        deletedAt: now,
        deletedBy: input.userId,
        status: 'trashed',
        trashedWithFolderId: input.withFolderId ?? null,
        updatedAt: now,
      })
      .where(and(eq(files.id, input.fileId), isNull(files.deletedAt)));
    return;
  }

  await db
    .update(files)
    .set({
      deletedAt: null,
      deletedBy: null,
      status: 'active',
      trashedWithFolderId: null,
      updatedAt: now,
    })
    .where(and(eq(files.id, input.fileId), isNotNull(files.deletedAt)));
}

/**
 * Trashes or restores a file on nobody's behalf.
 *
 * ⚠️ Bypass: somebody moved the object in Google Drive and the change feed noticed. `deletedBy`
 * is left null rather than attributed to the owner or an administrator, because neither of them
 * did it — a false attribution in the one field that answers "who deleted this?" would be worse
 * than an empty one, and the audit entry records what actually happened.
 *
 * Returns whether anything changed, so a replayed change is a no-op the caller can see.
 */
export async function setDeletedBySystem(input: {
  fileId: string;
  deleted: boolean;
}): Promise<boolean> {
  if (!input.fileId) return false;
  const db = await getD1();
  const now = nowIso();

  const state = input.deleted ? isNull(files.deletedAt) : isNotNull(files.deletedAt);
  // Counted with a SELECT rather than read off `meta.changes` — see `matchingIds`.
  const [before] = await db
    .select({ value: count() })
    .from(files)
    .where(and(eq(files.id, input.fileId), state));
  if ((before?.value ?? 0) === 0) return false;

  await db
    .update(files)
    .set(
      input.deleted
        ? {
            deletedAt: now,
            deletedBy: null,
            status: 'trashed',
            trashedWithFolderId: null,
            updatedAt: now,
          }
        : {
            deletedAt: null,
            deletedBy: null,
            status: 'active',
            trashedWithFolderId: null,
            updatedAt: now,
          },
    )
    .where(and(eq(files.id, input.fileId), state));

  return true;
}

/**
 * The ids a predicate matches, read before the write that acts on them.
 *
 * ── Why not `result.meta.changes` ───────────────────────────────────────────────────────
 *
 * D1's `changes` is not the number of rows the statement matched. It includes rows written by
 * triggers and by `ON DELETE CASCADE`, and `files` has both: every UPDATE fires
 * `trg_files_fts_update` (a DELETE and an INSERT on `files_fts`), and every DELETE cascades to
 * four side tables. Purging one file reported 6, and restoring one reported 4.
 *
 * Those numbers are returned to callers — `setSubtreeDeleted` tells the folder service how many
 * files it trashed, and that lands in an audit entry — so an inflated count is wrong data, not
 * a cosmetic difference. Reading the ids first costs one indexed SELECT and is exact.
 */
async function matchingIds(db: Database, where: SQL): Promise<string[]> {
  const rows = await db.select({ id: files.id }).from(files).where(where);
  return rows.map((row) => row.id);
}

/** Which files a subtree sweep will touch — the predicate, shared by the count and the write. */
function sweptFiles(folderId: string, deleted: boolean): SQL {
  return deleted
    ? and(underFolder(folderId), isNull(files.deletedAt))!
    : // Only the files this folder took down with it — one trashed on its own beforehand must
      // stay in the trash when the folder comes back.
      and(
        underFolder(folderId),
        eq(files.trashedWithFolderId, folderId),
        isNotNull(files.deletedAt),
      )!;
}

/**
 * The statement that trashes or restores every file in a folder subtree — built, not executed.
 *
 * ── Set-wise, not by id list ────────────────────────────────────────────────────────────
 *
 * The predicate is the same one the count reads, rather than the ids that count returned.
 * Binding the ids would put one parameter per *file* on the statement, and SQLite's default
 * ceiling is 999 — so the previous form could not trash a folder holding a thousand files at
 * all, and nothing in the code said so. Set-wise, the file count does not enter the statement.
 *
 * Safe against the composed batch because no lifecycle statement changes folder membership:
 * `underFolder` reads `files.folder_id` and `file_folder_ancestors`, neither of which this batch
 * writes, so the predicate selects the same set before and after.
 *
 * The UPDATE fires `trg_files_fts_update`, which is how a trashed file leaves `files_fts` and a
 * restored one returns to it. That is the existing indexing contract, not an addition.
 */
export function buildFileSubtreeDeletedStatements(
  db: Database,
  input: { folderId: string; deleted: boolean; userId: string; now: string },
): BatchItem<'sqlite'>[] {
  const { folderId, deleted, userId, now } = input;

  return [
    db
      .update(files)
      .set(
        deleted
          ? {
              deletedAt: now,
              deletedBy: userId,
              status: 'trashed',
              trashedWithFolderId: folderId,
              updatedAt: now,
            }
          : {
              deletedAt: null,
              deletedBy: null,
              status: 'active',
              trashedWithFolderId: null,
              updatedAt: now,
            },
      )
      .where(sweptFiles(folderId, deleted)),
  ];
}

/**
 * How many files a sweep will change, counted before it runs.
 *
 * The same discipline as `matchingIds` and for the same reason — this number reaches an audit
 * entry, and `meta.changes` would inflate it with the FTS trigger's writes. A `count()` rather
 * than the id list because only the total is wanted, and the id list of a large subtree is a lot
 * of rows to carry for a number.
 */
export async function countFileSubtreeSweep(
  db: Database,
  input: { folderId: string; deleted: boolean },
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(files)
    .where(sweptFiles(input.folderId, input.deleted));
  return row?.value ?? 0;
}

/**
 * Trashes or restores every file inside a folder subtree.
 *
 * The file half only. On D1 `folder.service.ts` goes through the composed lifecycle operations
 * in `d1-unit-of-work.ts`, which build these same statements into the folder half's batch.
 */
export async function setSubtreeDeleted(
  input: { folderId: string; deleted: boolean; userId: string },
): Promise<number> {
  const db = await getD1();
  const affected = await countFileSubtreeSweep(db, input);
  if (affected === 0) return 0;

  await withBatch(db, buildFileSubtreeDeletedStatements(db, { ...input, now: nowIso() }));
  return affected;
}

/**
 * Keeps files in step with the folder subtree they live in after a move.
 *
 * ── Why the chains are rebuilt rather than shifted ──────────────────────────────────────
 *
 * Each affected file's chain is `newAncestors ++ [folderId] ++ (the part of its own folder's
 * chain below folderId) ++ [its folder]`. The obvious implementation — delete the rows above
 * `folderId` and shift the rest — needs each file's *current* depth of `folderId`, and that
 * value changes as the same statement updates it. A correlated sub-query reading the table
 * being written is not safe.
 *
 * So the suffix is read from `folder_ancestors` instead, which this statement does not write.
 * The relative structure below the moved folder is unchanged by a move, so that table gives the
 * same answer before and after `moveSubtree` runs — the rebuild is correct either way, and
 * self-healing if a chain was already wrong.
 *
 * `folder.service.ts` calls `folderRepository.moveSubtree` and then this, in that order. The
 * two are separate batches today: that is the gap the shared unit-of-work closes, and §13 of
 * the module document records what it must call.
 */
export async function reparentSubtree(
  input: ReparentSubtreeInput,
): Promise<void> {
  const db = await getD1();
  const now = nowIso();

  const plan = await planFileReparent(db, input);
  if (plan.length === 0) return;

  await withBatch(db, buildFileReparentStatements(db, { ...input, folderChains: plan, now }));
}

/**
 * Which folders in the subtree hold files, and what each one's chain will be afterwards.
 *
 * Read from `folder_ancestors`, which by the time a standalone `reparentSubtree` runs has
 * already been rewritten by the folder move. The atomic unit of work cannot read it — the
 * folder statements are in the same unexecuted batch — so it computes the identical structure
 * in memory and hands it to the same builder. That is the whole reason this is a separate
 * function from the builder below.
 */
export async function planFileReparent(
  db: Database,
  input: ReparentSubtreeInput,
): Promise<FolderChain[]> {
  const folderRows = await db
    .selectDistinct({ folderId: files.folderId })
    .from(files)
    .where(and(underFolder(input.folderId), live()));
  if (folderRows.length === 0) return [];

  const folderIds = folderRows.map((row) => row.folderId);
  const chainRows = await db
    .select({
      folderId: folderAncestors.folderId,
      ancestorId: folderAncestors.ancestorId,
      depth: folderAncestors.depth,
    })
    .from(folderAncestors)
    .where(inArray(folderAncestors.folderId, folderIds))
    .orderBy(asc(folderAncestors.folderId), asc(folderAncestors.depth));

  const existing = new Map<string, string[]>();
  for (const row of chainRows) {
    const chain = existing.get(row.folderId);
    if (chain) chain.push(row.ancestorId);
    else existing.set(row.folderId, [row.ancestorId]);
  }

  return folderIds.map((folderId) => {
    // A file directly in the moved folder gets the caller's chain verbatim. One deeper keeps
    // everything from the moved folder down — unchanged by a move — re-based onto the new
    // prefix.
    if (folderId === input.folderId) {
      return { folderId, chain: [...input.newPathAncestorsForFolder, input.folderId] };
    }
    const folderChain = existing.get(folderId) ?? [];
    const cut = folderChain.indexOf(input.folderId);
    const below = cut === -1 ? [] : folderChain.slice(cut + 1);
    return {
      folderId,
      chain: [...input.newPathAncestorsForFolder, input.folderId, ...below, folderId],
    };
  });
}

/**
 * The statements that re-point every file in a moved subtree — built, not executed.
 *
 * ── Why this is per *folder* and not per file ───────────────────────────────────────────
 *
 * Every file in one folder ends up with the same ancestor chain, so the rebuild is expressed
 * as `INSERT ... SELECT id FROM files WHERE folder_id = ?` — one statement per (folder, depth)
 * pair rather than one per (file, ancestor) pair. The earlier implementation emitted the
 * latter, which made the batch grow with the number of *files*: a folder holding ten thousand
 * files could not be moved atomically at all.
 *
 * The count is now `2 + Σ chain lengths ≈ 2 + folders × depth`, and **the number of files does
 * not appear in it**. A folder with one file and a folder with a million cost the same.
 *
 * This is safe because `files.folder_id` is not touched by a move — only the ancestor rows
 * are — so `WHERE folder_id = ?` selects the same set before and after, and reads nothing this
 * batch rewrites.
 *
 * `guard`, when supplied, is the folder half's concurrency token. Every statement carries it so
 * that a stale plan applies nothing on either side. Without it (the standalone path) the folder
 * move has already committed and there is nothing left to be consistent with.
 */
export function buildFileReparentStatements(
  db: Database,
  input: ReparentSubtreeInput & { folderChains: FolderChain[]; now: string; guard?: SQL },
): BatchItem<'sqlite'>[] {
  const { folderChains, guard, now } = input;
  if (folderChains.length === 0) return [];

  const folderIds = folderChains.map((entry) => entry.folderId);
  const inSubtree = inArray(files.folderId, folderIds);
  const scope = guard ? and(inSubtree, live(), guard)! : and(inSubtree, live())!;

  const statements: BatchItem<'sqlite'>[] = [
    db
      .update(files)
      .set({
        driveType: input.driveType as typeof files.$inferInsert.driveType,
        departmentId: input.departmentId,
        projectId: input.projectId,
        updatedAt: now,
      })
      .where(scope),

    db
      .delete(fileFolderAncestors)
      .where(
        sql`${fileFolderAncestors.fileId} IN (SELECT f.id FROM ${files} f
              WHERE ${inArray(sql`f.folder_id`, folderIds)} AND f.deleted_at IS NULL)
            ${guard ? sql` AND ${guard}` : sql``}`,
      ),
  ];

  for (const { folderId, chain } of folderChains) {
    chain.forEach((ancestorId, depth) => {
      statements.push(
        db.insert(fileFolderAncestors).select(
          sql`select f.id, ${ancestorId}, ${depth} from ${files} f
               where f.folder_id = ${folderId} and f.deleted_at is null
               ${guard ? sql` and ${guard}` : sql``}`,
        ),
      );
    });
  }

  return statements;
}

/**
 * The statement that archives or unarchives every live file in a folder subtree.
 *
 * `live()` matters: a file already in the trash keeps `status = 'trashed'` through an archive of
 * the folder around it, and comes back as trashed rather than archived. Archive and trash are
 * separate lifecycles and this is the line between them.
 */
export function buildFileSubtreeStatusStatements(
  db: Database,
  input: { folderId: string; status: 'active' | 'archived'; now: string },
): BatchItem<'sqlite'>[] {
  return [
    db
      .update(files)
      .set({ status: input.status, updatedAt: input.now })
      .where(and(underFolder(input.folderId), live())),
  ];
}

/** How many live files a status change covers. */
export async function countFileSubtreeStatus(db: Database, folderId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(files)
    .where(and(underFolder(folderId), live()));
  return row?.value ?? 0;
}

export async function setSubtreeStatus(
  input: { folderId: string; status: 'active' | 'archived' },
): Promise<void> {
  const db = await getD1();
  await withBatch(db, buildFileSubtreeStatusStatements(db, { ...input, now: nowIso() }));
}

/** Clears the experiment link on every file pointing at an experiment. */
export async function unlinkExperiment(experimentId: string): Promise<number> {
  if (!experimentId) return 0;
  const db = await getD1();
  const ids = await matchingIds(db, and(eq(files.experimentId, experimentId), live())!);
  if (ids.length === 0) return 0;

  await db
    .update(files)
    .set({ experimentId: null, updatedAt: nowIso() })
    .where(inArray(files.id, ids));
  return ids.length;
}

/**
 * ⚠️ Bypass: hard delete. Only the retention purge and the tests reach this.
 *
 * The side tables cascade on `files.id`, and `trg_files_fts_delete` removes the index row, so
 * one statement is genuinely the whole deletion.
 */
export async function purge(fileIds: string[]): Promise<number> {
  const unique = [...new Set(fileIds.filter(Boolean))];
  if (unique.length === 0) return 0;
  const db = await getD1();

  // The ids that actually exist: `changes` would count the cascaded side-table rows as well,
  // and the retention job reports this number as "files purged".
  const present = await matchingIds(db, inArray(files.id, unique));
  if (present.length === 0) return 0;

  await db.delete(files).where(inArray(files.id, present));
  return present.length;
}

/* ------------------------------------------------------------------ integrity */

/**
 * Everything wrong with the stored file hierarchy, or an empty list.
 *
 * `files.folder_id` and `file_folder_ancestors` are two representations of one truth, and a bug
 * in a subtree mutation shows up here as a disagreement between them long before a user notices
 * a file in the wrong place. Admin and test tooling rather than a request path — every mutation
 * test in the D1 suite finishes by running this.
 *
 * Checks the same five conditions as the Mongo implementation plus one it cannot express: that
 * the chain's `depth` values are the contiguous run `0..n-1`, which is meaningless for an array
 * and load-bearing for a closure table — `boundaryDepth()` compares depths, so a gap or a
 * duplicate silently changes which ancestors are in scope for inheritance.
 */
export async function checkFileHierarchyIntegrity(
  organizationId: string,
): Promise<FileHierarchyProblem[]> {
  const db = await getD1();
  const problems: FileHierarchyProblem[] = [];

  const rows = await db
    .select({ id: files.id, folderId: files.folderId })
    .from(files)
    .where(eq(files.organizationId, organizationId));

  const chains = new Map<string, Array<{ ancestorId: string; depth: number }>>();
  if (rows.length > 0) {
    const ancestorRows = await db
      .select({
        fileId: fileFolderAncestors.fileId,
        ancestorId: fileFolderAncestors.ancestorId,
        depth: fileFolderAncestors.depth,
      })
      .from(fileFolderAncestors)
      // A sub-select, not the ids just read: binding them is one parameter per file, and past
      // 999 SQLite refuses the statement outright — so the checker used to die on exactly the
      // large organizations where an integrity problem matters most. Found by the test that
      // sweeps 1200 files and then asks whether the result is intact.
      .where(
        inArray(
          fileFolderAncestors.fileId,
          db
            .select({ id: files.id })
            .from(files)
            .where(eq(files.organizationId, organizationId)),
        ),
      )
      .orderBy(asc(fileFolderAncestors.fileId), asc(fileFolderAncestors.depth));

    for (const row of ancestorRows) {
      const chain = chains.get(row.fileId);
      if (chain) chain.push(row);
      else chains.set(row.fileId, [row]);
    }
  }

  const folderRows = await db
    .select({ id: folders.id, organizationId: folders.organizationId })
    .from(folders);
  const organizationOf = new Map(folderRows.map((row) => [row.id, row.organizationId]));

  for (const file of rows) {
    const chain = chains.get(file.id) ?? [];

    if (chain.length === 0) {
      problems.push({
        kind: 'missing_ancestor_rows',
        fileId: file.id,
        detail: 'no ancestor rows at all',
      });
    } else if (chain.at(-1)!.ancestorId !== file.folderId) {
      problems.push({
        kind: 'folder_not_in_ancestors',
        fileId: file.id,
        detail: `folderId ${file.folderId} but deepest ancestor ${chain.at(-1)!.ancestorId}`,
      });
    }

    chain.forEach((entry, index) => {
      if (entry.depth !== index) {
        problems.push({
          kind: 'wrong_depth',
          fileId: file.id,
          detail: `ancestor ${entry.ancestorId} has depth ${entry.depth}, expected ${index}`,
        });
      }
    });

    if (!organizationOf.has(file.folderId)) {
      problems.push({
        kind: 'missing_folder',
        fileId: file.id,
        detail: `containing folder ${file.folderId} does not exist`,
      });
    }

    for (const entry of chain) {
      const owner = organizationOf.get(entry.ancestorId);
      if (owner === undefined) {
        problems.push({
          kind: 'missing_ancestor_rows',
          fileId: file.id,
          detail: `ancestor ${entry.ancestorId} does not exist`,
        });
      } else if (owner !== organizationId) {
        problems.push({
          kind: 'cross_organization_ancestor',
          fileId: file.id,
          detail: `ancestor ${entry.ancestorId} belongs to another organization`,
        });
      }
    }
  }

  const duplicates = await db
    .select({ driveId: fileVersions.googleDriveFileId, fileId: fileVersions.fileId })
    .from(fileVersions)
    .where(isNotNull(fileVersions.googleDriveFileId));

  const byDriveId = new Map<string, Set<string>>();
  for (const row of duplicates) {
    const key = row.driveId!;
    const set = byDriveId.get(key);
    if (set) set.add(row.fileId);
    else byDriveId.set(key, new Set([row.fileId]));
  }
  for (const [driveId, fileIds] of byDriveId) {
    if (fileIds.size > 1) {
      problems.push({
        kind: 'duplicate_drive_id',
        fileId: [...fileIds][0]!,
        detail: `Drive file ${driveId} is claimed by ${fileIds.size} files`,
      });
    }
  }

  return problems;
}

export const d1FileRepository: FileRepository = {
  findById,
  findByIds,
  listInFolder,
  listTrashed,
  search,
  listSharedWith,
  searchFacets,
  findRelated,
  projectContentBreakdown,
  existsWithName,
  takenNamesInFolder,
  findByChecksumInFolder,
  countInFolder,
  countForExperiment,
  findByIdInternal,
  findByIdsInternal,
  findByDriveFileIdInternal,
  findByChecksumInternal,
  findExpiredTrashInternal,
  newId,
  create,
  updateById,
  updateByIdWhere,
  setDeleted,
  setDeletedBySystem,
  setSubtreeDeleted,
  reparentSubtree,
  setSubtreeStatus,
  unlinkExperiment,
  purge,
  checkFileHierarchyIntegrity,
};
