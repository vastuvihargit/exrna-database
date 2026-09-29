/**
 * Phase 3, module 13 — sessions and organizations.
 *
 * These two are the modules a Worker cannot start without: `resolveSession()` runs on every
 * request and `organizations` is the foreign-key target of every other table. So the bar here is
 * higher than "the queries work" — the suite is written around the two ways this module fails
 * dangerously rather than visibly:
 *
 *   1. **An expired or revoked session being accepted.** Every liveness predicate is asserted
 *      independently, at the boundary, on both engines. A test that only checked the happy path
 *      would pass against an implementation that dropped the `revoked_at IS NULL` clause.
 *
 *   2. **The two engines disagreeing.** `resolveSession` reads the same fields either side of the
 *      cutover; a `Date` that became a string, or a `null` that became `undefined`, is an
 *      authentication bug that appears only after the flag moves. The `parity` block compares
 *      whole records rather than spot-checking fields.
 *
 * Structured like the other module suites: `describe.each` over both engines, then parity, then
 * the places D1 genuinely is not a transliteration of the Mongo query.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestDb, stopTestDb, clearCollections } from '../helpers/test-db';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import {
  d1SessionRepository,
  mongoSessionRepository,
  type SessionRecord,
} from '@/server/repositories/session.repository';
import {
  d1OrganizationRepository,
  mongoOrganizationRepository,
  type OrganizationRecord,
} from '@/server/repositories/organization.repository';
import type { SessionRepository } from '@/server/repositories/session.repository.contract';
import type { OrganizationRepository } from '@/server/repositories/organization.repository.contract';
import { clearDataSourceOverrides } from '@/server/repositories/data-source';
import { OrganizationModel } from '@/server/db/models';

const ORG_A = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';
const USER_A = '507f1f77bcf86cd7994390a1';
const USER_B = '507f1f77bcf86cd7994390a2';

const ISO = '2026-01-01T00:00:00.000Z';

/** Settings with every key present, so `normalizeSettings` is not choosing defaults. */
const FULL_SETTINGS = {
  allowAutoProvisioning: true,
  defaultUserQuotaBytes: 1_000,
  defaultDepartmentQuotaBytes: 2_000,
  maxUploadBytes: 3_000,
  allowedExtensions: ['csv', 'fastq'],
  blockedExtensions: ['exe'],
  trashRetentionDays: 14,
  requireApprovalForCategories: ['raw_data'],
  allowSelfApproval: true,
};

let d1: D1Database;

interface Engine {
  name: 'mongo' | 'd1';
  sessions: SessionRepository;
  organizations: OrganizationRepository;
  reset: () => Promise<void>;
}

/* ------------------------------------------------------------------ fixtures */

