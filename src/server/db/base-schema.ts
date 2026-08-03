/**
 * Shared schema building blocks.
 *
 * Every collection gets the same defaults so cross-cutting rules (soft delete,
 * timestamps, and never serializing internal fields) cannot be forgotten per model.
 */
import { Schema, type SchemaOptions, type Document } from 'mongoose';

/** Fields that must never appear in an API response, regardless of the model. */
const ALWAYS_HIDDEN = [
  '__v',
  'passwordHash',
  'tokenHash',
  'csrfTokenHash',
  'mfa.secret',
  'mfa.backupCodes',
  // Physical storage location: internal only (docs/phase-0/04-storage.md rule 2).
  'storageKey',
  'relativeStoragePath',
  'storedFilename',
];

/**
 * `satisfies` rather than a type annotation: annotating this as SchemaOptions widens
 * it enough that Mongoose's `InferSchemaType` stops resolving document fields and
 * every model degrades to the raw definition type.
 */
export const baseSchemaOptions = {
  timestamps: true,
  versionKey: '__v',
  minimize: false,
  strict: 'throw', // an unknown field is a bug, not something to silently drop
  toJSON: {
    virtuals: true,
    transform(_doc: Document, ret: Record<string, unknown>) {
      ret.id = String(ret._id);
      delete ret._id;
      for (const field of ALWAYS_HIDDEN) {
        if (field.includes('.')) {
          const [parent, child] = field.split('.') as [string, string];
          const container = ret[parent];
          if (container && typeof container === 'object') {
            delete (container as Record<string, unknown>)[child];
          }
        } else {
          delete ret[field];
        }
      }
      return ret;
    },
  },
  toObject: { virtuals: true },
} satisfies SchemaOptions;

/** Soft-delete fields shared by every user-visible entity. */
export const softDeleteFields = {
  deletedAt: { type: Date, default: null, index: true },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
} as const;

/**
 * Applies a default `deletedAt: null` filter to every find/count/update.
 *
 * Applying this in the schema rather than in each query is what makes it impossible
 * to accidentally list trashed records in a new endpoint. `withDeleted: true` in the
 * query options opts out explicitly (Trash views, purge jobs).
 */
export function applySoftDeleteFilter(schema: Schema): void {
  const hooks = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'countDocuments',
    'updateMany',
    'updateOne',
  ] as const;

  for (const hook of hooks) {
    schema.pre(hook, function preSoftDelete(this: { getOptions: () => Record<string, unknown>; getFilter: () => Record<string, unknown>; where: (c: Record<string, unknown>) => unknown }) {
      const options = this.getOptions();
      if (options.withDeleted === true) return;
      const filter = this.getFilter();
      if (Object.prototype.hasOwnProperty.call(filter, 'deletedAt')) return;
      this.where({ deletedAt: null });
    });
  }
}

/** Common enum values shared across collections. */
export const RESOURCE_STATUSES = ['active', 'archived', 'trashed'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const CONFIDENTIALITY_LEVELS = [
  'public_internal',
  'internal',
  'confidential',
  'restricted',
] as const;
export type ConfidentialityLevel = (typeof CONFIDENTIALITY_LEVELS)[number];
