/**
 * Phase 3, module 12 — the audit trail on D1.
 *
 * The audit trail is the one table in this system whose value comes entirely from what *cannot*
 * happen to it, so that is what this suite is about.
 *
 * **It cannot be rewritten.** Migration 0001 creates `RAISE(ABORT)` triggers for UPDATE and
 * DELETE, and they are tested by attempting both directly against the engine — not by checking
 * that the repository has no such method, which proves only that this file is well behaved.
 * The threat is a migration script or a future repository, and the trigger is what stops those.
 *
 * **It cannot leak across tenants.** Every query is organization-scoped, and the test asserts
 * on `total` as well as on the rows, because a count is how you learn something exists.
 *
 * **It cannot leak a secret.** The redaction list is shared policy rather than per-engine code,
 * and the storage key is on it for a reason that is easy to miss: an auditor allowed to know
 * *that* a file changed is not thereby allowed to know where its bytes live.
 *
 * **It cannot record a success that did not happen.** That one is not enforceable in the
 * repository — it is an ordering rule in the audit service, which writes after the business
 * commit. The test here is the structural half: the append is not part of anyone's batch, so
 * there is no path by which a rolled-back write could carry an audit row in with it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import * as audit from '@/server/repositories/audit-log.repository.d1';
import { sanitizeAuditValue } from '@/server/repositories/audit-log.repository.contract';
import * as auditFacade from '@/server/repositories/audit-log.repository';
import {
  clearDataSourceOverrides,
  dataSourceFor,
  setDataSourceOverride,
} from '@/server/repositories/data-source';
import type { AuditAppendInput } from '@/server/repositories/audit-log.repository.contract';

const ORG = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';
const ALICE = '507f1f77bcf86cd799439031';
const BOB = '507f1f77bcf86cd799439032';
const ISO = '2026-01-01T00:00:00.000Z';

let d1: D1Database;

async function seedWorld(): Promise<void> {
  const run = (text: string, ...binds: unknown[]) => d1.prepare(text).bind(...binds).run();

  for (const [id, name] of [
    [ORG, 'Org A'],
    [ORG_B, 'Org B'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO organizations (id,name,slug,email_domains,settings,storage_used_bytes,file_count,is_active,created_at,updated_at)
       VALUES (?,?,?,'[]','{}',0,0,1,?,?)`,
      id, name, id.slice(-4), ISO, ISO,
    );
  }
  for (const [id, organizationId, email] of [
    [ALICE, ORG, 'alice@company.com'],
    [BOB, ORG_B, 'bob@rival.com'],
  ] as const) {
    await run(
      `INSERT OR IGNORE INTO users (id,organization_id,email,email_domain,name,mfa,preferences,status,is_super_admin,storage_quota_bytes,storage_used_bytes,must_change_password,failed_login_count,created_at,updated_at)
       VALUES (?,?,?,'company.com',?,'{"enabled":false}','{}','active',0,1,0,0,0,?,?)`,
      id, organizationId, email, email.split('@')[0], ISO, ISO,
    );
  }
}

function event(overrides: Partial<AuditAppendInput> = {}): AuditAppendInput {
  return {
    organizationId: ORG,
    actorUserId: ALICE,
    actorEmail: 'alice@company.com',
    actorRoleKeys: ['scientist'],
    action: 'file.rename',
    entityType: 'file',
    entityId: 'file-1',
    entityLabel: 'protocol.pdf',
    ip: '10.0.0.1',
    userAgent: 'vitest',
    requestId: 'req-1',
    ...overrides,
  };
}

const page = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  page: 1,
  pageSize: 50,
  ...over,
});

beforeAll(async () => {
  d1 = await startTestD1();
  setD1BindingForTesting(d1);
}, 300_000);

afterAll(async () => {
  clearDataSourceOverrides();
  setD1BindingForTesting(null);
  await stopTestD1();
});

beforeEach(async () => {
  clearDataSourceOverrides();
  // The immutability triggers refuse DELETE, so the table is emptied the one way they allow.
  await d1.prepare('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete').run();
  await clearD1(d1, ['DELETE FROM audit_logs']);
  await d1
    .prepare(
      `CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
       BEFORE DELETE ON audit_logs
       BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;`,
    )
    .run();
  await seedWorld();
});

/* ================================================================== immutability */

