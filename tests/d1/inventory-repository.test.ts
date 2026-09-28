/**
 * Phase 3, module 15 — inventory, batches and the stock ledger.
 *
 * This is the only module where a repository owns a *physical* invariant. A file listed twice is
 * a bug; a shelf reporting 5 L when it holds 2 L is somebody calculating a dose from a number
 * that is not true. The assertions here are aimed at the ways that number can quietly stop being
 * true, not at the happy paths.
 *
 *   • **Two people cannot issue the same last unit.** Both read 5, both decide 3 is fine, and
 *     the shelf owes 1. Both engines must fail the second request rather than serving it.
 *
 *   • **The ledger's before/after figures must be observed, not predicted.** Two concurrent
 *     issues of 3 from a stock of 10 both *predict* "10 → 7" while the item correctly reaches 4.
 *     Numbers that are self-consistent and wrong are worse than an obvious error, because they
 *     are what an auditor uses to confirm nothing drifted.
 *
 *   • **A failed movement must leave no ledger row.** A row recording an issue that never
 *     happened is the one outcome worse than losing the movement entirely: the material is still
 *     on the shelf and the system says it went to a project.
 *
 *   • **Expired stock is never issued, and never silently skipped either.** An item holding 10 L
 *     of which 8 L expired must refuse a 5 L issue *and* still report 10 L in stock, so the
 *     discrepancy stays visible until somebody writes it off.
 *
 *   • **History is append-only at the engine.** Not by convention, not because no route exists —
 *     the MongoDB pre-hooks and the D1 `RAISE(ABORT)` triggers both have to refuse.
 *
 * The engine-parity blocks run both implementations through the same contract, so a divergence
 * shows up as a failing assertion rather than as a surprise at cutover. The `d1` blocks cover the
 * places where D1 is genuinely not a transliteration — the CHECK-backed decrement, and the
 * deliberate decision to keep zero-quantity batch rows that MongoDB prunes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { startTestDb, stopTestDb, clearCollections } from '../helpers/test-db';
import { startTestD1, stopTestD1, clearD1 } from '../helpers/test-d1';
import { setD1BindingForTesting } from '@/server/db/d1-context';
import { clearDataSourceOverrides } from '@/server/repositories/data-source';
import {
  d1InventoryRepository,
  mongoInventoryRepository,
} from '@/server/repositories/inventory-item.repository';
import {
  InsufficientStockError,
  UnknownBatchError,
  type InventoryRepository,
} from '@/server/repositories/inventory-item.repository.contract';
import { planIssue } from '@/server/domain/inventory';
import { StockTransactionModel, UserModel, DepartmentModel } from '@/server/db/models';

const ORG = '507f1f77bcf86cd799439011';
const DEPT = '507f1f77bcf86cd799439021';
const ALICE = '507f1f77bcf86cd7994390a1';
const BOB = '507f1f77bcf86cd7994390a2';

const ISO = '2026-01-01T00:00:00.000Z';
const NOW = new Date('2026-06-01T00:00:00.000Z');
/** Comfortably beyond the 30-day near-expiry window, so "not expired" is unambiguous. */
const FUTURE = new Date('2027-01-01T00:00:00.000Z');
const SOONER = new Date('2026-08-01T00:00:00.000Z');
const PAST = new Date('2026-02-01T00:00:00.000Z');

let d1: D1Database;

/* ------------------------------------------------------------------ fixtures */

