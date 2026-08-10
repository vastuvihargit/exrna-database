/**
 * The D1 experiment repository.
 *
 * ── Every read filters `deleted_at IS NULL` ─────────────────────────────────────────────
 *
 * `experiment.model.ts` calls `applySoftDeleteFilter`, so Mongoose silently added
 * `deletedAt: null` to every find, count and update. SQL has no such hook, so the predicate is
 * written out in each query — which is what `_shared.ts` said would happen and why this module
 * carries a test asserting a trashed experiment stays out of every listing.
 *
 * Note the contrast with `project.repository.d1.ts`, which must **not** filter: `project.model.ts`
 * does not apply the hook. Same module, opposite rule, both reproduced from what MongoDB does.
 *
 * ── Full-text search ────────────────────────────────────────────────────────────────────
 *
 * Mongo used a weighted `$text` index sorted by `$meta: 'textScore'`. The equivalent is FTS5
 * with `bm25()`. See `SEARCH_WEIGHTS` for the one thing that is easy to get wrong.
 */
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { inList } from '@/server/db/d1-bindings';
import type { BatchItem } from 'drizzle-orm/batch';
import { withBatch, type Database } from '@/server/db/d1';
import { getD1 } from '@/server/db/d1-context';
import {
  experiments,
  experimentCollaborators,
  experimentSamples,
} from '@/server/db/schema/research';
import { resourceTags } from '@/server/db/schema/drive';
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { ExperimentOutcome, ExperimentStatus } from '@/server/db/models';
import { toFtsQuery } from './fts-query';
import type {
  CreateExperimentInput,
  ExperimentPatch,
  ExperimentRecord,
  ExperimentRepository,
  ListExperimentsInput,
} from './experiment.repository.contract';

type ExperimentRow = typeof experiments.$inferSelect;

/**
 * `bm25()` takes **one weight per column of the FTS table, including the UNINDEXED one**.
 *
 * `experiments_fts` is `(experiment_id UNINDEXED, code, title, samples, objective)`, so five
 * weights are supplied and the first is a placeholder for a column that can never match.
 * Passing four — the intuitive "one per searchable column" — silently shifts every weight by
 * one position, which does not fail, it just ranks by the wrong field.
 */
const SEARCH_WEIGHTS = '0.0, 10.0, 8.0, 6.0, 1.0';

function nowIso(): string {
  return new Date().toISOString();
}

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Loads collaborators, samples and tags for a page of experiments in three queries. */
async function hydrate(db: Database, rows: ExperimentRow[]): Promise<ExperimentRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [collaboratorRows, sampleRows, tagRows] = await Promise.all([
    db
      .select({
        experimentId: experimentCollaborators.experimentId,
        userId: experimentCollaborators.userId,
      })
      .from(experimentCollaborators)
      .where(inList(experimentCollaborators.experimentId, ids))
      .orderBy(asc(experimentCollaborators.userId)),
    db
      .select({
        experimentId: experimentSamples.experimentId,
        sampleId: experimentSamples.sampleId,
      })
      .from(experimentSamples)
      .where(inList(experimentSamples.experimentId, ids))
      .orderBy(asc(experimentSamples.sampleId)),
    db
      .select({ resourceId: resourceTags.resourceId, tag: resourceTags.tag })
      .from(resourceTags)
      .where(
        and(eq(resourceTags.resourceType, 'experiment'), inList(resourceTags.resourceId, ids)),
      )
      .orderBy(asc(resourceTags.tag)),
  ]);

  const group = <T>(source: T[], key: (row: T) => string, value: (row: T) => string) => {
    const map = new Map<string, string[]>();
    for (const row of source) {
      const list = map.get(key(row));
      if (list) list.push(value(row));
      else map.set(key(row), [value(row)]);
    }
    return map;
  };

  const collaborators = group(
    collaboratorRows,
    (row) => row.experimentId,
    (row) => row.userId,
  );
  const samples = group(
    sampleRows,
    (row) => row.experimentId,
    (row) => row.sampleId,
  );
  const tags = group(
    tagRows,
    (row) => row.resourceId,
    (row) => row.tag,
  );

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    departmentId: row.departmentId ?? null,
    code: row.code,
    title: row.title,
    objective: row.objective ?? '',
    status: row.status as ExperimentStatus,
    outcome: row.outcome as ExperimentOutcome,
    outcomeSummary: row.outcomeSummary ?? '',
    leadUserId: row.leadUserId ?? null,
    collaboratorUserIds: collaborators.get(row.id) ?? [],
    protocolRef: row.protocolRef ?? '',
    instrumentRef: row.instrumentRef ?? '',
    organism: row.organism ?? '',
    sampleIds: samples.get(row.id) ?? [],
    startedOn: toDate(row.startedOn),
    completedOn: toDate(row.completedOn),
    folderId: row.folderId ?? null,
    confidentiality: row.confidentiality as ConfidentialityLevel,
    tags: tags.get(row.id) ?? [],
    fileCount: row.fileCount ?? 0,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }));
}

