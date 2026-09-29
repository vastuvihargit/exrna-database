/**
 * The inventory vocabulary.
 *
 * One definition, several consumers: the TypeScript types, the Zod schemas, the Mongoose
 * enums and the UI labels. Adding a category or a unit here is the only place it needs to
 * be declared.
 *
 * The functions at the bottom are pure and have no database or clock dependency — the
 * current time is always passed in. That is what makes the expiry rules testable without
 * a fixture, and it is the reason the same helpers can be reused by the read path, the
 * write path and the expiry sweep without any of them disagreeing about what "expired"
 * means.
 */

export const INVENTORY_CATEGORIES = [
  'chemical',
  'reagent',
  'consumable',
  'glassware',
  'equipment',
  'other',
] as const;
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

/**
 * Units are an enum rather than free text on purpose.
 *
 * A quantity is only meaningful next to its unit, and "500 ml" / "500 mL" / "500 millilitres"
 * typed by three different people produce three items that look like stock in three different
 * materials. Anything genuinely outside this list is recorded as `other` and explained in the
 * description, which is visible, rather than as a new spelling nobody can search for.
 */
export const INVENTORY_UNITS = [
  'mg',
  'g',
  'kg',
  'µL',
  'mL',
  'L',
  'units',
  'vials',
  'tubes',
  'plates',
  'boxes',
  'packs',
  'rolls',
  'other',
] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];

export const INVENTORY_ITEM_STATUSES = ['active', 'inactive', 'discontinued'] as const;
export type InventoryItemStatus = (typeof INVENTORY_ITEM_STATUSES)[number];

/**
 * Stored on the item and recomputed on every write, rather than derived at query time.
 *
 * "Low stock" is a comparison between two fields, and MongoDB cannot use an index for
 * `$expr: { $lte: ['$availableQuantity', '$minimumStock'] }`. The dashboard and the alert
 * page both filter on it, so it is worth a field.
 */
export const STOCK_STATES = ['ok', 'low', 'out_of_stock'] as const;
export type StockState = (typeof STOCK_STATES)[number];

/**
 * Expiry state is NOT stored: it depends on the current time, and a stored copy is wrong
 * the moment the clock passes midnight. It is derived from the indexed `expiryDate`.
 */
export const EXPIRY_STATES = ['none', 'ok', 'near_expiry', 'expired'] as const;
export type ExpiryState = (typeof EXPIRY_STATES)[number];

/** How far ahead "near expiry" looks. */
export const NEAR_EXPIRY_DAYS = 30;

/**
 * A cap on the embedded batch array.
 *
 * Batches live inside the item document so that checking availability and decrementing it
 * are one atomic update (see stock.service). That is only safe while the array stays small,
 * so receiving into a 500-batch item is refused rather than allowed to grow without bound.
 * Fully consumed batches are pruned; their history survives in `stockTransactions`.
 */
export const MAX_BATCHES_PER_ITEM = 500;

/** The filters offered by the item list and the alert page. */
export const INVENTORY_STOCK_FILTERS = [
  'available',
  'low',
  'out_of_stock',
  'near_expiry',
  'expired',
] as const;
export type InventoryStockFilter = (typeof INVENTORY_STOCK_FILTERS)[number];

export interface BatchLike {
  batchNumber: string;
  quantity: number;
  expiryDate: Date | null;
}

export function stockStateFor(availableQuantity: number, minimumStock: number): StockState {
  if (availableQuantity <= 0) return 'out_of_stock';
  // `<=` rather than `<`: a minimum stock level is the point at which you reorder, not the
  // point at which you have already run below it.
  if (availableQuantity <= minimumStock) return 'low';
  return 'ok';
}

export function expiryStateFor(
  expiryDate: Date | null | undefined,
  now: Date,
  nearExpiryDays: number = NEAR_EXPIRY_DAYS,
): ExpiryState {
  if (!expiryDate) return 'none';
  if (expiryDate.getTime() < now.getTime()) return 'expired';
  if (expiryDate.getTime() <= nearExpiryCutoff(now, nearExpiryDays).getTime()) return 'near_expiry';
  return 'ok';
}

export function nearExpiryCutoff(now: Date, nearExpiryDays: number = NEAR_EXPIRY_DAYS): Date {
  return new Date(now.getTime() + nearExpiryDays * 24 * 60 * 60 * 1000);
}

/** A batch is issuable when it still holds stock and has not passed its expiry date. */
export function isBatchIssuable(batch: BatchLike, now: Date): boolean {
  if (batch.quantity <= 0) return false;
  return expiryStateFor(batch.expiryDate, now) !== 'expired';
}

export interface BatchSummary {
  availableQuantity: number;
  /** The batch that should be consumed next — earliest expiry first, then earliest received. */
  batchNumber: string;
  /** Earliest expiry among batches that still hold stock. */
  expiryDate: Date | null;
}