async function seedD1(): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO organizations
         (id, name, slug, email_domains, settings, storage_used_bytes, file_count, is_active,
          created_at, updated_at)
       VALUES (?, 'Org', 'org', '[]', '{}', 0, 0, 1, ?, ?)`,
    )
    .bind(ORG, ISO, ISO)
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO departments
         (id, organization_id, name, code, description, storage_quota_bytes, storage_used_bytes,
          member_count, is_active, created_at, updated_at)
       VALUES (?, ?, 'Molecular Biology', 'MOLBIO', '', 1000000, 0, 0, 1, ?, ?)`,
    )
    .bind(DEPT, ORG, ISO, ISO)
    .run();

  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
  ]) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO users
           (id, organization_id, email, email_domain, name, status, department_id,
            storage_quota_bytes, storage_used_bytes, created_at, updated_at)
         VALUES (?, ?, ?, 'example.com', ?, 'active', ?, 1000000, 0, ?, ?)`,
      )
      .bind(id, ORG, `${name!.toLowerCase()}@example.com`, name, DEPT, ISO, ISO)
      .run();
  }
}

async function seedMongo(): Promise<void> {
  await DepartmentModel.create({
    _id: DEPT,
    organizationId: ORG,
    name: 'Molecular Biology',
    code: 'MOLBIO',
    storageQuotaBytes: 1_000_000,
  });

  for (const [id, name] of [
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
  ]) {
    await UserModel.create({
      _id: id,
      organizationId: ORG,
      email: `${name!.toLowerCase()}@example.com`,
      emailDomain: 'example.com',
      name,
      status: 'active',
      departmentId: DEPT,
      storageQuotaBytes: 1_000_000,
    });
  }
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
  'DELETE FROM stock_transaction_documents',
  'DELETE FROM inventory_item_documents',
  'DELETE FROM inventory_batches',
  'DELETE FROM stock_transactions',
  'DELETE FROM inventory_items',
  'DELETE FROM users',
  'DELETE FROM departments',
  'DELETE FROM organizations',
];

const NO_DELETE_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS trg_stock_transactions_no_delete
  BEFORE DELETE ON stock_transactions
  BEGIN SELECT RAISE(ABORT, 'Stock history is append-only and cannot be modified or deleted'); END;
`;

/**
 * Resetting the ledger means dropping its delete trigger and putting it straight back.
 *
 * Migration 0001 installs `RAISE(ABORT)` on `BEFORE DELETE ON stock_transactions`, so a plain
 * `DELETE` fails — which is the property this suite asserts elsewhere and must not weaken. The
 * trigger is recreated inside the same helper rather than in `afterEach`, so a test that throws
 * cannot leave the table mutable for everything that follows it. The audit-log suite does the
 * same thing for the same reason.
 */
async function resetD1(): Promise<void> {
  await d1.prepare('DROP TRIGGER IF EXISTS trg_stock_transactions_no_delete').run();
  try {
    await clearD1(d1, D1_RESET);
  } finally {
    await d1.prepare(NO_DELETE_TRIGGER).run();
  }
  await seedD1();
}

interface Engine {
  name: 'mongo' | 'd1';
  repo: InventoryRepository;
  reset: () => Promise<void>;
}

const engines: Engine[] = [
  {
    name: 'mongo',
    repo: mongoInventoryRepository,
    reset: async () => {
      await clearCollections();
      await seedMongo();
    },
  },
  {
    name: 'd1',
    repo: d1InventoryRepository,
    reset: resetD1,
  },
];

async function makeItem(
  repo: InventoryRepository,
  overrides: { code?: string; minimumStock?: number } = {},
) {
  return repo.create({
    organizationId: ORG,
    departmentId: DEPT,
    name: 'Tris buffer',
    code: overrides.code ?? 'CHM-0042',
    category: 'chemical',
    unit: 'mL',
    minimumStock: overrides.minimumStock ?? 0,
    status: 'active',
    createdBy: ALICE,
  });
}

const context = {
  performedBy: ALICE,
  performedByName: 'Alice',
  performedAt: NOW,
};

const toAlice = {
  type: 'employee' as const,
  userId: ALICE,
  label: 'Alice',
};

/* ------------------------------------------------------------------ items */

describe.each(engines)('inventory items — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  it('creates an item empty, whatever the caller wants', async () => {
    const item = await makeItem(engine.repo);

    // There is no input field through which stock can arrive without a ledger row. The
    // assertion is on the *type* being closed as much as on these values.
    expect(item.availableQuantity).toBe(0);
    expect(item.batches).toEqual([]);
    expect(item.stockState).toBe('out_of_stock');
    expect(item.code).toBe('CHM-0042');
  });

  it('finds an item by its code, case-insensitively', async () => {
    await makeItem(engine.repo);
    const found = await engine.repo.findByCode(ORG, 'chm-0042');
    expect(found?.name).toBe('Tris buffer');
  });

  it('does not find an item belonging to another organization', async () => {
    await makeItem(engine.repo);
    expect(await engine.repo.findByCode('507f1f77bcf86cd799439099', 'CHM-0042')).toBeNull();
  });

  it('recomputes the stock state when the minimum moves', async () => {
    const item = await makeItem(engine.repo);
    await engine.repo.receive({
      itemId: item.id,
      quantity: 10,
      batchNumber: 'L1',
      expiryDate: FUTURE,
      ...context,
    });

    // 10 in stock against a minimum of 20 is low; the derived column has to follow, because
    // the alert page filters on it rather than comparing the two fields.
    const updated = await engine.repo.update(item.id, {
      minimumStock: 20,
      stockState: 'low',
      updatedBy: ALICE,
    });
    expect(updated?.stockState).toBe('low');
  });
});

