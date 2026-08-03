/**
 * One administrator's decision to move a defined set of files into Google Shared Drive.
 *
 * ⚠ **Not `MigrationJob`.** This platform already has a collection by that name and it runs
 * in the opposite direction: an interactive, read-only *import* from somebody's Drive into
 * this application. Reusing it would put a write-capable, organization-wide storage backend
 * inside documents keyed for an inbound importer — the two would corrupt each other's
 * counters and their audit trails would be indistinguishable. Hence the separate model,
 * the separate `storagemigrationjobs` collection, and the `storage_migration.*` audit
 * prefix. See §3 of docs/storage-migration/00-phase-0-analysis.md.
 *
 * The per-version record is `StorageMigrationItem`; this holds the selection, the mode, the
 * counters and the state machine.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

/**
 * What a run is allowed to do. The modes differ in exactly which side effects they permit,
 * which is why this is a stored field and not a runtime flag — a paused job resumed
 * tomorrow must run in the mode it was authorised for.
 *
 *   dry_run      reads local bytes, writes nothing anywhere but the item rows
 *   migrate      the real thing
 *   verify_only  re-checks already-migrated objects against Drive metadata, no transfers
 *   rollback     flips records back to local; the Drive object is left in place
 */
export const STORAGE_MIGRATION_MODES = ['dry_run', 'migrate', 'verify_only', 'rollback'] as const;
export type StorageMigrationMode = (typeof STORAGE_MIGRATION_MODES)[number];

export const STORAGE_MIGRATION_JOB_STATUSES = [
  'draft',
  'planning',
  'planned',
  'running',
  'paused',
  'completed',
  'completed_with_failures',
  'failed',
  'cancelled',
] as const;
export type StorageMigrationJobStatus = (typeof STORAGE_MIGRATION_JOB_STATUSES)[number];

/**
 * Which versions this job covers.
 *
 * Every criterion is optional and they combine with AND. All empty is not "everything" —
 * the planner refuses an unbounded selection, because "migrate the entire corpus in one
 * uncontrolled operation" is the thing the phase plan exists to prevent.
 */
const selectionFields = {
  folderIds: { type: [Schema.Types.ObjectId], ref: 'Folder', default: [] },
  /** Includes everything beneath the selected folders, not just direct children. */
  includeDescendants: { type: Boolean, default: true },
  departmentIds: { type: [Schema.Types.ObjectId], ref: 'Department', default: [] },
  projectIds: { type: [Schema.Types.ObjectId], ref: 'Project', default: [] },
  /** Lower-cased, no dot: `fastq`, `pdf`. */
  extensions: { type: [String], default: [] },
  uploadedAfter: { type: Date, default: null },
  uploadedBefore: { type: Date, default: null },
  /** An explicit list, which overrides every other criterion when non-empty. */
  versionIds: { type: [Schema.Types.ObjectId], ref: 'FileVersion', default: [] },
  /** Migrate only the current version of each file. Off by default — see the note below. */
  currentVersionsOnly: { type: Boolean, default: false },
} as const;

/**
 * Counters, in items rather than files.
 *
 * The unit of work is the **version**: a file with five versions is five transfers. Counting
 * files instead would make a progress bar that finishes at 20% of the actual work, and
 * migrating only current versions would silently make version history unrecoverable once
 * local copies are deleted — which is why `currentVersionsOnly` defaults to false.
 */
const counterFields = {
  selected: { type: Number, default: 0, min: 0 },
  selectedBytes: { type: Number, default: 0, min: 0 },
  uploaded: { type: Number, default: 0, min: 0 },
  uploadedBytes: { type: Number, default: 0, min: 0 },
  verified: { type: Number, default: 0, min: 0 },
  failed: { type: Number, default: 0, min: 0 },
  /** Already migrated, or a Google-native document with no bytes to move. */
  skipped: { type: Number, default: 0, min: 0 },
  rolledBack: { type: Number, default: 0, min: 0 },
} as const;

const storageMigrationJobSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 2000 },

    mode: { type: String, enum: STORAGE_MIGRATION_MODES, required: true },
    status: { type: String, enum: STORAGE_MIGRATION_JOB_STATUSES, default: 'draft' },

    selection: selectionFields,
    counters: counterFields,

    /**
     * Set by an administrator to stop the worker at the next item boundary. Distinct from
     * `status: 'paused'`, which is what the worker sets once it has actually stopped — the
     * gap between the two is a running transfer being allowed to finish rather than being
     * torn in half.
     */
    pauseRequested: { type: Boolean, default: false },
    cancelRequested: { type: Boolean, default: false },

    /**
     * Rolling throughput samples for the dashboard's MB/s and ETA. Capped by the writer;
     * an unbounded array here would grow the document past MongoDB's 16 MB limit on a long
     * migration and fail every subsequent update.
     */
    throughputSamples: {
      type: [{ at: Date, bytes: Number, _id: false }],
      default: [],
    },

    /** Failure reasons grouped by code, so the dashboard needs no aggregation query. */
    failureCounts: { type: Schema.Types.Mixed, default: () => ({}) },

    plannedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 1000 },
    lastProgressAt: { type: Date, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  baseSchemaOptions,
);

storageMigrationJobSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
storageMigrationJobSchema.index({ createdBy: 1, createdAt: -1 });

export type StorageMigrationJobDocument = InferSchemaType<typeof storageMigrationJobSchema>;

export const StorageMigrationJobModel: Model<StorageMigrationJobDocument> =
  (models.StorageMigrationJob as Model<StorageMigrationJobDocument>) ??
  model<StorageMigrationJobDocument>('StorageMigrationJob', storageMigrationJobSchema);
