/**
 * The rules that decide what a MongoDB ACL array becomes in D1.
 *
 * Ordering is the safety-critical part: a live denial must beat every allow, and it must beat
 * them *before* strength is considered, or a stale `manager` grant would outrank a deliberate
 * denial. Pure logic, so no database is involved.
 */
import { describe, expect, it } from 'vitest';
import { findAclConflicts, resolveEntries, type AclEntryLike } from '@/server/permissions/acl-normalization';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const PAST = new Date(NOW - 3_600_000);
const FUTURE = new Date(NOW + 3_600_000);

function entry(over: Partial<AclEntryLike> = {}): AclEntryLike {
  return { principalType: 'user', principalId: 'u1', accessLevel: 'viewer', deny: false, expiresAt: null, ...over };
}

describe('resolveEntries', () => {
  it('prefers a live denial over any allow, however strong', () => {
    const resolved = resolveEntries([entry({ accessLevel: 'manager' }), entry({ deny: true })], NOW);
    expect(resolved?.deny).toBe(true);
  });

  it('ignores an expired denial, so a live allow wins', () => {
    const resolved = resolveEntries([entry({ deny: true, expiresAt: PAST }), entry({ accessLevel: 'editor' })], NOW);
    expect(resolved?.deny).toBe(false);
    expect(resolved?.accessLevel).toBe('editor');
  });

  it('chooses the strongest live allow', () => {
    const resolved = resolveEntries(
      [entry({ accessLevel: 'viewer' }), entry({ accessLevel: 'manager' }), entry({ accessLevel: 'commenter' })],
      NOW,
    );
    expect(resolved?.accessLevel).toBe('manager');
  });

  it('does not let an expired strong allow beat a live weak one', () => {
    const resolved = resolveEntries(
      [entry({ accessLevel: 'manager', expiresAt: PAST }), entry({ accessLevel: 'viewer', expiresAt: FUTURE })],
      NOW,
    );
    expect(resolved?.accessLevel).toBe('viewer');
  });

  it('returns nothing when every entry has expired', () => {
    expect(resolveEntries([entry({ expiresAt: PAST }), entry({ deny: true, expiresAt: PAST })], NOW)).toBeNull();
  });

  it('treats an unrecognised access level as the weakest, never the strongest', () => {
    const resolved = resolveEntries([entry({ accessLevel: 'superuser' }), entry({ accessLevel: 'viewer' })], NOW);
    expect(resolved?.accessLevel).toBe('viewer');
  });
});

describe('findAclConflicts', () => {
  it('reports nothing for an ACL that already satisfies the D1 unique index', () => {
    expect(
      findAclConflicts([entry({ principalId: 'a' }), entry({ principalId: 'b' })], NOW),
    ).toEqual([]);
  });

  it('does not confuse the same id under different principal types', () => {
    expect(
      findAclConflicts(
        [entry({ principalType: 'user', principalId: 'x' }), entry({ principalType: 'role', principalId: 'x' })],
        NOW,
      ),
    ).toEqual([]);
  });

  it('classifies an allow/deny pair and keeps the denial', () => {
    const [conflict] = findAclConflicts([entry(), entry({ deny: true })], NOW);
    expect(conflict!.kinds).toContain('allow_and_deny');
    expect(conflict!.resolved?.deny).toBe(true);
    expect(conflict!.discarded).toHaveLength(1);
  });

  it('classifies conflicting access levels', () => {
    const [conflict] = findAclConflicts([entry({ accessLevel: 'viewer' }), entry({ accessLevel: 'editor' })], NOW);
    expect(conflict!.kinds).toContain('conflicting_access_levels');
    expect(conflict!.resolved?.accessLevel).toBe('editor');
  });

  it('classifies duplicate expired entries', () => {
    const [conflict] = findAclConflicts([entry({ expiresAt: PAST }), entry({ expiresAt: PAST })], NOW);
    expect(conflict!.kinds).toContain('duplicate_expired');
    expect(conflict!.resolved).toBeNull();
    // Nothing is kept, so both are on the discard list and the report can show them.
    expect(conflict!.discarded).toHaveLength(2);
  });

  it('accounts for every entry: kept plus discarded equals the original count', () => {
    const entries = [entry(), entry({ accessLevel: 'editor' }), entry({ expiresAt: PAST })];
    const [conflict] = findAclConflicts(entries, NOW);
    expect(conflict!.discarded.length + (conflict!.resolved ? 1 : 0)).toBe(entries.length);
  });
});