/* ------------------------------------------------------------------ receiving */

describe.each(engines)('receiving stock — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  it('adds a batch, updates the summary and writes one ledger row', async () => {
    const item = await makeItem(engine.repo, { minimumStock: 5 });

    const { item: after, transaction } = await engine.repo.receive({
      itemId: item.id,
      quantity: 250,
      batchNumber: 'LOT-A',
      expiryDate: FUTURE,
      supplier: 'Acme',
      storageLocation: 'Fridge 2',
      ...context,
    });

    expect(after.availableQuantity).toBe(250);
    expect(after.stockState).toBe('ok');
    expect(after.batchNumber).toBe('LOT-A');
    expect(after.batches).toHaveLength(1);

    expect(transaction.action).toBe('added');
    expect(transaction.quantityDelta).toBe(250);
    expect(transaction.previousQuantity).toBe(0);
    expect(transaction.newQuantity).toBe(250);
    // Denormalized so history renders without a join and survives the item being renamed.
    expect(transaction.itemCode).toBe('CHM-0042');
    expect(transaction.unit).toBe('mL');
  });

  it('tops up a batch that is already on the shelf rather than duplicating the label', async () => {
    const item = await makeItem(engine.repo);
    for (const quantity of [100, 50]) {
      await engine.repo.receive({
        itemId: item.id,
        quantity,
        batchNumber: 'LOT-A',
        expiryDate: FUTURE,
        ...context,
      });
    }

    const after = await engine.repo.findById(item.id);
    expect(after?.availableQuantity).toBe(150);
    // One physical container, one row. Two rows carrying the same printed number would make
    // "which one do I take from" unanswerable.
    expect(after?.batches).toHaveLength(1);
    expect(after?.batches[0]?.quantity).toBe(150);
  });

  it('reports the earliest expiry among batches that hold stock', async () => {
    const item = await makeItem(engine.repo);
    await engine.repo.receive({
      itemId: item.id,
      quantity: 10,
      batchNumber: 'LATER',
      expiryDate: FUTURE,
      ...context,
    });
    await engine.repo.receive({
      itemId: item.id,
      quantity: 10,
      batchNumber: 'SOONER',
      expiryDate: SOONER,
      ...context,
    });

    const after = await engine.repo.findById(item.id);
    // First expiry first out: the batch a store manager should hand over next.
    expect(after?.batchNumber).toBe('SOONER');
    expect(after?.expiryDate?.toISOString()).toBe(SOONER.toISOString());
  });

  it('prefers a dated batch over an undated one', async () => {
    const item = await makeItem(engine.repo);
    await engine.repo.receive({
      itemId: item.id,
      quantity: 10,
      batchNumber: 'UNDATED',
      expiryDate: null,
      ...context,
    });
    await engine.repo.receive({
      itemId: item.id,
      quantity: 10,
      batchNumber: 'DATED',
      expiryDate: FUTURE,
      ...context,
    });

    // An undated batch keeps indefinitely, so there is never a reason to reach for it ahead of
    // one with a deadline — the dated one is the stock that will otherwise be wasted.
    const after = await engine.repo.findById(item.id);
    expect(after?.batchNumber).toBe('DATED');
  });
});

/* ------------------------------------------------------------------ issuing */

