/**
 * Activity feed.
 *
 * Deliberately *not* the audit log. The audit log is an append-only compliance record
 * that normal users cannot read; this is the user-facing "what happened to this folder"
 * timeline, it is permission-filtered per viewer, and it may be pruned by retention.
 * Writing one does not replace writing the other.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

export const ACTIVITY_ENTITY_TYPES = ['folder', 'file', 'project', 'comment'] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

const activitySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true, maxlength: 200 },

    /** Verb from the audit vocabulary, e.g. `folder.create`, `file.version_upload`. */
    action: { type: String, required: true, maxlength: 60 },
    entityType: { type: String, enum: ACTIVITY_ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    entityLabel: { type: String, default: '', maxlength: 300 },

    /** Ancestors of the entity, so a folder timeline can include its subtree. */
    contextFolderIds: { type: [Schema.Types.ObjectId], ref: 'Folder', default: [] },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },

    detail: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false,
    strict: 'throw',
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

activitySchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
activitySchema.index({ contextFolderIds: 1, createdAt: -1 });
activitySchema.index({ organizationId: 1, createdAt: -1 });
activitySchema.index({ actorUserId: 1, createdAt: -1 });
/** Phase 9: the project dashboard's timeline. */
activitySchema.index({ projectId: 1, createdAt: -1 });

export type ActivityDocument = InferSchemaType<typeof activitySchema>;

export const ActivityModel: Model<ActivityDocument> =
  (models.Activity as Model<ActivityDocument>) ??
  model<ActivityDocument>('Activity', activitySchema);
