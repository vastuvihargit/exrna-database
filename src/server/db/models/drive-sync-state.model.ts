/**
 * The cursor into Google Drive's change feed. One document per Shared Drive.
 *
 * Created in Phase 3 with the rest of the schema so that Phase 9 is a service and a worker
 * rather than another database change — but nothing reads or writes it until then.
 *
 * The field that carries the risk is `startPageToken`. Drive expires change tokens, and a
 * `404` on one is not "no changes": it means the feed has moved past what we last saw and
 * an unknown set of renames, moves and deletions happened while nobody was looking.
 * Treating that as an empty result would silently desynchronise the whole application, so
 * `tokenExpiredAt` records it and forces a full reconcile instead.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

export const DRIVE_SYNC_STATES = ['idle', 'polling', 'reconciling', 'failed', 'disabled'] as const;
export type DriveSyncRunState = (typeof DRIVE_SYNC_STATES)[number];

const driveSyncStateSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    /** The Shared Drive this cursor belongs to. */
    sharedDriveId: { type: String, required: true, maxlength: 200 },

    state: { type: String, enum: DRIVE_SYNC_STATES, default: 'idle' },

    /** Drive's opaque cursor. Never parsed, never compared — only stored and replayed. */
    startPageToken: { type: String, default: null, maxlength: 500 },
    /**
     * Set when Drive rejects the stored token. Non-null means the next run must do a full
     * reconcile rather than an incremental poll, because the gap cannot be recovered.
     */
    tokenExpiredAt: { type: Date, default: null },

    lastPollAt: { type: Date, default: null },
    lastSuccessfulPollAt: { type: Date, default: null },
    lastFullReconcileAt: { type: Date, default: null },

    changesApplied: { type: Number, default: 0, min: 0 },
    conflictsDetected: { type: Number, default: 0, min: 0 },

    /**
     * Consecutive failures, reset on success. Backs off the poll interval and raises the
     * admin alert — a sync that has failed forty times in a row is an incident, whereas one
     * that failed once is a network blip.
     */
    consecutiveFailures: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: null, maxlength: 1000 },
  },
  baseSchemaOptions,
);

/** One cursor per drive. Two would each replay changes the other had already applied. */
driveSyncStateSchema.index({ organizationId: 1, sharedDriveId: 1 }, { unique: true });

export type DriveSyncStateDocument = InferSchemaType<typeof driveSyncStateSchema>;

export const DriveSyncStateModel: Model<DriveSyncStateDocument> =
  (models.DriveSyncState as Model<DriveSyncStateDocument>) ??
  model<DriveSyncStateDocument>('DriveSyncState', driveSyncStateSchema);
