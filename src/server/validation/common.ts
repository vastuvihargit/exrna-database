import { z } from 'zod';
import { Types } from 'mongoose';

/**
 * A resource identifier supplied by a client — in either of the two shapes this system mints.
 *
 * ── Why this accepts a UUID, and why it had to ──────────────────────────────────────────
 *
 * It used to accept only 24 hex characters, which was right while MongoDB was the only store.
 * It is a **cutover blocker** now: every D1 repository mints `crypto.randomUUID()`, so the
 * moment a module is switched to D1, every resource created after the switch has an id this
 * schema rejects. The failure is not subtle but it is misleading — a 422 reading "Invalid
 * identifier" on a folder the user just created, from a route that never reached the database.
 *
 * Migrated rows keep their ObjectId (Phase 9 preserves them as TEXT), so both shapes are live in
 * the same table at the same time and both have to pass. There is no cutover ordering that
 * avoids it.
 *
 * ── Why this is not simply `z.string()` ─────────────────────────────────────────────────
 *
 * The format check is load-bearing in two places, and dropping it would weaken both:
 *
 *   • `Types.ObjectId.isValid()` returns true for *any* 12-character string, so the regex — not
 *     the mongoose call — is what stops `../../etc` and similar from being carried into a query
 *     builder as a plausible id.
 *   • Repository methods branch on `Types.ObjectId.isValid(id)` and return `null` for anything
 *     else. A value that is neither shape reaching that branch is indistinguishable from a
 *     legitimate miss, which turns a malformed request into a 404 instead of a 422.
 *
 * Both alternatives are anchored, fixed-length and character-restricted, so the guarantee the
 * old schema provided is unchanged: what comes out is inert text of a known shape.
 */
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isResourceId(value: string): boolean {
  if (UUID.test(value)) return true;
  return OBJECT_ID.test(value) && Types.ObjectId.isValid(value);
}

export const objectIdSchema = z.string().refine(isResourceId, { message: 'Invalid identifier' });

/** Page/pageSize with hard caps — an unbounded page size is a denial-of-service lever. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const sortSchema = z.object({
  sort: z.string().max(40).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

/** Free-text search, length-capped and never used as a raw regex downstream. */
export const searchSchema = z.object({
  search: z.string().trim().min(1).max(80).optional(),
});

/** Parses URLSearchParams with a schema, returning typed values. */
export function parseQuery<T extends z.ZodTypeAny>(schema: T, url: string): z.infer<T> {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  return schema.parse(params) as z.infer<T>;
}

export type Pagination = z.infer<typeof paginationSchema>;
