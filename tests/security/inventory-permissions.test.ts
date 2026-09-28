/**
 * Inventory authorization and the expiry sweep, through the services a route calls.
 *
 * The repository suites (`tests/d1/inventory-repository.test.ts`) prove the engines move stock
 * atomically. This suite proves *who* may move it:
 *
 *   • reading needs `inventory.view` somewhere; nothing at all is a plain 403;
 *   • a department-scoped store manager reaches their own department's items only — never
 *     another department's, never the central store, and never an adjustment;
 *   • an item in another organization is indistinguishable from one that does not exist;
 *   • the organization-wide expiry sweep is a company-scope action, and the scheduled sweep is
 *     idempotent, including when two runs overlap.
 *
 * Real MongoDB, real services, fixture users assembled by the real grant path (`actorFor`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

import { startTestDb, stopTestDb, type TestDb } from '../helpers/test-db';
import { actorFor, seedFixture, TEST_META, type Fixture } from '../helpers/fixtures';
import { ForbiddenError, NotFoundError } from '@/server/errors/app-error';
import type { Actor } from '@/server/permissions/actor';

let db: TestDb;
let fixture: Fixture;
const actors: Record<string, Actor> = {};
const items = { molbio: '', anchem: '', central: '', foreign: '' };

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  db = await startTestDb();
  if (!db.available) throw new Error(`MongoDB is required: ${db.reason}`);
  fixture = await seedFixture();

  for (const key of ['inventoryAdmin', 'storeManager', 'noRole', 'scientistA'] as const) {
    actors[key] = await actorFor(fixture.users[key]);
  }

  const { inventoryService } = await import('@/server/services/inventory.service');
  const make = async (code: string, departmentId: string | null) =>
    (
      await inventoryService.create(
        actors.inventoryAdmin!,
        { name: `Item ${code}`, code, category: 'reagent', unit: 'mL', departmentId },
        TEST_META,
      )
    ).id;
  items.molbio = await make('INV-MOLBIO', fixture.departments.molbio);
  items.anchem = await make('INV-ANCHEM', fixture.departments.anchem);
  items.central = await make('INV-CENTRAL', null);

  // An item in an organization nobody here belongs to, created below the service layer.
  const repository = await import('@/server/repositories/inventory-item.repository');
  items.foreign = (
    await repository.create({
      organizationId: new Types.ObjectId().toString(),
      departmentId: null,
      name: 'Foreign item',
      code: 'INV-FOREIGN',
      category: 'reagent',
      unit: 'mL',
      minimumStock: 0,
      status: 'active',
      createdBy: new Types.ObjectId().toString(),
    })
  ).id;
}, 180_000);

afterAll(async () => {
  if (db?.available) await stopTestDb();
});

async function receive(actor: Actor, itemId: string, quantity = 5, expiryDate?: Date) {
  const { stockService } = await import('@/server/services/stock.service');
  return stockService.receive(
    actor,
    { itemId, quantity, batchNumber: `LOT-${Math.random().toString(36).slice(2, 8)}`, ...(expiryDate ? { expiryDate } : {}) },
    TEST_META,
  );
}

describe('who may move stock', () => {
  it('refuses somebody with no inventory permission at all, with a plain 403', async () => {
    await expect(receive(actors.noRole!, items.molbio)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets a department store manager receive into their own department', async () => {
    const result = await receive(actors.storeManager!, items.molbio, 4);
    expect(result.item.availableQuantity).toBeGreaterThanOrEqual(4);
  });

  it('refuses the store manager on another department, and on the central store', async () => {
    await expect(receive(actors.storeManager!, items.anchem)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(receive(actors.storeManager!, items.central)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses the store manager an adjustment, even in their own department', async () => {
    const { stockService } = await import('@/server/services/stock.service');
    await expect(
      stockService.adjust(
        actors.storeManager!,
        { itemId: items.molbio, batchNumber: 'ANY', delta: -1, reason: 'Recount' },
        TEST_META,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reports an item in another organization as not found — to the company inventory admin too', async () => {
    await expect(receive(actors.inventoryAdmin!, items.foreign)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets the company inventory administrator move stock anywhere in the organization', async () => {
    for (const itemId of [items.molbio, items.anchem, items.central]) {
      await expect(receive(actors.inventoryAdmin!, itemId, 1)).resolves.toBeTruthy();
    }
  });
});

describe('the expiry sweep', () => {
  it('may be run by hand only from company scope', async () => {
    const { stockService } = await import('@/server/services/stock.service');
    await expect(stockService.sweepExpiredForActor(actors.storeManager!, TEST_META)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(stockService.sweepExpiredForActor(actors.noRole!, TEST_META)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(stockService.sweepExpiredForActor(actors.inventoryAdmin!, TEST_META)).resolves.toBeInstanceOf(Array);
  });

  it('writes expired stock off once, and a second run writes nothing', async () => {
    const { stockService } = await import('@/server/services/stock.service');
    await receive(actors.inventoryAdmin!, items.anchem, 3, new Date(Date.now() + DAY));

    const later = new Date(Date.now() + 2 * DAY);
    const first = await stockService.sweepExpired(fixture.organizationId, { now: later });
    expect(first.map((row) => row.itemId)).toContain(items.anchem);
    expect(first.find((row) => row.itemId === items.anchem)!.quantity).toBe(3);

    const second = await stockService.sweepExpired(fixture.organizationId, { now: later });
    expect(second).toHaveLength(0);
  });

  it('two overlapping runs write each expired batch off exactly once', async () => {
    const { stockService } = await import('@/server/services/stock.service');
    const repository = await import('@/server/repositories/inventory-item.repository');
    await receive(actors.inventoryAdmin!, items.central, 2, new Date(Date.now() + DAY));

    const later = new Date(Date.now() + 3 * DAY);
    const [a, b] = await Promise.all([
      stockService.sweepExpired(fixture.organizationId, { now: later }),
      stockService.sweepExpired(fixture.organizationId, { now: later }),
    ]);
    const forItem = [...a, ...b].filter((row) => row.itemId === items.central);
    expect(forItem).toHaveLength(1);

    const history = await repository.listHistory({
      organizationId: fixture.organizationId,
      itemId: items.central,
      action: 'expired',
      page: 1,
      pageSize: 50,
    });
    expect(history.total).toBe(1);
  });

  it('the scheduled job sweeps the deployment organization and leaves a system audit record', async () => {
    const { runMaintenanceJob } = await import('@/server/services/maintenance.service');
    const { AuditLogModel } = await import('@/server/db/models');

    // Nothing is expired at the real "now": the job runs and writes nothing.
    await expect(runMaintenanceJob('inventory.expire')).resolves.toEqual({ itemsWrittenOff: 0 });
    expect(await AuditLogModel.countDocuments({ actorEmail: 'system:inventory-expiry-sweep' })).toBe(0);

    await receive(actors.inventoryAdmin!, items.molbio, 6, new Date(Date.now() + DAY));
    // Only `Date` is faked: the MongoDB driver's own timers keep running.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 5 * DAY);
      const result = await runMaintenanceJob('inventory.expire');
      expect(result.itemsWrittenOff).toBeGreaterThanOrEqual(1);
      await expect(runMaintenanceJob('inventory.expire')).resolves.toEqual({ itemsWrittenOff: 0 });
    } finally {
      vi.useRealTimers();
    }

    const audit = await AuditLogModel.find({ actorEmail: 'system:inventory-expiry-sweep' }).lean().exec();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.organizationId?.toString()).toBe(fixture.organizationId);
    expect(audit[0]!.action).toBe('inventory.stock_expired');
  });
});