/** The soft-delete predicate Mongoose applied invisibly. */
const live = () => isNull(experiments.deletedAt);

/* ------------------------------------------------------------------ reads */

export async function findById(id: string): Promise<ExperimentRecord | null> {
  if (!id) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.id, id), live()))
    .limit(1);
  if (!row) return null;
  const [record] = await hydrate(db, [row]);
  return record ?? null;
}

export async function findByIds(ids: string[]): Promise<ExperimentRecord[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const db = await getD1();
  const rows = await db
    .select()
    .from(experiments)
    .where(and(inList(experiments.id, unique), live()));
  return hydrate(db, rows);
}

export async function findByCode(
  organizationId: string,
  code: string,
): Promise<ExperimentRecord | null> {
  if (!organizationId) return null;
  const db = await getD1();
  const [row] = await db
    .select()
    .from(experiments)
    .where(
      and(
        eq(experiments.organizationId, organizationId),
        eq(experiments.code, code.toUpperCase()),
        live(),
      ),
    )
    .limit(1);
  if (!row) return null;
  const [record] = await hydrate(db, [row]);
  return record ?? null;
}

export async function list(
  input: ListExperimentsInput,
): Promise<{ items: ExperimentRecord[]; total: number }> {
  if (!input.organizationId) return { items: [], total: 0 };

  const projectIds = input.projectIds.filter(Boolean);
  // An empty visible-project set means "nothing", never "everything".
  if (projectIds.length === 0) return { items: [], total: 0 };

  const db = await getD1();

  const predicates: SQL[] = [
    eq(experiments.organizationId, input.organizationId),
    inList(experiments.projectId, projectIds),
    live(),
  ];
  if (input.status) predicates.push(eq(experiments.status, input.status));
  if (input.sampleId) {
    predicates.push(
      sql`${experiments.id} IN (SELECT ${experimentSamples.experimentId} FROM ${experimentSamples} WHERE ${experimentSamples.sampleId} = ${input.sampleId})`,
    );
  }
  const ftsQuery = input.text ? toFtsQuery(input.text) : null;
  if (input.text && !ftsQuery) {
    // The caller asked to search for something, and nothing searchable survived sanitizing.
    // "No results" is the honest answer; dropping the filter would return everything.
    return { items: [], total: 0 };
  }
  if (ftsQuery) {
    predicates.push(
      sql`${experiments.id} IN (SELECT experiment_id FROM experiments_fts WHERE experiments_fts MATCH ${ftsQuery})`,
    );
  }

  const where = and(...predicates);
  const offset = (input.page - 1) * input.pageSize;

  // Relevance order when searching, code order otherwise — matching the Mongo `$meta` sort.
  const order = ftsQuery
    ? sql`(SELECT bm25(experiments_fts, ${sql.raw(SEARCH_WEIGHTS)}) FROM experiments_fts
             WHERE experiments_fts MATCH ${ftsQuery} AND experiment_id = ${experiments.id}) ASC`
    : sql`${experiments.code} ASC`;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(experiments)
      .where(where)
      .orderBy(order)
      .limit(input.pageSize)
      .offset(offset),
    db.select({ value: sql<number>`count(*)` }).from(experiments).where(where),
  ]);

  return { items: await hydrate(db, rows), total: Number(totals[0]?.value ?? 0) };
}

export async function listForProject(
  projectId: string,
  limit = 200,
): Promise<ExperimentRecord[]> {
  if (!projectId) return [];
  const db = await getD1();
  const rows = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.projectId, projectId), live()))
    .orderBy(asc(experiments.code))
    .limit(limit);
  return hydrate(db, rows);
}