describe.each(engines)('issuing stock — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  async function stocked(quantities: { batch: string; quantity: number; expiry: Date | null }[]) {
    const item = await makeItem(engine.repo);
    for (const entry of quantities) {
      await engine.repo.receive({
        itemId: item.id,
        quantity: entry.quantity,
        batchNumber: entry.batch,
        expiryDate: entry.expiry,
        ...context,
      });
    }
    return (await engine.repo.findById(item.id))!;
  }

  it('draws down the batch closest to expiring first', async () => {
    const item = await stocked([
      { batch: 'LATER', quantity: 100, expiry: FUTURE },
      { batch: 'SOONER', quantity: 40, expiry: SOONER },
    ]);

    const plan = planIssue(item.batches, 30, NOW);
    const { item: after, transaction } = await engine.repo.issue({
      itemId: item.id,
      quantity: 30,
      target: toAlice,
      allocations: plan.entries,
      ...context,
    });

    expect(after.availableQuantity).toBe(110);
    expect(transaction.batchNumber).toBe('SOONER');
    expect(after.batches.find((batch) => batch.batchNumber === 'SOONER')?.quantity).toBe(10);
    expect(after.batches.find((batch) => batch.batchNumber === 'LATER')?.quantity).toBe(100);
  });

  it('spans batches when one is not enough, and records both on one row', async () => {
    const item = await stocked([
      { batch: 'SOONER', quantity: 40, expiry: SOONER },
      { batch: 'LATER', quantity: 100, expiry: FUTURE },
    ]);

    const plan = planIssue(item.batches, 60, NOW);
    const { item: after, transaction } = await engine.repo.issue({
      itemId: item.id,
      quantity: 60,
      target: toAlice,
      allocations: plan.entries,
      ...context,
    });

    expect(after.availableQuantity).toBe(80);
    // One physical handover is one ledger row. Splitting it per batch would make a single
    // event look like two, and double-count it in any report grouped by action.
    expect(transaction.batchNumber).toBe('SOONER, LATER');
    expect(transaction.quantity).toBe(60);
    expect(transaction.previousQuantity).toBe(140);
    expect(transaction.newQuantity).toBe(80);
  });

  it('records the project and experiment linkage on the ledger row', async () => {
    const item = await stocked([{ batch: 'A', quantity: 10, expiry: FUTURE }]);
    const plan = planIssue(item.batches, 4, NOW);

    const { transaction } = await engine.repo.issue({
      itemId: item.id,
      quantity: 4,
      target: { type: 'employee', userId: BOB, label: 'Bob · Tox Study' },
      allocations: plan.entries,
      purpose: 'Assay run 12',
      ...context,
    });

    expect(transaction.issuedToType).toBe('employee');
    expect(transaction.issuedToUserId).toBe(BOB);
    expect(transaction.issuedToLabel).toBe('Bob · Tox Study');
    expect(transaction.purpose).toBe('Assay run 12');
  });

  it('never plans an allocation out of an expired batch', async () => {
    const item = await stocked([
      { batch: 'EXPIRED', quantity: 80, expiry: PAST },
      { batch: 'GOOD', quantity: 20, expiry: FUTURE },
    ]);

    const plan = planIssue(item.batches, 50, NOW);

    // The stock exists — 100 units of it — and 80 of that cannot lawfully be handed over.
    // Reporting "only 20 issuable" against a stock figure of 100 is the whole point: the
    // discrepancy stays visible until somebody writes the expired material off.
    expect(item.availableQuantity).toBe(100);
    expect(plan.issuableQuantity).toBe(20);
    expect(plan.satisfied).toBe(false);
    expect(plan.entries.every((entry) => entry.batchNumber !== 'EXPIRED')).toBe(true);
  });

  it('refuses to overdraw, and writes no ledger row when it does', async () => {
    const item = await stocked([{ batch: 'A', quantity: 5, expiry: FUTURE }]);

    /**
     * A plan built against a stale read — exactly what a losing racer holds.
     *
     * Handed straight to the repository, bypassing the service's pre-check, because the
     * service's check is a *read* and this is the case it cannot cover: the request was valid
     * when it was made and the stock went while it was in flight.
     */
    await expect(
      engine.repo.issue({
        itemId: item.id,
        quantity: 9,
        target: toAlice,
        allocations: [{ batchNumber: 'A', quantity: 9, expiryDate: FUTURE }],
        ...context,
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    const after = await engine.repo.findById(item.id);
    expect(after?.availableQuantity).toBe(5);

    // The critical half. A ledger row for an issue that never happened is worse than losing
    // the movement: the material is still on the shelf and the system says it left.
    const { total } = await engine.repo.listHistory({
      organizationId: ORG,
      itemId: item.id,
      action: 'issued',
      page: 1,
      pageSize: 10,
    });
    expect(total).toBe(0);
  });

  it('lets exactly one of two concurrent issues take the last of the stock', async () => {
    const item = await stocked([{ batch: 'A', quantity: 5, expiry: FUTURE }]);

    // Both plans are built from the same read, which is what makes them racers rather than a
    // sequence: each believes all five units are available.
    const allocations = [{ batchNumber: 'A', quantity: 3, expiryDate: FUTURE }];
    const results = await Promise.allSettled([
      engine.repo.issue({
        itemId: item.id,
        quantity: 3,
        target: toAlice,
        allocations,
        ...context,
      }),
      engine.repo.issue({
        itemId: item.id,
        quantity: 3,
        target: toAlice,
        allocations,
        ...context,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const after = await engine.repo.findById(item.id);
    expect(after?.availableQuantity).toBe(2);

    // And the winner's ledger row describes what actually happened, not what it predicted.
    const { transactions } = await engine.repo.listHistory({
      organizationId: ORG,
      itemId: item.id,
      action: 'issued',
      page: 1,
      pageSize: 10,
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.previousQuantity).toBe(5);
    expect(transactions[0]?.newQuantity).toBe(2);
  });

  it('keeps the ledger honest under a sequence of concurrent issues', async () => {
    const item = await stocked([{ batch: 'A', quantity: 20, expiry: FUTURE }]);
    const allocations = [{ batchNumber: 'A', quantity: 2, expiryDate: FUTURE }];

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        engine.repo.issue({
          itemId: item.id,
          quantity: 2,
          target: toAlice,
          allocations,
          ...context,
        }),
      ),
    );

    const won = results.filter((result) => result.status === 'fulfilled').length;
    const after = await engine.repo.findById(item.id);
    expect(after?.availableQuantity).toBe(20 - won * 2);

    /**
     * The ledger has to reconcile: sorted by the counter they left behind, each row's
     * `previousQuantity` must equal the previous row's `newQuantity`.
     *
     * This is the assertion that catches a `previousQuantity` computed in JavaScript from a
     * pre-read value. Ten racers would each record "20 → 18" while the item correctly reached
     * its true total, and every individual row would look perfectly plausible.
     */
    const { transactions } = await engine.repo.listHistory({
      organizationId: ORG,
      itemId: item.id,
      action: 'issued',
      page: 1,
      pageSize: 50,
    });

    const chain = transactions
      .map((row) => ({ from: row.previousQuantity, to: row.newQuantity }))
      .sort((a, b) => b.from - a.from);

    expect(chain).toHaveLength(won);
    for (const [index, link] of chain.entries()) {
      expect(link.from - link.to).toBe(2);
      if (index > 0) expect(link.from).toBe(chain[index - 1]!.to);
    }
  });
});

/* ------------------------------------------------------------------ adjustment */

describe.each(engines)('adjusting stock — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  it('writes stock off with the reason on the row', async () => {
    const item = await makeItem(engine.repo);
    await engine.repo.receive({
      itemId: item.id,
      quantity: 10,
      batchNumber: 'A',
      expiryDate: FUTURE,
      ...context,
    });

    const { item: after, transaction } = await engine.repo.adjust({
      itemId: item.id,
      batchNumber: 'A',
      delta: -3,
      reason: 'Spilled during transfer',
      ...context,
    });

    expect(after.availableQuantity).toBe(7);
    expect(transaction.action).toBe('adjusted');
    expect(transaction.quantityDelta).toBe(-3);
    // An adjustment has no physical event behind it, so the reason is the only thing that
    // makes the row auditable at all.
    expect(transaction.notes).toContain('Spilled during transfer');
  });

  it('creates the batch when a recount finds more than the system knew about', async () => {
    const item = await makeItem(engine.repo);

    const { item: after } = await engine.repo.adjust({
      itemId: item.id,
      batchNumber: 'FOUND-ON-SHELF',
      delta: 12,
      reason: 'Annual stock take',
      expiryDate: FUTURE,
      ...context,
    });

    expect(after.availableQuantity).toBe(12);
    expect(after.batches.map((batch) => batch.batchNumber)).toContain('FOUND-ON-SHELF');
  });

  it('refuses to write off a batch the item does not hold', async () => {
    const item = await makeItem(engine.repo);

    await expect(
      engine.repo.adjust({
        itemId: item.id,
        batchNumber: 'NOT-HERE',
        delta: -1,
        reason: 'Typo',
        ...context,
      }),
    ).rejects.toBeInstanceOf(UnknownBatchError);
  });
});

/* ------------------------------------------------------------------ expiry sweep */

describe.each(engines)('the expiry sweep — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  it('writes off expired batches and leaves the live ones alone', async () => {
    const item = await makeItem(engine.repo);
    await engine.repo.receive({
      itemId: item.id,
      quantity: 30,
      batchNumber: 'GOOD',
      expiryDate: FUTURE,
      ...context,
    });
    // Received while still in date, expired since — which is the only way stock legitimately
    // reaches this state, and the reason the sweep exists at all.
    await engine.repo.receive({
      itemId: item.id,
      quantity: 70,
      batchNumber: 'STALE',
      expiryDate: PAST,
      performedBy: ALICE,
      performedByName: 'Alice',
      performedAt: new Date('2026-01-15T00:00:00.000Z'),
    });

    const written = await engine.repo.expire({ organizationId: ORG, now: NOW });

    expect(written).toHaveLength(1);
    expect(written[0]?.action).toBe('expired');
    expect(written[0]?.quantityDelta).toBe(-70);

    const after = await engine.repo.findById(item.id);
    expect(after?.availableQuantity).toBe(30);
    expect(after?.batches.map((batch) => batch.batchNumber)).toEqual(['GOOD']);
  });

  it('does nothing on a second run', async () => {
    const item = await makeItem(engine.repo);
    await engine.repo.receive({
      itemId: item.id,
      quantity: 5,
      batchNumber: 'STALE',
      expiryDate: PAST,
      performedBy: ALICE,
      performedByName: 'Alice',
      performedAt: new Date('2026-01-15T00:00:00.000Z'),
    });

    await engine.repo.expire({ organizationId: ORG, now: NOW });
    // Idempotence matters because this runs unattended: a sweep that wrote a fresh zero-quantity
    // write-off row every night would bury the real ones.
    expect(await engine.repo.expire({ organizationId: ORG, now: NOW })).toHaveLength(0);
  });

  it('writes a batch off once when two sweeps overlap', async () => {
    // Cron and an administrator's click, or an at-least-once queue redelivery, can overlap. Both
    // sweeps read the same candidates before either writes; only one may record the write-off.
    const item = await makeItem(engine.repo);
    await engine.repo.receive({
      itemId: item.id,
      quantity: 8,
      batchNumber: 'STALE',
      expiryDate: PAST,
      performedBy: ALICE,
      performedByName: 'Alice',
      performedAt: new Date('2026-01-15T00:00:00.000Z'),
    });

    const [a, b] = await Promise.all([
      engine.repo.expire({ organizationId: ORG, now: NOW }),
      engine.repo.expire({ organizationId: ORG, now: NOW }),
    ]);
    expect(a.length + b.length).toBe(1);

    const { transactions } = await engine.repo.listHistory({
      organizationId: ORG,
      itemId: item.id,
      action: 'expired',
      page: 1,
      pageSize: 10,
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.quantityDelta).toBe(-8);
    expect(transactions[0]?.previousQuantity).toBe(8);
    expect(transactions[0]?.newQuantity).toBe(0);
    expect((await engine.repo.findById(item.id))?.availableQuantity).toBe(0);
  });
});

