/**
 * Read-only validation of the version graph, for Phase 5 migration preparation.
 *
 * ── Why this exists before the data moves ───────────────────────────────────────────────
 *
 * D1 enforces things MongoDB never did: `(file_id, version_number)` is unique, Drive ids are
 * unique where present, and `file_id`, `uploaded_by` and `restored_from_version_id` are foreign
 * keys. Production MongoDB has been accepting writes for years under none of those rules, so
 * the interesting question is not "will the import script run" but "which rows will it refuse,
 * and is each refusal a bug in the script or a fact about the data?"
 *
 * Running this against a D1 copy of the corpus answers that *before* a migration window rather
 * than during one, when the only options are to abort or to start editing production data at
 * speed.
 *
 * ── What it will not do ─────────────────────────────────────────────────────────────────
 *
 * **It never writes.** Every check is a SELECT. A validator that repaired what it found would
 * be making decisions — which of two duplicate version numbers is the real v3, whether a
 * version whose file is gone should be deleted or re-parented — that belong to a person who can
 * see the file, not to a sweep. It reports; somebody decides.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { files, fileVersions } from '@/server/db/schema/drive';

/**
 * One thing wrong with the stored version graph.
 *
 * `kind` is a stable machine-readable slug; `detail` is the sentence an operator reads. Both,
 * because the report is consumed by a script that groups and by a person who acts.
 */
export interface VersionProblem {
  kind:
    | 'duplicate_version_number'
    | 'missing_parent_file'
    | 'duplicate_drive_id'
    | 'current_version_of_other_file'
    | 'approved_version_of_other_file'
    | 'dangling_current_version'
    | 'dangling_approved_version'
    | 'version_number_gap'
    | 'missing_checksum'
    | 'organization_mismatch'
    | 'multiple_current_versions'
    | 'no_current_version';
  fileId: string | null;
  versionId: string | null;
  detail: string;
}