export async function countByStatusForProject(
  projectId: string,
): Promise<Record<string, number>> {
  if (!projectId) return {};
  const db = await getD1();
  const rows = await db
    .select({ status: experiments.status, count: sql<number>`count(*)` })
    .from(experiments)
    .where(and(eq(experiments.projectId, projectId), live()))
    .groupBy(experiments.status);

  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.status) out[row.status] = Number(row.count);
  }
  return out;
}

/* ------------------------------------------------------------------ writes */

/**
 * Re-writes the FTS row for one experiment.
 *
 * ── Why this runs *after* the batch, not inside it ──────────────────────────────────────
 *
 * Two reasons, and the second is the one that matters.
 *
 * 1. `db.run(sql…)` is not a valid `batch()` item — D1 batches take prepared statements built
 *    by the query builder.
 * 2. Even if it were, it would be wrong. The batch contains the base-row `UPDATE`, which fires
 *    `trg_experiments_fts_update`, which re-aggregates `experiment_samples` — and at that point
 *    in the batch the new sample rows have not been written yet. The index would be rebuilt
 *    from the samples the experiment *used to* have.
 *
 * So the batch guarantees the data and this runs immediately afterwards. If it fails, the
 * search index is stale while the records are correct — which is the right way round, and is
 * the state Phase 4's `SYNC_QUEUE` consumer exists to repair.
 *
 * This is the "explicit re-index statement" Phase 2 carried forward. It is also what makes a
 * brand-new experiment findable by sample id at all: `trg_experiments_fts_insert` writes
 * `samples` as `''`, because sample rows are written after the parent.
 */
async function reindex(db: Database, experimentId: string): Promise<void> {
  await db.run(sql`DELETE FROM experiments_fts WHERE experiment_id = ${experimentId}`);
  await db.run(sql`
    INSERT INTO experiments_fts (experiment_id, code, title, samples, objective)
    SELECT e.id, e.code, e.title,
           COALESCE((SELECT group_concat(sample_id, ' ') FROM experiment_samples
                      WHERE experiment_id = e.id), ''),
           e.objective
      FROM experiments e
     WHERE e.id = ${experimentId} AND e.deleted_at IS NULL
  `);
}

function childStatements(
  db: Database,
  input: {
    experimentId: string;
    organizationId: string;
    collaboratorUserIds?: string[];
    sampleIds?: string[];
    tags?: string[];
  },
): BatchItem<'sqlite'>[] {
  const statements: BatchItem<'sqlite'>[] = [];
  const { experimentId, organizationId } = input;

  if (input.collaboratorUserIds !== undefined) {
    statements.push(
      db
        .delete(experimentCollaborators)
        .where(eq(experimentCollaborators.experimentId, experimentId)),
    );
    for (const userId of [...new Set(input.collaboratorUserIds.filter(Boolean))]) {
      statements.push(db.insert(experimentCollaborators).values({ experimentId, userId }));
    }
  }

  if (input.sampleIds !== undefined) {
    statements.push(
      db.delete(experimentSamples).where(eq(experimentSamples.experimentId, experimentId)),
    );
    for (const sampleId of [...new Set(input.sampleIds.filter(Boolean))]) {
      statements.push(db.insert(experimentSamples).values({ experimentId, sampleId }));
    }
  }

  if (input.tags !== undefined) {
    statements.push(
      db
        .delete(resourceTags)
        .where(
          and(
            eq(resourceTags.resourceType, 'experiment'),
            eq(resourceTags.resourceId, experimentId),
          ),
        ),
    );
    for (const tag of [...new Set(input.tags.filter(Boolean))]) {
      statements.push(
        db.insert(resourceTags).values({
          organizationId,
          resourceType: 'experiment',
          resourceId: experimentId,
          tag,
        }),
      );
    }
  }

  return statements;
}

export async function create(input: CreateExperimentInput): Promise<ExperimentRecord> {
  const db = await getD1();
  const id = crypto.randomUUID();
  const now = nowIso();

  const statements: BatchItem<'sqlite'>[] = [
    db.insert(experiments).values({
      id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      departmentId: input.departmentId,
      code: input.code.toUpperCase(),
      title: input.title,
      objective: input.objective ?? '',
      status: input.status ?? 'planned',
      outcome: input.outcome ?? 'pending',
      outcomeSummary: '',
      leadUserId: input.leadUserId ?? null,
      protocolRef: input.protocolRef ?? '',
      instrumentRef: input.instrumentRef ?? '',
      organism: input.organism ?? '',
      startedOn: iso(input.startedOn),
      completedOn: iso(input.completedOn),
      folderId: input.folderId ?? null,
      confidentiality: input.confidentiality,
      fileCount: 0,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }),
    ...childStatements(db, {
      experimentId: id,
      organizationId: input.organizationId,
      collaboratorUserIds: input.collaboratorUserIds ?? [],
      sampleIds: input.sampleIds ?? [],
      tags: input.tags ?? [],
    }),
  ];

  await withBatch(db, statements);
  await reindex(db, id);

  const created = await findById(id);
  if (!created) throw new Error(`Experiment ${id} disappeared immediately after insert`);
  return created;
}