/**
 * Recomputes the item's summary fields from its batches.
 *
 * These fields are denormalized so that listing, filtering and alerting are indexable —
 * they are never the source of truth. Every write that touches `batches` calls this in the
 * same update, and a test asserts the two agree after a randomised sequence of operations.
 *
 * The chosen batch is the one a store manager would hand over next: first-expiry-first-out,
 * because the alternative wastes the stock that was about to expire.
 */
export function summarizeBatches(batches: readonly BatchLike[]): BatchSummary {
  let availableQuantity = 0;
  let earliest: BatchLike | null = null;
  let fallback: BatchLike | null = null;

  for (const batch of batches) {
    if (batch.quantity <= 0) continue;
    availableQuantity += batch.quantity;

    if (!batch.expiryDate) {
      // A batch with no expiry date can only be the answer if nothing dated is in stock.
      fallback ??= batch;
      continue;
    }
    if (!earliest?.expiryDate || batch.expiryDate.getTime() < earliest.expiryDate.getTime()) {
      earliest = batch;
    }
  }

  const chosen = earliest ?? fallback;
  return {
    availableQuantity,
    batchNumber: chosen?.batchNumber ?? '',
    expiryDate: chosen?.expiryDate ?? null,
  };
}

/* ------------------------------------------------------------------ issuing */

export interface IssuePlanEntry {
  batchNumber: string;
  quantity: number;
  expiryDate: Date | null;
}

export interface IssuePlan {
  entries: IssuePlanEntry[];
  /** The total across issuable batches, which is what a shortfall message must quote. */
  issuableQuantity: number;
  /** True when `entries` covers the whole request. */
  satisfied: boolean;
}

/**
 * Decides which batches an issue draws from, and how much from each.
 *
 * Lives here rather than in either repository because **both engines must make exactly the same
 * choice**. If MongoDB drew from the oldest batch and D1 from the largest, the same request
 * would produce two different ledgers, and the migration comparison in Phase 9 would report a
 * mismatch that was not a data error.
 *
 * ── First expiry first out ──────────────────────────────────────────────────────────────
 *
 * The order is the one a store manager would use by hand: consume what is closest to expiring,
 * so the stock that was about to be wasted is the stock that gets used. Batches with no expiry
 * date sort last — an undated batch keeps indefinitely, so there is never a reason to reach for
 * it ahead of one with a deadline. `receivedAt` breaks ties, oldest first.
 *
 * ── Expired batches are skipped, and that is deliberate ─────────────────────────────────
 *
 * They are not silently consumed *and* not silently ignored. They contribute nothing to
 * `issuableQuantity`, so an item holding 10 L of which 8 L expired reports 2 L available to
 * issue and the caller is refused a 5 L request against a stock figure of 10. That refusal is
 * the point: the alternative is somebody running an assay with reagent that expired last month.
 *
 * The expired material stays on the books until it is written off, so `availableQuantity` still
 * reads 10 and the discrepancy is visible rather than quietly reconciled.
 */
export function planIssue(
  batches: readonly (BatchLike & { receivedAt?: Date })[],
  requested: number,
  now: Date,
): IssuePlan {
  const issuable = batches
    .filter((batch) => isBatchIssuable(batch, now))
    .sort(compareForIssue);

  const issuableQuantity = issuable.reduce((total, batch) => total + batch.quantity, 0);

  const entries: IssuePlanEntry[] = [];
  let remaining = requested;

  for (const batch of issuable) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, batch.quantity);
    entries.push({
      batchNumber: batch.batchNumber,
      quantity: take,
      expiryDate: batch.expiryDate,
    });
    remaining -= take;
  }

  return { entries, issuableQuantity, satisfied: remaining <= 0 };
}

function compareForIssue(
  a: BatchLike & { receivedAt?: Date },
  b: BatchLike & { receivedAt?: Date },
): number {
  // An undated batch sorts after every dated one, whichever side it appears on.
  if (a.expiryDate && b.expiryDate) {
    const difference = a.expiryDate.getTime() - b.expiryDate.getTime();
    if (difference !== 0) return difference;
  } else if (a.expiryDate) {
    return -1;
  } else if (b.expiryDate) {
    return 1;
  }

  const received = (a.receivedAt?.getTime() ?? 0) - (b.receivedAt?.getTime() ?? 0);
  if (received !== 0) return received;

  // A total order, so the plan is reproducible across engines and across runs.
  return a.batchNumber.localeCompare(b.batchNumber);
}

export const CATEGORY_LABELS: Record<InventoryCategory, string> = {
  chemical: 'Chemicals',
  reagent: 'Reagents',
  consumable: 'Consumables',
  glassware: 'Glassware',
  equipment: 'Equipment',
  other: 'Other',
};