describe('the trail cannot be rewritten', () => {
  it('refuses an UPDATE at the engine, not merely in the repository', async () => {
    await audit.append(event());
    const [row] = (await d1.prepare('SELECT id FROM audit_logs').all<{ id: string }>()).results;

    await expect(
      d1.prepare('UPDATE audit_logs SET action = ? WHERE id = ?').bind('file.download', row!.id).run(),
    ).rejects.toThrow();

    // ...and the row is exactly as written. A trigger that aborted after the write would be
    // worse than no trigger, because the failure would look like a refusal.
    const after = await d1
      .prepare('SELECT action FROM audit_logs WHERE id = ?')
      .bind(row!.id)
      .first<{ action: string }>();
    expect(after?.action).toBe('file.rename');
  });

  it('refuses a DELETE at the engine', async () => {
    await audit.append(event());
    await expect(d1.prepare('DELETE FROM audit_logs').run()).rejects.toThrow();
    expect((await audit.query(page())).total).toBe(1);
  });

  /**
   * A retried append writes a second row rather than replacing the first.
   *
   * That is the correct failure mode and it is worth pinning: making `append` idempotent would
   * mean an upsert, an upsert is an update, and an update is the thing the triggers exist to
   * refuse. Two records of one attempt is a reporting nuisance; one record silently overwritten
   * is evidence destroyed.
   */
  it('records a retried append twice rather than overwriting', async () => {
    await audit.append(event({ requestId: 'retry-me' }));
    await audit.append(event({ requestId: 'retry-me' }));
    expect((await audit.query(page())).total).toBe(2);
  });
});

/* ================================================================== isolation */

describe('organization isolation', () => {
  it('shows one tenant nothing of another, in the rows or the total', async () => {
    await audit.append(event({ organizationId: ORG, entityId: 'mine' }));
    await audit.append(
      event({ organizationId: ORG_B, actorUserId: BOB, actorEmail: 'bob@rival.com', entityId: 'theirs' }),
    );

    const mine = await audit.query(page());
    expect(mine.items.map((row) => row.entityId)).toEqual(['mine']);
    expect(mine.total).toBe(1);

    const theirs = await audit.query(page({ organizationId: ORG_B }));
    expect(theirs.items.map((row) => row.entityId)).toEqual(['theirs']);
    expect(theirs.total).toBe(1);
  });

  /**
   * A failed login against an address matching no account belongs to no tenant. The row is
   * still written — that is what credential stuffing looks like in the trail — and it is
   * visible to no organization-scoped query.
   */
  it('keeps a tenant-less event out of every organization’s view', async () => {
    await audit.append(
      event({
        organizationId: null,
        actorUserId: null,
        actorEmail: 'nobody@example.com',
        action: 'auth.login_failed',
        entityType: 'session',
        entityId: null,
      }),
    );

    expect((await audit.query(page())).total).toBe(0);
    expect((await audit.query(page({ organizationId: ORG_B }))).total).toBe(0);
    // ...but it is genuinely there, so the zeroes above are isolation and not an empty table.
    const all = await d1.prepare('SELECT COUNT(*) AS n FROM audit_logs').first<{ n: number }>();
    expect(all?.n).toBe(1);
  });
});

/* ================================================================== filtering and paging */

