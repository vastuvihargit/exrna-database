import { z } from 'zod';
import { Types } from 'mongoose';

/** A MongoDB ObjectId supplied by a client. Rejects anything that is not 24 hex chars. */
export const objectIdSchema = z
  .string()
  .refine((value) => Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value), {
    message: 'Invalid identifier',
  });

/** Page/pageSize with hard caps — an unbounded page size is a denial-of-service lever. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const sortSchema = z.object({
  sort: z.string().max(40).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

/** Free-text search, length-capped and never used as a raw regex downstream. */
export const searchSchema = z.object({
  search: z.string().trim().min(1).max(80).optional(),
});

/** Parses URLSearchParams with a schema, returning typed values. */
export function parseQuery<T extends z.ZodTypeAny>(schema: T, url: string): z.infer<T> {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  return schema.parse(params) as z.infer<T>;
}

export type Pagination = z.infer<typeof paginationSchema>;
