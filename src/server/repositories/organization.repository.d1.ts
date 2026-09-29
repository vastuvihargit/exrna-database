/**
 * The D1 organization repository.
 *
 * ── `email_domains` and `settings` are JSON columns, and malformed JSON must not 500 ────
 *
 * Both columns hold `JSON.stringify` output. A row written by the migration, by the seed script
 * or by hand during an incident could in principle hold something that does not parse, and the
 * consequence of throwing here is disproportionate: `getPrimary()` is called on the login path
 * and by `getSignInDomains`, so a single bad character in one column would take authentication
 * down for everyone rather than degrade one setting.
 *
 * `parseJson` therefore falls back to the empty object, which `normalizeSettings` turns into the
 * documented defaults. The failure mode is a setting reverting to its default — visible,
 * recoverable, and not an outage. Note the asymmetry that makes this safe: every default in
 * `normalizeSettings` is the *restrictive* one (no auto-provisioning, no self-approval, empty
 * allow-lists), so a parse failure never widens access.
 *
 * ── Soft delete is written out ──────────────────────────────────────────────────────────
 *
 * Mongoose applied `deletedAt: null` invisibly via a pre-hook. D1 has no such hook and the
 * project's convention is to spell the condition out — see `schema/_shared.ts`. The MongoDB
 * implementation relies on the hook for this, so both engines exclude soft-deleted rows; only
 * one of them says so in the query.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getD1 } from '@/server/db/d1-context';
import { organizations } from '@/server/db/schema/identity';
import {
  normalizeSettings,
  type OrganizationRecord,
  type OrganizationRepository,
} from './organization.repository.contract';

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  emailDomains: string;
  settings: string;
  storageUsedBytes: number;
  isActive: boolean;
}

const recordColumns = {
  id: organizations.id,
  name: organizations.name,
  slug: organizations.slug,
  emailDomains: organizations.emailDomains,
  settings: organizations.settings,
  storageUsedBytes: organizations.storageUsedBytes,
  isActive: organizations.isActive,
} as const;

/** Never throws. See the header: every fallback is the restrictive one. */
function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toRecord(row: OrganizationRow): OrganizationRecord {
  const domains = parseJson(row.emailDomains);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    emailDomains: Array.isArray(domains)
      ? domains.filter((entry): entry is string => typeof entry === 'string')
      : [],
    settings: normalizeSettings(parseJson(row.settings)),
    storageUsedBytes: row.storageUsedBytes ?? 0,
    isActive: Boolean(row.isActive),
  };
}

export async function getPrimary(): Promise<OrganizationRecord | null> {
  const db = await getD1();
  const [row] = await db
    .select(recordColumns)
    .from(organizations)
    .where(and(eq(organizations.isActive, true), isNull(organizations.deletedAt)))
    // Oldest first, matching Mongo's `sort({ createdAt: 1 })`. `id` breaks the tie: ObjectId
    // hex sorts by creation time, so the tiebreak agrees with the primary sort rather than
    // fighting it, and the single-tenant answer is the same row on every call.
    .orderBy(asc(organizations.createdAt), asc(organizations.id))
    .limit(1);

  return row ? toRecord(row as OrganizationRow) : null;
}

export async function findById(id: string): Promise<OrganizationRecord | null> {
  const db = await getD1();
  const [row] = await db
    .select(recordColumns)
    .from(organizations)
    .where(and(eq(organizations.id, id), isNull(organizations.deletedAt)))
    .limit(1);

  return row ? toRecord(row as OrganizationRow) : null;
}

export const d1OrganizationRepository: OrganizationRepository = {
  getPrimary,
  findById,
};