function toColumns(patch: ExperimentPatch): Partial<typeof experiments.$inferInsert> {
  const columns: Partial<typeof experiments.$inferInsert> = {};

  if (patch.title !== undefined) columns.title = patch.title;
  if (patch.objective !== undefined) columns.objective = patch.objective;
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.outcome !== undefined) columns.outcome = patch.outcome;
  if (patch.outcomeSummary !== undefined) columns.outcomeSummary = patch.outcomeSummary;
  if (patch.leadUserId !== undefined) columns.leadUserId = patch.leadUserId;
  if (patch.protocolRef !== undefined) columns.protocolRef = patch.protocolRef;
  if (patch.instrumentRef !== undefined) columns.instrumentRef = patch.instrumentRef;
  if (patch.organism !== undefined) columns.organism = patch.organism;
  if (patch.startedOn !== undefined) columns.startedOn = iso(patch.startedOn);
  if (patch.completedOn !== undefined) columns.completedOn = iso(patch.completedOn);
  if (patch.folderId !== undefined) columns.folderId = patch.folderId;
  if (patch.confidentiality !== undefined) columns.confidentiality = patch.confidentiality;
  if (patch.departmentId !== undefined) columns.departmentId = patch.departmentId;
  if (patch.updatedBy !== undefined) columns.updatedBy = patch.updatedBy;

  return columns;
}

export async function updateById(
  id: string,
  patch: ExperimentPatch,
): Promise<ExperimentRecord | null> {
  if (!id) return null;
  const db = await getD1();

  // Matches the Mongoose hook: an update never touches a soft-deleted row.
  const existing = await db
    .select({ organizationId: experiments.organizationId })
    .from(experiments)
    .where(and(eq(experiments.id, id), live()))
    .limit(1);
  if (existing.length === 0) return null;

  const columns = toColumns(patch);
  const statements: BatchItem<'sqlite'>[] = [];

  if (Object.keys(columns).length > 0) {
    statements.push(
      db
        .update(experiments)
        .set({ ...columns, updatedAt: nowIso() })
        .where(eq(experiments.id, id)),
    );
  }
  statements.push(
    ...childStatements(db, {
      experimentId: id,
      organizationId: existing[0]!.organizationId,
      ...(patch.collaboratorUserIds !== undefined
        ? { collaboratorUserIds: patch.collaboratorUserIds }
        : {}),
      ...(patch.sampleIds !== undefined ? { sampleIds: patch.sampleIds } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    }),
  );

  if (statements.length > 0) await withBatch(db, statements);
  // Always, not only when the base row changed: a samples-only edit must still re-index, and
  // the trigger cannot see sample rows the same batch is about to write.
  await reindex(db, id);

  return findById(id);
}

export async function adjustFileCount(id: string, delta: number): Promise<void> {
  if (!id || delta === 0) return;
  const db = await getD1();
  await db
    .update(experiments)
    .set({ fileCount: sql`${experiments.fileCount} + ${delta}`, updatedAt: nowIso() })
    .where(and(eq(experiments.id, id), live()));
}

export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  if (!id) return false;
  const db = await getD1();
  const now = nowIso();

  const updated = await db
    .update(experiments)
    .set({ deletedAt: now, deletedBy, status: 'archived', updatedAt: now })
    .where(and(eq(experiments.id, id), live()))
    .returning({ id: experiments.id });

  // The FTS update trigger re-inserts only `WHERE deleted_at IS NULL`, so a trashed experiment
  // leaves the index rather than being filtered out of it at query time.
  return updated.length > 0;
}

export const d1ExperimentRepository: ExperimentRepository = {
  findById,
  findByIds,
  findByCode,
  list,
  listForProject,
  create,
  updateById,
  adjustFileCount,
  softDelete,
  countByStatusForProject,
};
