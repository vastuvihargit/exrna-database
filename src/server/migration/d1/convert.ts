/**
 * MongoDB values → the SQLite representations `schema/_shared.ts` fixed.
 *
 * Every conversion here is deliberately strict about the difference between "absent" and
 * "empty". A migration that turns a missing `expiresAt` into the epoch, or a null owner into
 * the empty string, produces a database that looks migrated and answers questions wrongly —
 * and the wrong answers are indistinguishable from real data afterwards.
 */
import type { SqlValue } from './types';

/**
 * An ObjectId (or anything id-shaped) as the TEXT primary key D1 holds.
 *
 * Accepts a Mongo `ObjectId`, a string, or a populated document with `_id`, because `.lean()`
 * output varies by whether a `populate` was in play. Returns `null` for absent — never `''`,
 * which would satisfy a NOT NULL column while pointing at nothing.
 */
export function oid(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'object') {
    const candidate = value as { _id?: unknown; toHexString?: () => string };
    if (typeof candidate.toHexString === 'function') return candidate.toHexString();
    if (candidate._id !== undefined) return oid(candidate._id);
  }
  const text = String(value);
  return text.length > 0 && text !== 'null' && text !== 'undefined' ? text : null;
}

/** Same, but for a column that must not be null. Throws so the record becomes a failure. */
export function requiredOid(value: unknown, field: string): string {
  const id = oid(value);
  if (id === null) throw new Error(`${field} is required but the source document has no value`);
  return id;
}

export function oidList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    const id = oid(item);
    if (id !== null) ids.push(id);
  }
  return ids;
}

/**
 * A Date as ISO-8601 UTC with milliseconds — exactly `Date.prototype.toISOString()`.
 *
 * Strings are re-parsed rather than passed through: a source value that is already a string is
 * usually right, but "usually" in a migration means "a column that sorts wrongly for the subset
 * of rows that came from somewhere else".
 */
export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export function requiredIso(value: unknown, fallback: string): string {
  return iso(value) ?? fallback;
}

/** SQLite has no boolean. `INTEGER` 0/1, and only an explicit `true` is 1. */
export function bool(value: unknown): number {
  return value === true || value === 1 || value === '1' ? 1 : 0;
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** A NOT NULL TEXT column with a default. Nullish and non-strings become the default. */
export function str(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  return String(value);
}

/** A nullable TEXT column. Empty strings stay empty — they are a value somebody chose. */
export function nullableStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

/**
 * A `Mixed` field as the JSON text D1 stores.
 *
 * `undefined` becomes the fallback rather than the string "undefined", which is what
 * `JSON.stringify` would produce for a bare undefined and which would then parse as garbage on
 * the way back out.
 */
export function json(value: unknown, fallback = 'null'): string {
  if (value === undefined) return fallback;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? fallback : text;
  } catch {
    return fallback;
  }
}

/** A JSON *array* column (`email_domains`, `actor_role_keys`). Non-arrays become `[]`. */
export function jsonArray(value: unknown): string {
  if (!Array.isArray(value)) return '[]';
  return JSON.stringify(value.map((item) => (typeof item === 'string' ? item : String(item))));
}

/**
 * Constrains a value to an enum the D1 column declares, falling back rather than failing.
 *
 * Enum columns in D1 are `TEXT` with a `CHECK`, so an unexpected value aborts the statement —
 * and because statements run in batches, it takes the whole batch with it. A value outside the
 * enum in production data is a data-quality problem, not a reason to lose 499 other records, so
 * it lands on the default and the record is reported.
 */
export function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Nullable enum: absent stays absent, an unknown value is also treated as absent. */
export function nullableEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * A deterministic id for a row MongoDB never gave one.
 *
 * Embedded sub-documents — ACL entries, inventory batches, auth providers — are declared
 * `{ _id: false }`, so the migration has to mint the primary key. It **must** be derived from
 * the content rather than random: a re-run has to produce the same id, or the delta pass writes
 * a second copy of every child row instead of replacing the first.
 *
 * FNV-1a over the parts, hex, prefixed with the parent id. Not a cryptographic hash and does
 * not need to be — collisions would have to occur within a single parent, and the parts always
 * include whatever MongoDB itself considered unique for that sub-document.
 */
export function derivedId(prefix: string, ...parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2f; // a separator, so ("ab","c") and ("a","bc") differ
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}${hash.toString(16).padStart(8, '0')}`;
}

export type { SqlValue };