function future(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

function past(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

let tokenCounter = 0;
/** Distinct per call: `tokenHash` is uniquely indexed on both engines. */
function nextToken(): string {
  tokenCounter += 1;
  return `token-hash-${tokenCounter}`;
}

async function insertD1Organization(
  id: string,
  overrides: {
    createdAt?: string;
    isActive?: boolean;
    deletedAt?: string | null;
    settings?: string;
    emailDomains?: string;
  } = {},
): Promise<void> {
  await d1
    .prepare(
      `INSERT OR REPLACE INTO organizations
         (id, name, slug, email_domains, settings, storage_used_bytes, file_count,
          is_active, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      `Org ${id.slice(-2)}`,
      `org-${id.slice(-2)}`,
      overrides.emailDomains ?? '["example.com"]',
      overrides.settings ?? JSON.stringify(FULL_SETTINGS),
      overrides.isActive === false ? 0 : 1,
      overrides.createdAt ?? ISO,
      overrides.createdAt ?? ISO,
      overrides.deletedAt ?? null,
    )
    .run();
}

async function insertD1User(id: string, organizationId: string): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO users
         (id, organization_id, email, email_domain, name, status,
          storage_quota_bytes, storage_used_bytes, created_at, updated_at)
       VALUES (?, ?, ?, 'example.com', ?, 'active', 1000000, 0, ?, ?)`,
    )
    .bind(id, organizationId, `${id}@example.com`, `User ${id.slice(-2)}`, ISO, ISO)
    .run();
}

async function insertMongoOrganization(
  id: string,
  overrides: { createdAt?: Date; isActive?: boolean; deletedAt?: Date | null } = {},
): Promise<void> {
  await OrganizationModel.create({
    _id: id,
    name: `Org ${id.slice(-2)}`,
    slug: `org-${id.slice(-2)}`,
    emailDomains: ['example.com'],
    settings: FULL_SETTINGS,
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? new Date(ISO),
    deletedAt: overrides.deletedAt ?? null,
  });
}

/* ------------------------------------------------------------------ harness */

beforeAll(async () => {
  const mongo = await startTestDb();
  if (!mongo.available) {
    throw new Error(
      `This suite asserts that the MongoDB and D1 repositories agree, so it needs both. ` +
        `MongoDB could not start: ${mongo.reason}`,
    );
  }

  d1 = await startTestD1();
  setD1BindingForTesting(d1);
}, 300_000);

afterAll(async () => {
  setD1BindingForTesting(null);
  clearDataSourceOverrides();
  await stopTestD1();
  await stopTestDb();
});

const D1_RESET = [
  'DELETE FROM login_history',
  'UPDATE sessions SET rotated_from_id = NULL',
  'DELETE FROM sessions',
  'DELETE FROM users',
  'DELETE FROM organizations',
];

const engines: Engine[] = [
  {
    name: 'mongo',
    sessions: mongoSessionRepository,
    organizations: mongoOrganizationRepository,
    reset: async () => {
      await clearCollections();
      await insertMongoOrganization(ORG_A);
    },
  },
  {
    name: 'd1',
    sessions: d1SessionRepository,
    organizations: d1OrganizationRepository,
    reset: async () => {
      await clearD1(d1, D1_RESET);
      await insertD1Organization(ORG_A);
      await insertD1User(USER_A, ORG_A);
      await insertD1User(USER_B, ORG_A);
    },
  },
];

/* ------------------------------------------------------------------ per-engine behaviour */

describe.each(engines)('session repository — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  async function createSession(
    overrides: Partial<Parameters<SessionRepository['create']>[0]> = {},
  ): Promise<{ record: SessionRecord; tokenHash: string }> {
    const tokenHash = overrides.tokenHash ?? nextToken();
    const record = await engine.sessions.create({
      userId: USER_A,
      organizationId: ORG_A,
      tokenHash,
      csrfTokenHash: 'csrf-hash',
      expiresAt: future(30),
      absoluteExpiresAt: future(60 * 8),
      ip: '10.0.0.1',
      userAgent: 'vitest',
      deviceLabel: 'Test device',
      provider: 'password',
      ...overrides,
    });
    return { record, tokenHash };
  }

  it('finds a live session by token hash, with the CSRF hash attached', async () => {
    const { tokenHash } = await createSession();

    const found = await engine.sessions.findLiveByTokenHash(tokenHash);

    expect(found).not.toBeNull();
    expect(found!.userId).toBe(USER_A);
    expect(found!.organizationId).toBe(ORG_A);
    expect(found!.csrfTokenHash).toBe('csrf-hash');
  });

  it('returns null for an unknown token hash', async () => {
    await createSession();
    expect(await engine.sessions.findLiveByTokenHash('no-such-hash')).toBeNull();
  });

  /**
   * The three liveness predicates, each defeated on its own.
   *
   * Separately rather than together, because an implementation missing exactly one of them
   * passes a combined test and is an authentication bypass.
   */
  it('refuses a revoked session', async () => {
    const { record, tokenHash } = await createSession();
    await engine.sessions.revoke(record.id, 'logout');

    expect(await engine.sessions.findLiveByTokenHash(tokenHash)).toBeNull();
  });

  it('refuses a session past its idle expiry, even inside the absolute window', async () => {
    const { tokenHash } = await createSession({
      expiresAt: past(1),
      absoluteExpiresAt: future(60 * 8),
    });

    expect(await engine.sessions.findLiveByTokenHash(tokenHash)).toBeNull();
  });

  it('refuses a session past its absolute expiry, even with a fresh idle window', async () => {
    const { tokenHash } = await createSession({
      expiresAt: future(30),
      absoluteExpiresAt: past(1),
    });

    expect(await engine.sessions.findLiveByTokenHash(tokenHash)).toBeNull();
  });

  it('slides the idle window on touch', async () => {
    const { record, tokenHash } = await createSession({ expiresAt: future(5) });

    await engine.sessions.touch(record.id, future(45));

    const found = await engine.sessions.findLiveByTokenHash(tokenHash);
    expect(found!.expiresAt.getTime()).toBeGreaterThan(future(40).getTime());
  });

  /**
   * The invariant `touch` exists to preserve: an idle extension must never push a session past
   * the absolute expiry, or a session could be kept alive for ever by using it.
   */
  it('caps the slid idle window at the absolute expiry', async () => {
    const absolute = future(10);
    const { record, tokenHash } = await createSession({
      expiresAt: future(5),
      absoluteExpiresAt: absolute,
    });

    await engine.sessions.touch(record.id, future(60 * 24));

    const found = await engine.sessions.findLiveByTokenHash(tokenHash);
    expect(found!.expiresAt.getTime()).toBe(absolute.getTime());
  });

  it('revokes every live session for a user and reports how many changed', async () => {
    await createSession();
    await createSession();
    const { record: alreadyDead } = await createSession();
    await engine.sessions.revoke(alreadyDead.id, 'logout');

    const revoked = await engine.sessions.revokeAllForUser(USER_A, 'password_changed');

    // Two, not three: the already-revoked session was not changed by this call.
    expect(revoked).toBe(2);
    expect(await engine.sessions.listForUser(USER_A)).toHaveLength(0);
  });

  it('spares the excepted session when revoking the rest', async () => {
    const { record: keep, tokenHash: keepToken } = await createSession();
    await createSession();

    const revoked = await engine.sessions.revokeAllForUser(USER_A, 'logout_all', {
      exceptSessionId: keep.id,
    });

    expect(revoked).toBe(1);
    expect(await engine.sessions.findLiveByTokenHash(keepToken)).not.toBeNull();
  });

  it('does not revoke another user’s sessions', async () => {
    const { tokenHash: otherToken } = await createSession({ userId: USER_B });
    await createSession({ userId: USER_A });

    await engine.sessions.revokeAllForUser(USER_A, 'logout_all');

    expect(await engine.sessions.findLiveByTokenHash(otherToken)).not.toBeNull();
  });

  it('lists live sessions most-recently-used first, excluding revoked and expired', async () => {
    const { record: first } = await createSession();
    await createSession();
    const { record: revoked } = await createSession();
    await engine.sessions.revoke(revoked.id, 'logout');
    await createSession({ absoluteExpiresAt: past(1) });

    // Make `first` the most recently used, so ordering is asserted rather than assumed.
    await engine.sessions.touch(first.id, future(30));

    const listed = await engine.sessions.listForUser(USER_A);

    expect(listed).toHaveLength(2);
    expect(listed[0]!.id).toBe(first.id);
  });

  it('marks a rotated session revoked as well as rotated', async () => {
    const { record, tokenHash } = await createSession();

    await engine.sessions.markRotated(record.id);

    expect(await engine.sessions.findLiveByTokenHash(tokenHash)).toBeNull();
    const found = await engine.sessions.findById(record.id);
    expect(found!.rotatedAt).toBeInstanceOf(Date);
    expect(found!.revokedAt).toBeInstanceOf(Date);
  });

  it('sweeps sessions past their absolute expiry and leaves live ones alone', async () => {
    const { record: live } = await createSession();
    await createSession({ absoluteExpiresAt: past(60) });
    await createSession({ absoluteExpiresAt: past(90) });

    const deleted = await engine.sessions.deleteExpiredBefore(new Date());

    expect(deleted).toBe(2);
    expect(await engine.sessions.findById(live.id)).not.toBeNull();
  });
});

