/**
 * Conventions every D1 table follows.
 *
 * These are not style preferences. Each one exists because the migration has to move
 * existing production data without altering it, and a convention that varied per table would
 * mean a transform that varied per table.
 *
 * ── Identifiers ─────────────────────────────────────────────────────────────────────────
 *
 * Every primary key is `TEXT` holding the **24-character hex string of the existing MongoDB
 * ObjectId, unchanged**. Not a new UUID, not an INTEGER rowid.
 *
 * That single decision is what makes the migration verifiable and the rollback real:
 *   • a record's identity is the same in both databases, so a count or a spot-check compares
 *     directly rather than through a mapping table;
 *   • `googleDriveFileId` → version → file relationships survive without rewriting;
 *   • every id already embedded in an audit-log row, a notification, a saved search or a
 *     bookmarked URL keeps resolving.
 *
 * ObjectId hex also sorts monotonically by creation time, which is what lets the Phase 5
 * migration use `WHERE id > :last_id` as a stable resume cursor.
 *
 * Rows created *after* the cutover use `crypto.randomUUID()`, which is 36 characters. Both
 * shapes coexist in the same column deliberately — the alternative is minting fake ObjectIds
 * forever, which would make "was this row migrated or created?" unanswerable.
 *
 * ── Timestamps ──────────────────────────────────────────────────────────────────────────
 *
 * `TEXT` holding ISO-8601 UTC (`2026-08-05T09:55:45.059Z`), not a Unix integer.
 *
 * SQLite has no date type, so the choice is what to store in its place. ISO-8601 strings sort
 * lexicographically in the same order they sort chronologically, so `ORDER BY created_at DESC`
 * and `WHERE expires_at > ?` both work with no conversion — and, unlike an integer, a row
 * read straight out of `wrangler d1 execute` during an incident is legible to the person
 * reading it. Millisecond precision is preserved, which matters for the audit log.
 *
 * ── Booleans ────────────────────────────────────────────────────────────────────────────
 *
 * `INTEGER` 0/1 with `mode: 'boolean'`. SQLite has no boolean type.
 *
 * ── JSON ────────────────────────────────────────────────────────────────────────────────
 *
 * `TEXT` holding `JSON.stringify` output, used only where MongoDB held a `Mixed` field that
 * is read as a whole and never queried into. Anything filtered, joined or indexed became a
 * child table instead — see `docs/cloudflare-migration/00-phase-0-analysis.md` §3.2.
 */
import { sql } from 'drizzle-orm';
import { integer, text } from 'drizzle-orm/sqlite-core';

/** ISO-8601 UTC, matching what `Date.prototype.toISOString()` produces. */
export const nowSql = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/**
 * `createdAt` / `updatedAt`, matching Mongoose's `timestamps: true`.
 *
 * Defaults are declared so a row inserted by hand during an incident is still well-formed.
 * The application always writes both explicitly; the migration writes the values MongoDB
 * already held, never `now`.
 */
export const timestampColumns = {
  createdAt: text('created_at').notNull().default(nowSql),
  updatedAt: text('updated_at').notNull().default(nowSql),
};

/** `createdAt` only — for the append-only tables that have no update path at all. */
export const createdAtColumn = {
  createdAt: text('created_at').notNull().default(nowSql),
};

/**
 * Soft delete, mirroring `softDeleteFields` in `base-schema.ts`.
 *
 * Note what is *not* reproduced here: Mongoose's `applySoftDeleteFilter` pre-hook, which
 * silently added `deletedAt: null` to every query. SQL has no equivalent hook, and inventing
 * one inside the repository layer would be worse than not having it — an invisible filter
 * that a reader of the query cannot see. In D1 the condition is written out in each query,
 * and Phase 3 carries a test per module asserting trashed rows stay out of ordinary listings.
 */
export const softDeleteColumns = {
  deletedAt: text('deleted_at'),
  deletedBy: text('deleted_by'),
};

/** Convenience for the many nullable-boolean-with-default-false columns. */
export const boolean = (name: string) => integer(name, { mode: 'boolean' });

/** Enumerations are stored as TEXT and constrained by the application, as in MongoDB. */
export const enumText = <T extends readonly string[]>(name: string, values: T) =>
  text(name, { enum: values as unknown as [T[number], ...T[number][]] });
