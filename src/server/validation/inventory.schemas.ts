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