describe.each(engines)('organization repository — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  it('returns the single tenant with settings intact', async () => {
    const org = await engine.organizations.getPrimary();

    expect(org).not.toBeNull();
    expect(org!.id).toBe(ORG_A);
    expect(org!.emailDomains).toEqual(['example.com']);
    expect(org!.settings).toEqual(FULL_SETTINGS);
  });

  it('finds by id', async () => {
    const org = await engine.organizations.findById(ORG_A);
    expect(org!.id).toBe(ORG_A);
  });

  it('returns null for an id that does not exist', async () => {
    expect(await engine.organizations.findById('507f1f77bcf86cd7994390ff')).toBeNull();
  });

  it('skips an inactive organization when choosing the primary', async () => {
    if (engine.name === 'd1') {
      await clearD1(d1, D1_RESET);
      await insertD1Organization(ORG_B, { isActive: false, createdAt: '2020-01-01T00:00:00.000Z' });
      await insertD1Organization(ORG_A, { createdAt: '2021-01-01T00:00:00.000Z' });
    } else {
      await clearCollections();
      await insertMongoOrganization(ORG_B, {
        isActive: false,
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      await insertMongoOrganization(ORG_A, { createdAt: new Date('2021-01-01T00:00:00.000Z') });
    }

    const org = await engine.organizations.getPrimary();
    expect(org!.id).toBe(ORG_A);
  });

  it('chooses the oldest active organization', async () => {
    if (engine.name === 'd1') {
      await clearD1(d1, D1_RESET);
      await insertD1Organization(ORG_B, { createdAt: '2020-01-01T00:00:00.000Z' });
      await insertD1Organization(ORG_A, { createdAt: '2021-01-01T00:00:00.000Z' });
    } else {
      await clearCollections();
      await insertMongoOrganization(ORG_B, { createdAt: new Date('2020-01-01T00:00:00.000Z') });
      await insertMongoOrganization(ORG_A, { createdAt: new Date('2021-01-01T00:00:00.000Z') });
    }

    const org = await engine.organizations.getPrimary();
    expect(org!.id).toBe(ORG_B);
  });
});