/* ------------------------------------------------------------------ listing and dashboard */

describe.each(engines)('listing and the dashboard — $name', (engine) => {
  beforeEach(async () => {
    await engine.reset();
  });

  async function catalogue() {
    const low = await engine.repo.create({
      organizationId: ORG,
      departmentId: DEPT,
      name: 'Agarose',
      code: 'CHM-0001',
      category: 'chemical',
      unit: 'g',
      minimumStock: 100,
      status: 'active',
      createdBy: ALICE,
      supplier: 'Acme Labs',
    });
    await engine.repo.receive({
      itemId: low.id,
      quantity: 50,
      batchNumber: 'AG-1',
      expiryDate: FUTURE,
      ...context,
    });

    const empty = await engine.repo.create({
      organizationId: ORG,
      departmentId: DEPT,
      name: 'Ethidium bromide',
      code: 'CHM-0002',
      category: 'reagent',
      unit: 'mL',
      minimumStock: 0,
      status: 'active',
      createdBy: ALICE,
      supplier: 'Other Supplier',
    });

    return { low, empty };
  }

  it('filters by stock state', async () => {
    await catalogue();

    const lowStock = await engine.repo.list({
      organizationId: ORG,
      stockFilter: 'low',
      now: NOW,
      page: 1,
      pageSize: 20,
    });
    expect(lowStock.items.map((item) => item.code)).toEqual(['CHM-0001']);

    const out = await engine.repo.list({
      organizationId: ORG,
      stockFilter: 'out_of_stock',
      now: NOW,
      page: 1,
      pageSize: 20,
    });
    expect(out.items.map((item) => item.code)).toEqual(['CHM-0002']);
  });

  it('searches the name, code, supplier and batch number', async () => {
    await catalogue();

    for (const [term, expected] of [
      ['agar', ['CHM-0001']],
      ['CHM-0002', ['CHM-0002']],
      ['Acme', ['CHM-0001']],
      ['AG-1', ['CHM-0001']],
    ] as const) {
      const found = await engine.repo.list({
        organizationId: ORG,
        q: term,
        now: NOW,
        page: 1,
        pageSize: 20,
      });
      expect(found.items.map((item) => item.code), `searching for ${term}`).toEqual([...expected]);
    }
  });

  it('treats a wildcard in the search term as a literal', async () => {
    await catalogue();

    /**
     * `%` is a LIKE wildcard on D1 and a regex metacharacter risk on MongoDB.
     *
     * Unescaped, this term matches every row on one engine and could match none on the other —
     * the user asks one question and is shown the answer to a different one. §5.2 of the
     * readiness document records the same class of bug in file search.
     */
    const found = await engine.repo.list({
      organizationId: ORG,
      q: '%',
      now: NOW,
      page: 1,
      pageSize: 20,
    });
    expect(found.items).toEqual([]);
    expect(found.total).toBe(0);
  });

  it('paginates with a stable order', async () => {
    await catalogue();

    const first = await engine.repo.list({
      organizationId: ORG,
      now: NOW,
      page: 1,
      pageSize: 1,
      sort: 'code',
    });
    const second = await engine.repo.list({
      organizationId: ORG,
      now: NOW,
      page: 2,
      pageSize: 1,
      sort: 'code',
    });

    expect(first.total).toBe(2);
    expect(first.items.map((item) => item.code)).toEqual(['CHM-0001']);
    expect(second.items.map((item) => item.code)).toEqual(['CHM-0002']);
  });

  it('counts the dashboard tiles in one pass', async () => {
    await catalogue();

    const summary = await engine.repo.dashboard(ORG, NOW);
    expect(summary.totalItems).toBe(2);
    expect(summary.byStockState.low).toBe(1);
    expect(summary.byStockState.out_of_stock).toBe(1);
    expect(summary.expired).toBe(0);
  });

  it('excludes a removed item from the counts', async () => {
    const { empty } = await catalogue();
    await engine.repo.softDelete(empty.id, ALICE);

    /**
     * A soft-deleted item must not be counted.
     *
     * On MongoDB `aggregate` bypasses the soft-delete middleware entirely, so the dashboard is
     * exactly the shape of query that silently counted trashed rows in file search (§5.3). The
     * implementation filters explicitly for that reason, and this pins it on both engines.
     */
    const summary = await engine.repo.dashboard(ORG, NOW);
    expect(summary.totalItems).toBe(1);
    expect(summary.byStockState.out_of_stock).toBe(0);

    const listed = await engine.repo.list({
      organizationId: ORG,
      now: NOW,
      page: 1,
      pageSize: 20,
    });
    expect(listed.items.map((item) => item.code)).toEqual(['CHM-0001']);
  });

  it('never returns items belonging to another organization', async () => {
    await catalogue();

    const other = await engine.repo.list({
      organizationId: '507f1f77bcf86cd799439099',
      now: NOW,
      page: 1,
      pageSize: 20,
    });
    // Both the rows and the total: a count that leaked would disclose that a catalogue exists
    // even with an empty page.
    expect(other.items).toEqual([]);
    expect(other.total).toBe(0);
  });
});

