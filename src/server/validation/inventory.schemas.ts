import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common';
import {
  INVENTORY_CATEGORIES,
  INVENTORY_ITEM_STATUSES,
  INVENTORY_STOCK_FILTERS,
  INVENTORY_UNITS,
} from '@/server/domain/inventory';

/**
 * An item code is printed on a shelf label and read back by somebody holding a bottle, so
 * it is constrained to characters that survive that round trip: letters, digits, hyphen,
 * underscore, dot. The same rule the experiment code uses, for the same reason.
 */
export const inventoryCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, numbers, dots, hyphens or underscores')
  .transform((value) => value.toUpperCase());

const shortText = (max: number) => z.string().trim().max(max);

/**
 * A quantity is a finite, non-negative number with at most three decimals.
 *
 * `.finite()` is not decoration: JSON accepts `1e400`, which parses to Infinity, and an
 * Infinity that reached `$inc` would make the counter permanently unusable. Three decimals
 * is the precision a balance or a pipette actually reports.
 */
export const quantitySchema = z
  .number()
  .finite()
  .nonnegative()
  .max(1_000_000_000)
  .refine((value) => Number.isInteger(value * 1000), 'Use at most three decimal places');

export const positiveQuantitySchema = quantitySchema.refine(
  (value) => value > 0,
  'Enter a quantity greater than zero',
);

export const createInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: inventoryCodeSchema,
  category: z.enum(INVENTORY_CATEGORIES),
  unit: z.enum(INVENTORY_UNITS),
  departmentId: z.union([objectIdSchema, z.null()]).optional(),
  description: shortText(4000).optional(),
  minimumStock: quantitySchema.optional(),
  storageLocation: shortText(120).optional(),
  supplier: shortText(200).optional(),
  status: z.enum(INVENTORY_ITEM_STATUSES).optional(),
});

/**
 * `code` is absent, and so is every quantity field.
 *
 * Their absence is the control, not an oversight: `strict()` makes an attempt to send
 * `availableQuantity` a 422 rather than a silently ignored field, so a client cannot move
 * stock without going through a path that records why.
 */
export const updateInventoryItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    category: z.enum(INVENTORY_CATEGORIES).optional(),
    unit: z.enum(INVENTORY_UNITS).optional(),
    departmentId: z.union([objectIdSchema, z.null()]).optional(),
    description: shortText(4000).optional(),
    minimumStock: quantitySchema.optional(),
    storageLocation: shortText(120).optional(),
    supplier: shortText(200).optional(),
    status: z.enum(INVENTORY_ITEM_STATUSES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/* ------------------------------------------------------------------ stock movement */

/**
 * A date the client supplies for a movement.
 *
 * Accepts an ISO string and refuses anything unparseable, rather than letting `new Date()`
 * produce an Invalid Date that would be stored as `null` and silently lose the backdating.
 */
const movementDateSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().date())
  .transform((value) => new Date(value))
  .refine((value) => !Number.isNaN(value.getTime()), 'Enter a valid date');

const batchNumberSchema = z.string().trim().min(1).max(80);

export const receiveStockSchema = z
  .object({
    quantity: positiveQuantitySchema,
    batchNumber: batchNumberSchema,
    expiryDate: movementDateSchema.nullish(),
    supplier: shortText(200).optional(),
    storageLocation: shortText(120).optional(),
    purpose: shortText(500).optional(),
    notes: shortText(2000).optional(),
    performedAt: movementDateSchema.optional(),
  })
  .strict();

/**
 * `issuedToType` names which of the four links is the *reason* for the issue.
 *
 * All four may be present — stock issued to an employee for an experiment on a project is one
 * movement, not three — but the declared type must be populated, which the service checks
 * because only it can resolve the ids. Validating it here as well would mean two places that
 * can disagree about what "issued to a project" means.
 */
export const issueStockSchema = z
  .object({
    quantity: positiveQuantitySchema,
    issuedToType: z.enum(['employee', 'department', 'project', 'experiment']),
    issuedToUserId: objectIdSchema.optional(),
    issuedToDepartmentId: objectIdSchema.optional(),
    projectId: objectIdSchema.optional(),
    experimentId: objectIdSchema.optional(),
    purpose: shortText(500).optional(),
    notes: shortText(2000).optional(),
    performedAt: movementDateSchema.optional(),
  })
  .strict();

/**
 * `delta` is signed and `reason` is mandatory.
 *
 * An adjustment is the only movement with no physical event behind it, so the reason is the
 * only thing that makes the row auditable at all. `.min(3)` rather than `.min(1)`: a single
 * character satisfies a required field and explains nothing.
 */
export const adjustStockSchema = z
  .object({
    batchNumber: batchNumberSchema,
    delta: z
      .number()
      .finite()
      .refine((value) => value !== 0, 'Enter an adjustment other than zero')
      .refine((value) => Math.abs(value) <= 1_000_000_000, 'That adjustment is too large')
      .refine(
        (value) => Number.isInteger(Math.round(value * 1000)),
        'Use at most three decimal places',
      ),
    reason: z.string().trim().min(3).max(500),
    expiryDate: movementDateSchema.nullish(),
    notes: shortText(2000).optional(),
    performedAt: movementDateSchema.optional(),
  })
  .strict();

/**
 * The envelope the stock route parses first.
 *
 * `payload` is `unknown` here and re-parsed against the action's own schema in the route. The
 * alternative — a `z.discriminatedUnion` over three fully-specified bodies — reports every
 * failure as "no matching discriminator" when the action is right and one field inside is
 * wrong, which is the case a user actually hits.
 */
export const stockMovementSchema = z.object({
  action: z.enum(['add', 'issue', 'adjust']),
  payload: z.unknown(),
});

export const listStockHistorySchema = paginationSchema.extend({
  itemId: objectIdSchema.optional(),
  action: z.enum(['added', 'issued', 'returned', 'adjusted', 'expired']).optional(),
  projectId: objectIdSchema.optional(),
  experimentId: objectIdSchema.optional(),
  issuedToUserId: objectIdSchema.optional(),
  performedBy: objectIdSchema.optional(),
  from: movementDateSchema.optional(),
  to: movementDateSchema.optional(),
});

export const listInventoryItemsSchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(80).optional(),
  category: z.enum(INVENTORY_CATEGORIES).optional(),
  status: z.enum(INVENTORY_ITEM_STATUSES).optional(),
  departmentId: objectIdSchema.optional(),
  supplier: z.string().trim().min(1).max(200).optional(),
  storageLocation: z.string().trim().min(1).max(120).optional(),
  stockFilter: z.enum(INVENTORY_STOCK_FILTERS).optional(),
  sort: z.enum(['name', 'code', 'quantity', 'expiry', 'updated']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