/* ------------------------------------------------------------------ parity */

describe('parity between engines', () => {
  beforeEach(async () => {
    await clearCollections();
    await clearD1(d1, D1_RESET);
    await insertMongoOrganization(ORG_A);
    await insertD1Organization(ORG_A);
    await insertD1User(USER_A, ORG_A);
  });

  /**
   * Compares whole records rather than named fields.
   *
   * `id` and the timestamps are the only legitimate differences — D1 mints a UUID for a new row
   * where Mongo mints an ObjectId, and the two are written microseconds apart. Everything else
   * must match exactly, including the `null`s: `revokedAt: null` becoming `undefined` would
   * survive a field-by-field test and change what `dto.ts` serialises.
   */
  function comparable(
    record: SessionRecord,
  ): Omit<SessionRecord, 'id' | 'createdAt' | 'lastUsedAt'> {
    const rest = { ...record } as Partial<SessionRecord>;
    delete rest.id;
    delete rest.createdAt;
    delete rest.lastUsedAt;
    return rest as Omit<SessionRecord, 'id' | 'createdAt' | 'lastUsedAt'>;
  }

  it('produces structurally identical session records for identical input', async () => {
    const expiresAt = future(30);
    const absoluteExpiresAt = future(60 * 8);
    const input = {
      userId: USER_A,
      organizationId: ORG_A,
      csrfTokenHash: 'csrf-hash',
      expiresAt,
      absoluteExpiresAt,
      ip: '10.0.0.1',
      userAgent: 'vitest',
      deviceLabel: 'Test device',
      provider: 'password',
    };

    const fromMongo = await mongoSessionRepository.create({ ...input, tokenHash: nextToken() });
    const fromD1 = await d1SessionRepository.create({ ...input, tokenHash: nextToken() });

    expect(comparable(fromD1)).toEqual(comparable(fromMongo));

    // And the key types survive, which is what `resolveSession` and `dto.ts` depend on.
    expect(fromD1.expiresAt).toBeInstanceOf(Date);
    expect(fromD1.createdAt).toBeInstanceOf(Date);
    expect(fromD1.revokedAt).toBeNull();
    expect(fromD1.rotatedAt).toBeNull();
  });

  it('produces identical organization records', async () => {
    const fromMongo = await mongoOrganizationRepository.getPrimary();
    const fromD1 = await d1OrganizationRepository.getPrimary();

    const strip = (org: OrganizationRecord | null) => {
      expect(org).not.toBeNull();
      return org!;
    };

    expect(strip(fromD1)).toEqual(strip(fromMongo));
  });
});

/* ------------------------------------------------------------------ D1 specifics */