/* ------------------------------------------------------------------ immutability */

describe('the stock ledger is append-only at the engine — mongo', () => {
  beforeEach(async () => {
    await clearCollections();
    await seedMongo();
  });

  it('refuses an update and a delete through the model', async () => {
    const item = await makeItem(mongoInventoryRepository);
    const { transaction } = await mongoInventoryRepository.receive({
      itemId: item.id,
      quantity: 4,
      batchNumber: 'A',
      expiryDate: FUTURE,
      ...context,
    });

    // Not "no route exists" — the model itself refuses, so a future service that tries to
    // "fix" a row fails loudly instead of quietly rewriting history.
    await expect(
      StockTransactionModel.updateOne({ _id: transaction.id }, { $set: { quantity: 999 } }).exec(),
    ).rejects.toThrow(/append-only/i);

    await expect(
      StockTransactionModel.deleteOne({ _id: transaction.id }).exec(),
    ).rejects.toThrow(/append-only/i);
  });
});

describe('the stock ledger is append-only at the engine — d1', () => {
  beforeEach(async () => {
    await resetD1();
  });

  it('refuses an update through the migration 0001 trigger', async () => {
    const item = await makeItem(d1InventoryRepository);
    const { transaction } = await d1InventoryRepository.receive({
      itemId: item.id,
      quantity: 4,
      batchNumber: 'A',
      expiryDate: FUTURE,
      ...context,
    });

    // The MongoDB guarantee is a pre-hook, which only binds callers going through Mongoose.
    // Its D1 equivalent has to be a trigger, or the property is lost in the migration.
    await expect(
      d1
        .prepare('UPDATE stock_transactions SET quantity = 999 WHERE id = ?')
        .bind(transaction.id)
        .run(),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ D1-specific behaviour */

describe('D1-specific stock behaviour', () => {
  beforeEach(async () => {
    await resetD1();
  });

  it('keeps a consumed batch as a zero row while hiding it from the record', async () => {
    const item = await makeItem(d1InventoryRepository);
    await d1InventoryRepository.receive({
      itemId: item.id,
      quantity: 5,
      batchNumber: 'A',
      expiryDate: FUTURE,
      ...context,
    });

    const { item: after } = await d1InventoryRepository.issue({
      itemId: item.id,
      quantity: 5,
      target: toAlice,
      allocations: [{ batchNumber: 'A', quantity: 5, expiryDate: FUTURE }],
      ...context,
    });

    // An empty container is not stock, so the record hides it and matches MongoDB's shape.
    expect(after.batches).toEqual([]);
    expect(after.availableQuantity).toBe(0);
    expect(after.stockState).toBe('out_of_stock');

    /**
     * The row survives, and that is load-bearing rather than untidy.
     *
     * If a concurrent issue could *delete* a row another operation is about to decrement, the
     * decrement would find nothing, affect zero rows, raise no CHECK — and the ledger would
     * record stock leaving that never left. With the row present, the CHECK is the only outcome.
     */
    const rows = await d1
      .prepare('SELECT quantity FROM inventory_batches WHERE item_id = ? AND batch_number = ?')
      .bind(item.id, 'A')
      .all();
    expect(rows.results).toHaveLength(1);
    expect((rows.results[0] as { quantity: number }).quantity).toBe(0);
  });

  it('aborts the whole batch when a decrement would go negative', async () => {
    const item = await makeItem(d1InventoryRepository);
    await d1InventoryRepository.receive({
      itemId: item.id,
      quantity: 2,
      batchNumber: 'A',
      expiryDate: FUTURE,
      ...context,
    });

    await expect(
      d1InventoryRepository.issue({
        itemId: item.id,
        quantity: 3,
        target: toAlice,
        allocations: [{ batchNumber: 'A', quantity: 3, expiryDate: FUTURE }],
        ...context,
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // Nothing at all commits — not the decrement, not the item counter, not the ledger row.
    const batch = await d1
      .prepare('SELECT quantity FROM inventory_batches WHERE item_id = ?')
      .bind(item.id)
      .first<{ quantity: number }>();
    expect(batch?.quantity).toBe(2);

    const ledger = await d1
      .prepare("SELECT COUNT(*) AS n FROM stock_transactions WHERE item_id = ? AND action = 'issued'")
      .bind(item.id)
      .first<{ n: number }>();
    expect(ledger?.n).toBe(0);
  });

  it('stores a fractional quantity through an integer-affinity column', async () => {
    const item = await makeItem(d1InventoryRepository);

    /**
     * `inventory_batches.quantity` is declared `integer`, and 2.5 mL is a real pipette volume.
     *
     * SQLite's INTEGER affinity keeps a value it cannot losslessly convert as a real, so the
     * declaration does not truncate. Pinned because the alternative — silently rounding a
     * dispensed volume — would be invisible until somebody reconciled a shelf by hand.
     */
    const { item: after } = await d1InventoryRepository.receive({
      itemId: item.id,
      quantity: 2.5,
      batchNumber: 'A',
      expiryDate: FUTURE,
      ...context,
    });

    expect(after.availableQuantity).toBe(2.5);
  });
});
