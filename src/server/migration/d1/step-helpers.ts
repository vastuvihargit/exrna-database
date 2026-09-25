/**
 * The one MongoDB read shape every step uses, and the two rules that make it safe.
 *
 * ── Rule 1: read trashed rows ───────────────────────────────────────────────────────────
 *
 * `applySoftDeleteFilter` hides `deletedAt != null` from every ordinary query, which is right
 * for the application and wrong for a migration: the Trash is a feature. A trashed file is
 * restorable for `trashRetentionDays`, and a migration that quietly dropped it would present
 * the employee who trashed it yesterday with an empty Trash and no way to get it back. Every
 * step that reads a soft-deleting collection sets `withDeleted: true`.
 *
 * ── Rule 2: read the fields marked `select: false` ──────────────────────────────────────
 *
 * `passwordHash`, the MFA secret and backup codes, and both session token hashes are excluded
 * from ordinary reads *by the schema*, so a migration that did not ask for them would write a
 * complete-looking `users` table in which nobody can log in — and the failure would only appear
 * at cutover, on the first login, with the rollback window running.
 */
import type { FilterQuery, Model } from 'mongoose';
import { Types } from 'mongoose';
import type {
  DeltaFilter,
  MigrationStep,
  SourceDocument,
  StepContext,
  StepOutcome,
} from './types';

export interface ModelStepConfig {
  name: string;
  description: string;
  targets: readonly string[];
  requires: readonly string[];
  publishes?: string;
  /** `Model<any>` — the steps are deliberately schema-agnostic; the transform does the typing. */
  model: Model<never>;
  /** Set for every collection carrying `softDeleteFields`. */
  withDeleted?: boolean;
  /** Extra projection, for `select: false` fields. Mongoose's `+field` syntax. */
  select?: string;
  /**
   * Which timestamp a delta run filters on.
   *
   * `updatedAt` where the collection has one. `createdAt` for the append-only collections
   * (audit, activities, approvals, stock movements) where it is the only truth available.
   * `null` means the collection cannot answer "changed since" and migrates in full on a delta
   * run — stated rather than silently skipped, because a partial delta is worse than a slow one.
   */
  deltaField: 'updatedAt' | 'createdAt' | null;
  transform: (document: SourceDocument, context: StepContext) => StepOutcome;
}

export function modelStep(config: ModelStepConfig): MigrationStep {
  const filterFor = (afterId: string | null, delta: DeltaFilter): FilterQuery<never> => {
    const filter: Record<string, unknown> = {};
    if (afterId) filter._id = { $gt: new Types.ObjectId(afterId) };
    if (delta.since && config.deltaField) filter[config.deltaField] = { $gte: delta.since };
    return filter as FilterQuery<never>;
  };

  return {
    name: config.name,
    description: config.description,
    targets: config.targets,
    requires: config.requires,
    ...(config.publishes ? { publishes: config.publishes } : {}),

    async count(delta) {
      const query = config.model.countDocuments(filterFor(null, delta));
      if (config.withDeleted) query.setOptions({ withDeleted: true });
      return query.exec();
    },

    async read(afterId, limit, delta) {
      const query = config.model
        .find(filterFor(afterId, delta))
        // `_id` ascending is the resume cursor: ObjectId hex sorts monotonically by creation
        // time, so a restart continues from one stored value with no offset and no risk of a
        // concurrently inserted row shifting a page boundary.
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
      if (config.withDeleted) query.setOptions({ withDeleted: true });
      if (config.select) query.select(config.select);
      return (await query.exec()) as unknown as SourceDocument[];
    },

    transform: config.transform,
  };
}

/**
 * A back-fill step: re-reads a collection it has already loaded and issues UPDATEs.
 *
 * Exists because three relationships in this schema are genuinely circular — a department has
 * a head who is a user who belongs to a department; a folder has a parent folder; a comment has
 * a parent comment — and SQLite checks foreign keys per statement, so there is no ordering that
 * satisfies them in one pass. The first pass writes the referencing column as NULL; this writes
 * the real value once both ends exist.
 *
 * Kept as its own step, with its own checkpoint row, so a resumed run knows whether the
 * back-fill happened. A run that loaded folders and died before their parents were written has
 * a flat folder tree, and "did the back-fill run?" is the only question that distinguishes it
 * from a corpus that genuinely has no nesting.
 */
export function backfillStep(config: ModelStepConfig): MigrationStep {
  return modelStep(config);
}