describe('d1 specifics', () => {
  beforeEach(async () => {
    await clearD1(d1, D1_RESET);
    await insertD1Organization(ORG_A);
    await insertD1User(USER_A, ORG_A);
  });

  /**
   * The sweep has to detach `login_history.session_id` before deleting, because that column is a
   * foreign key with no cascade and every logged-in session has a row pointing at it.
   *
   * Without the detach this call throws a FOREIGN KEY constraint failure — which is what made it
   * worth writing: a sweep that crashes leaves expired sessions in the table for ever, and the
   * only symptom is a growing table nobody is watching.
   */
  it('sweeps expired sessions without breaking the login-history record', async () => {
    const expired = await d1SessionRepository.create({
      userId: USER_A,
      organizationId: ORG_A,
      tokenHash: nextToken(),
      csrfTokenHash: 'csrf',
      expiresAt: past(120),
      absoluteExpiresAt: past(60),
      ip: '10.0.0.1',
      userAgent: 'vitest',
      deviceLabel: 'Test device',
      provider: 'password',
    });

    await d1
      .prepare(
        `INSERT INTO login_history (id, user_id, email, outcome, provider, ip, user_agent, session_id, created_at)
         VALUES (?, ?, ?, 'success', 'password', '10.0.0.1', 'vitest', ?, ?)`,
      )
      .bind('history-1', USER_A, `${USER_A}@example.com`, expired.id, ISO)
      .run();

    const deleted = await d1SessionRepository.deleteExpiredBefore(new Date());

    expect(deleted).toBe(1);

    // The security record survives, detached rather than deleted.
    const history = await d1
      .prepare('SELECT session_id, outcome, ip FROM login_history WHERE id = ?')
      .bind('history-1')
      .first<{ session_id: string | null; outcome: string; ip: string }>();

    expect(history).not.toBeNull();
    expect(history!.session_id).toBeNull();
    expect(history!.outcome).toBe('success');
    expect(history!.ip).toBe('10.0.0.1');
  });

  /** The rotation chain is a self-reference, and it blocks a delete the same way. */
  it('sweeps a session that a later session was rotated from', async () => {
    const older = await d1SessionRepository.create({
      userId: USER_A,
      organizationId: ORG_A,
      tokenHash: nextToken(),
      csrfTokenHash: 'csrf',
      expiresAt: past(120),
      absoluteExpiresAt: past(60),
      ip: '10.0.0.1',
      userAgent: 'vitest',
      deviceLabel: 'Test device',
      provider: 'password',
    });

    const newer = await d1SessionRepository.create({
      userId: USER_A,
      organizationId: ORG_A,
      tokenHash: nextToken(),
      csrfTokenHash: 'csrf',
      expiresAt: future(30),
      absoluteExpiresAt: future(60),
      ip: '10.0.0.1',
      userAgent: 'vitest',
      deviceLabel: 'Test device',
      provider: 'password',
      rotatedFromId: older.id,
    });

    expect(await d1SessionRepository.deleteExpiredBefore(new Date())).toBe(1);
    expect(await d1SessionRepository.findById(newer.id)).not.toBeNull();
  });

  /**
   * `settings` and `email_domains` are JSON columns on the login path.
   *
   * Throwing on malformed JSON would take authentication down for everyone over one bad
   * character. Falling back to the documented defaults degrades one setting instead — and the
   * defaults are the restrictive ones, so the failure cannot widen access.
   */
  it('falls back to restrictive defaults rather than throwing on malformed settings JSON', async () => {
    await insertD1Organization(ORG_A, { settings: '{not json', emailDomains: 'also not json' });

    const org = await d1OrganizationRepository.getPrimary();

    expect(org).not.toBeNull();
    expect(org!.emailDomains).toEqual([]);
    expect(org!.settings.allowAutoProvisioning).toBe(false);
    expect(org!.settings.allowSelfApproval).toBe(false);
    expect(org!.settings.allowedExtensions).toEqual([]);
    // 30, not 0 — a missing retention must not read as "purge immediately".
    expect(org!.settings.trashRetentionDays).toBe(30);
  });

  /** Mongoose applied this filter through a hook; in D1 it is written into the query. */
  it('excludes a soft-deleted organization', async () => {
    await insertD1Organization(ORG_A, { deletedAt: '2026-02-01T00:00:00.000Z' });

    expect(await d1OrganizationRepository.getPrimary()).toBeNull();
    expect(await d1OrganizationRepository.findById(ORG_A)).toBeNull();
  });
});