/** Every problem, or an empty list. Ordered by kind so a diff between runs is readable. */
export async function validateVersionGraph(organizationId?: string): Promise<VersionProblem[]> {
  const db = await getD1();
  const problems: VersionProblem[] = [];

  // Scope is optional so this can run per-organization during a staged migration or across the
  // whole corpus in a dry run.
  const inScope = organizationId
    ? sql`AND v.organization_id = ${organizationId}`
    : sql``;
  const filesInScope = organizationId
    ? sql`AND f.organization_id = ${organizationId}`
    : sql``;

  /**
   * Duplicate `(file_id, version_number)`.
   *
   * Impossible to insert into D1 and perfectly possible in MongoDB, which had no such index —
   * two concurrent uploads that both read "next is 4" produced two v4s and nothing complained.
   * This is the check most likely to find something.
   */
  const duplicates = await db.all<{ file_id: string; version_number: number; n: number }>(
    sql`SELECT v.file_id, v.version_number, count(*) AS n
          FROM file_versions v
         WHERE 1=1 ${inScope}
      GROUP BY v.file_id, v.version_number
        HAVING count(*) > 1`,
  );
  for (const row of duplicates) {
    problems.push({
      kind: 'duplicate_version_number',
      fileId: row.file_id,
      versionId: null,
      detail: `${row.n} versions share number ${row.version_number}; D1's unique index will reject all but one`,
    });
  }

  /** A version whose file is gone. A foreign key in D1; a dangling ObjectId in Mongo. */
  const orphans = await db.all<{ id: string; file_id: string }>(
    sql`SELECT v.id, v.file_id
          FROM file_versions v
     LEFT JOIN files f ON f.id = v.file_id
         WHERE f.id IS NULL ${inScope}`,
  );
  for (const row of orphans) {
    problems.push({
      kind: 'missing_parent_file',
      fileId: row.file_id,
      versionId: row.id,
      detail: `version references file ${row.file_id}, which does not exist`,
    });
  }

  /** Two versions claiming the same Drive object. Would apply one Drive edit to both. */
  const driveDuplicates = await db.all<{ google_drive_file_id: string; n: number }>(
    sql`SELECT v.google_drive_file_id, count(*) AS n
          FROM file_versions v
         WHERE v.google_drive_file_id IS NOT NULL ${inScope}
      GROUP BY v.google_drive_file_id
        HAVING count(*) > 1`,
  );
  for (const row of driveDuplicates) {
    problems.push({
      kind: 'duplicate_drive_id',
      fileId: null,
      versionId: null,
      detail: `Drive file ${row.google_drive_file_id} is claimed by ${row.n} versions; the change feed would refuse to choose`,
    });
  }

  /**
   * A file pointing at a version that belongs to a different file, or to nothing at all.
   *
   * Neither is expressible as a foreign key — `current_version_id` references `file_versions`,
   * which a version of *another* file satisfies perfectly well. So it has to be checked.
   */
  const crossPointers = await db.all<{
    id: string;
    current_version_id: string | null;
    approved_version_id: string | null;
    current_owner: string | null;
    approved_owner: string | null;
  }>(
    sql`SELECT f.id,
               f.current_version_id,
               f.approved_version_id,
               cv.file_id AS current_owner,
               av.file_id AS approved_owner
          FROM files f
     LEFT JOIN file_versions cv ON cv.id = f.current_version_id
     LEFT JOIN file_versions av ON av.id = f.approved_version_id
         WHERE (f.current_version_id IS NOT NULL OR f.approved_version_id IS NOT NULL)
           ${filesInScope}`,
  );
  for (const row of crossPointers) {
    if (row.current_version_id && row.current_owner === null) {
      problems.push({
        kind: 'dangling_current_version',
        fileId: row.id,
        versionId: row.current_version_id,
        detail: 'current_version_id names a version that does not exist',
      });
    } else if (row.current_version_id && row.current_owner !== row.id) {
      problems.push({
        kind: 'current_version_of_other_file',
        fileId: row.id,
        versionId: row.current_version_id,
        detail: `current_version_id belongs to file ${row.current_owner}`,
      });
    }

    if (row.approved_version_id && row.approved_owner === null) {
      problems.push({
        kind: 'dangling_approved_version',
        fileId: row.id,
        versionId: row.approved_version_id,
        detail: 'approved_version_id names a version that does not exist',
      });
    } else if (row.approved_version_id && row.approved_owner !== row.id) {
      problems.push({
        kind: 'approved_version_of_other_file',
        fileId: row.id,
        versionId: row.approved_version_id,
        detail: `approved_version_id belongs to file ${row.approved_owner} — an approval attributed to the wrong record`,
      });
    }
  }

  /**
   * Gaps and duplicates in the numbering of one file.
   *
   * Reported rather than repaired, and deliberately not treated as fatal: a gap is what a
   * hard-deleted version leaves behind, which may be entirely legitimate. What it must not do
   * is surprise the migration, so it is surfaced.
   */
  const numbering = await db.all<{ file_id: string; highest: number; n: number }>(
    sql`SELECT v.file_id, max(v.version_number) AS highest, count(*) AS n
          FROM file_versions v
         WHERE 1=1 ${inScope}
      GROUP BY v.file_id
        HAVING max(v.version_number) <> count(*)`,
  );
  for (const row of numbering) {
    problems.push({
      kind: 'version_number_gap',
      fileId: row.file_id,
      versionId: null,
      detail: `${row.n} versions but the highest number is ${row.highest}; the sequence is not contiguous`,
    });
  }

  /** A version with no checksum cannot be integrity-verified or approval-bound. */
  const missingChecksums = await db
    .select({ id: fileVersions.id, fileId: fileVersions.fileId })
    .from(fileVersions)
    .where(
      organizationId
        ? and(eq(fileVersions.organizationId, organizationId), eq(fileVersions.checksumSha256, ''))
        : eq(fileVersions.checksumSha256, ''),
    );
  for (const row of missingChecksums) {
    problems.push({
      kind: 'missing_checksum',
      fileId: row.fileId,
      versionId: row.id,
      detail: 'checksum_sha256 is empty; integrity and approval binding cannot be verified',
    });
  }

  /** A version filed under a different organization from its file. A tenancy leak if imported. */
  const mismatched = await db
    .select({ id: fileVersions.id, fileId: fileVersions.fileId })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(
      organizationId
        ? and(
            eq(fileVersions.organizationId, organizationId),
            ne(files.organizationId, fileVersions.organizationId),
          )
        : ne(files.organizationId, fileVersions.organizationId),
    );
  for (const row of mismatched) {
    problems.push({
      kind: 'organization_mismatch',
      fileId: row.fileId,
      versionId: row.id,
      detail: "version's organization differs from its file's — it would be visible to the wrong tenant",
    });
  }

  /**
   * Zero or several current versions for one file.
   *
   * The flag and the pointer are two representations of one truth (see the contract), and this
   * is the check that they agree with *themselves* before anything compares them to each other.
   */
  const currents = await db.all<{ file_id: string; n: number }>(
    sql`SELECT v.file_id, sum(CASE WHEN v.is_current = 1 THEN 1 ELSE 0 END) AS n
          FROM file_versions v
         WHERE 1=1 ${inScope}
      GROUP BY v.file_id
        HAVING n <> 1`,
  );
  for (const row of currents) {
    problems.push({
      kind: row.n === 0 ? 'no_current_version' : 'multiple_current_versions',
      fileId: row.file_id,
      versionId: null,
      detail:
        row.n === 0
          ? 'no version is marked current; the history exists but nothing is servable'
          : `${row.n} versions are marked current; the version list and the download would disagree`,
    });
  }

  return problems.sort((a, b) => a.kind.localeCompare(b.kind));
}

/** A count per kind, for a migration dry-run report that should fit on one screen. */
export async function summarizeVersionProblems(
  organizationId?: string,
): Promise<Record<string, number>> {
  const problems = await validateVersionGraph(organizationId);
  const summary: Record<string, number> = {};
  for (const problem of problems) summary[problem.kind] = (summary[problem.kind] ?? 0) + 1;
  return summary;
}

/** Also present on the D1 file version repository's siblings; kept here so the sweep is one import. */
export async function isVersionGraphClean(organizationId?: string): Promise<boolean> {
  return (await validateVersionGraph(organizationId)).length === 0;
}
