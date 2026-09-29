/**
 * Reconciling MongoDB's ACL arrays with D1's one-entry-per-principal rule.
 *
 * ── The difference ──────────────────────────────────────────────────────────────────────
 *
 * MongoDB stores `permissions[]` as an embedded array with **no uniqueness**. Nothing in the
 * schema stops a folder carrying two entries for the same principal — an allow and a deny, or
 * two different access levels. The sharing service replaces an existing entry on re-share, so
 * in the normal course of events duplicates do not arise; but "the service is careful" is not
 * the same as "the data cannot be that shape", and this database has been in production.
 *
 * D1's `ux_resource_permissions (resource_type, resource_id, principal_type, principal_id)`
 * makes one entry per principal a **constraint**. A Phase 5 migration that simply copied the
 * array would therefore fail on the duplicate, or — worse, if written to tolerate the failure
 * — would insert whichever entry happened to come first and silently discard the rest. If the
 * discarded one is a deny, that is a migration that grants access nobody granted.
 *
 * So the resolution has to be deterministic, stated in advance, and recorded per row.
 *
 * ── The rules ───────────────────────────────────────────────────────────────────────────
 *
 *   1. An **expired** entry contributes nothing — it neither grants nor denies. This matches
 *      `aclGrants()`, which skips an expired entry before it looks at anything else.
 *   2. Among what remains, a **live denial wins**, whatever else is present. This matches
 *      `canAccess` step 4, where deny precedes every allow including super admin.
 *   3. Otherwise the **strongest live allow** wins, by `ACCESS_LEVELS` order.
 *   4. If nothing is live, the principal gets **no entry at all** rather than an expired one
 *      carried forward.
 *
 * Rule 2 before rule 3 is the safety-critical ordering: the alternative would let a stale
 * `manager` grant outrank a deliberate denial.
 *
 * This module only *decides*. It does not write to MongoDB — see `scripts/validate-acl-uniqueness.ts`.
 */
import { ACCESS_LEVELS } from '@/server/domain/permissions';

export interface AclEntryLike {
  principalType: string;
  principalId: string;
  accessLevel: string;
  deny?: boolean;
  expiresAt?: Date | null;
}

export type AclConflictKind =
  | 'duplicate_principal'
  | 'allow_and_deny'
  | 'conflicting_access_levels'
  | 'duplicate_expired';

export interface AclConflict {
  principalType: string;
  principalId: string;
  kinds: AclConflictKind[];
  entryCount: number;
  /** What the rules above select. `null` means every entry was expired. */
  resolved: AclEntryLike | null;
  /** Entries the resolution drops, so the migration report can list them verbatim. */
  discarded: AclEntryLike[];
}

function isLive(entry: AclEntryLike, now: number): boolean {
  return !entry.expiresAt || entry.expiresAt.getTime() > now;
}

function strength(level: string): number {
  const index = (ACCESS_LEVELS as readonly string[]).indexOf(level);
  // An unrecognised level is treated as the weakest rather than the strongest: an unknown
  // value must never win a comparison it might not deserve.
  return index === -1 ? -1 : index;
}

function principalKey(entry: AclEntryLike): string {
  return `${entry.principalType}:${entry.principalId}`;
}

/**
 * Applies the rules to one principal's entries.
 *
 * Exported so the Phase 5 migration and this validator cannot drift — the report a human
 * reviews and the value the migration writes come from the same function.
 */
export function resolveEntries(entries: AclEntryLike[], now = Date.now()): AclEntryLike | null {
  const live = entries.filter((entry) => isLive(entry, now));
  if (live.length === 0) return null;

  const denial = live.find((entry) => entry.deny === true);
  if (denial) return denial;

  return live.reduce((best, entry) =>
    strength(entry.accessLevel) > strength(best.accessLevel) ? entry : best,
  );
}

/** Every principal on one resource whose entries need resolving. Empty when the ACL is clean. */
export function findAclConflicts(
  entries: AclEntryLike[],
  now = Date.now(),
): AclConflict[] {
  const byPrincipal = new Map<string, AclEntryLike[]>();
  for (const entry of entries) {
    const key = principalKey(entry);
    const list = byPrincipal.get(key);
    if (list) list.push(entry);
    else byPrincipal.set(key, [entry]);
  }

  const conflicts: AclConflict[] = [];

  for (const group of byPrincipal.values()) {
    if (group.length < 2) continue;

    const kinds: AclConflictKind[] = ['duplicate_principal'];
    const live = group.filter((entry) => isLive(entry, now));

    if (live.some((entry) => entry.deny === true) && live.some((entry) => entry.deny !== true)) {
      kinds.push('allow_and_deny');
    }
    const liveAllowLevels = new Set(
      live.filter((entry) => entry.deny !== true).map((entry) => entry.accessLevel),
    );
    if (liveAllowLevels.size > 1) kinds.push('conflicting_access_levels');
    if (group.length - live.length > 0) kinds.push('duplicate_expired');

    const resolved = resolveEntries(group, now);
    conflicts.push({
      principalType: group[0]!.principalType,
      principalId: group[0]!.principalId,
      kinds,
      entryCount: group.length,
      resolved,
      discarded: group.filter((entry) => entry !== resolved),
    });
  }

  return conflicts;
}