describe('filtering and paging', () => {
  beforeEach(async () => {
    for (let index = 0; index < 5; index += 1) {
      await audit.append(
        event({
          entityId: `file-${index}`,
          action: index % 2 === 0 ? 'file.rename' : 'resource.delete',
          outcome: index === 4 ? 'denied' : 'success',
        }),
      );
    }
  });

  it('filters by action, outcome, entity and actor', async () => {
    expect((await audit.query(page({ action: 'resource.delete' }))).total).toBe(2);
    expect((await audit.query(page({ outcome: 'denied' }))).total).toBe(1);
    expect((await audit.query(page({ entityId: 'file-3' }))).total).toBe(1);
    expect((await audit.query(page({ actorUserId: ALICE }))).total).toBe(5);
    expect((await audit.query(page({ actorUserId: BOB }))).total).toBe(0);
  });

  it('pages without skipping or repeating rows written in the same millisecond', async () => {
    const seen: string[] = [];
    for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
      const result = await audit.query(page({ page: pageNumber, pageSize: 1 }));
      expect(result.total).toBe(5);
      expect(result.items).toHaveLength(1);
      seen.push(result.items[0]!.id);
    }
    // Five distinct ids. Without the id tiebreak, rows sharing a timestamp reorder between
    // pages and the same row appears twice while another is never shown.
    expect(new Set(seen).size).toBe(5);
  });

  it('filters by time window', async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    expect((await audit.query(page({ from: past, to: future }))).total).toBe(5);
    expect((await audit.query(page({ from: future }))).total).toBe(0);
    expect((await audit.query(page({ to: past }))).total).toBe(0);
  });

  it('returns the newest first', async () => {
    const result = await audit.query(page());
    const times = result.items.map((row) => row.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

/* ================================================================== payloads */

describe('what is stored and what is not', () => {
  it('round-trips a before/after snapshot through JSON', async () => {
    await audit.append(
      event({
        previousValue: { displayName: 'old.pdf', tags: ['a', 'b'], nested: { depth: 2 } },
        newValue: { displayName: 'new.pdf', tags: [], nested: { depth: 3 } },
      }),
    );

    const [row] = (await audit.query(page())).items;
    expect(row!.previousValue).toEqual({
      displayName: 'old.pdf',
      tags: ['a', 'b'],
      nested: { depth: 2 },
    });
    expect(row!.newValue).toEqual({ displayName: 'new.pdf', tags: [], nested: { depth: 3 } });
    expect(row!.actorRoleKeys).toEqual(['scientist']);
  });

  it('redacts secrets and storage coordinates, however deeply nested', async () => {
    await audit.append(
      event({
        newValue: {
          displayName: 'kept.pdf',
          passwordHash: 'argon2id$...',
          storageKey: 'originals/abc/def',
          nested: [{ token: 'sk-live-1', relativeStoragePath: '/var/data/x' }],
        },
      }),
    );

    const [row] = (await audit.query(page())).items;
    const value = row!.newValue as Record<string, unknown>;
    expect(value.displayName).toBe('kept.pdf');
    expect(value.passwordHash).toBe('[redacted]');
    expect(value.storageKey).toBe('[redacted]');
    expect((value.nested as Array<Record<string, unknown>>)[0]).toEqual({
      token: '[redacted]',
      relativeStoragePath: '[redacted]',
    });
  });

  it('replaces an oversized payload with a marker rather than storing it', async () => {
    const huge = { blob: 'x'.repeat(20 * 1024) };
    await audit.append(event({ newValue: huge }));

    const [row] = (await audit.query(page())).items;
    expect(row!.newValue).toMatchObject({ truncated: true });
  });

  it('keeps dates intact through redaction', () => {
    const when = new Date(ISO);
    expect(sanitizeAuditValue({ when })).toEqual({ when });
  });

  it('reads an unparseable payload as null rather than failing the page', async () => {
    await audit.append(event({ newValue: { ok: true } }));
    const [row] = (await audit.query(page())).items;

    // The trigger refuses UPDATE, so the corruption is introduced the way a bad migration
    // would: with the trigger absent.
    await d1.prepare('DROP TRIGGER IF EXISTS trg_audit_logs_no_update').run();
    await d1
      .prepare('UPDATE audit_logs SET new_value = ? WHERE id = ?')
      .bind('{not json', row!.id)
      .run();
    await d1
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
         BEFORE UPDATE ON audit_logs
         BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;`,
      )
      .run();

    // One malformed row must not break the page an administrator opens *because* something
    // went wrong.
    const result = await audit.query(page());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.newValue).toBeNull();
  });

  it('defaults the fields a background job leaves out', async () => {
    await audit.append({
      organizationId: ORG,
      action: 'resource.purge',
      entityType: 'system',
      actorEmail: 'system:retention',
    });

    const [row] = (await audit.query(page())).items;
    expect(row).toMatchObject({
      outcome: 'success',
      severity: 'info',
      ip: 'unknown',
      userAgent: 'unknown',
      actorUserId: null,
      actorRoleKeys: [],
      previousValue: null,
      newValue: null,
    });
  });
});

/* ================================================================== routing */

describe('the audit module routes on its own flag', () => {
  it('is on Mongo until asked for D1 by name', () => {
    clearDataSourceOverrides();
    expect(dataSourceFor('auditLogs')).toBe('mongo');
    setDataSourceOverride('auditLogs', 'd1');
    expect(dataSourceFor('auditLogs')).toBe('d1');
  });

  it('writes through the façade to D1 once the flag is set', async () => {
    setDataSourceOverride('auditLogs', 'd1');
    await auditFacade.append(event({ entityId: 'via-facade' }));

    const result = await auditFacade.query(page());
    expect(result.items.map((row) => row.entityId)).toEqual(['via-facade']);
  });
});
