/**
 * Append-only audit log.
 *
 * Immutability is enforced in three layers:
 *   1. the repository exposes only append() and query()
 *   2. pre-hooks below reject every update and delete on the model
 *   3. in production the database user holds insert+find on this collection only
 *
 * There is deliberately no TTL index: retention is applied by an explicit, audited
 * archival job, never silently by the database.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

export const AUDIT_ACTIONS = [
  // authentication
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.logout_all',
  'auth.password_reset_requested',
  'auth.password_reset_completed',
  'auth.password_changed',
  'auth.session_revoked',
  'auth.access_denied',
  // employees & access control
  'user.created',
  'user.updated',
  'user.activated',
  'user.deactivated',
  'user.role_granted',
  'user.role_revoked',
  'user.quota_changed',
  'department.created',
  'department.updated',
  'department.deleted',
  'role.created',
  'role.updated',
  'role.deleted',
  // drive (emitted from Phase 3 onward)
  'folder.create',
  'folder.rename',
  'folder.move',
  'folder.copy',
  'file.upload',
  'file.download',
  'file.preview',
  'file.rename',
  'file.move',
  'file.copy',
  'file.version_upload',
  'file.version_restore',
  'file.metadata_updated',
  'file.share',
  'file.permission_change',
  'file.comment',
  'file.review_requested',
  'file.approve',
  'file.reject',
  /**
   * An approval stopped holding because the content it was granted against changed.
   *
   * Deliberately a `file.*` action rather than a `drive_storage.*` one even though only
   * Drive-backed content can reach it. An auditor asking "what happened to this approval?"
   * reads the file's history, and an entry filed under storage plumbing would not be there.
   */
  'file.approval_invalidated',
  'resource.archive',
  'resource.restore',
  'resource.delete',
  'resource.purge',
  'upload.rejected',
  'export.created',
  // Inbound Drive importer. `migration.*` is *reading* somebody's Drive into this platform.
  'migration.import_item',
  'migration.job_updated',
  /**
   * Google Shared Drive storage backend — the opposite direction, and deliberately a
   * different prefix. An operator reading the audit log must be able to tell "we imported
   * from a Drive" from "we moved company files into the Shared Drive" at a glance; sharing
   * the `migration.*` prefix would make the two indistinguishable in exactly the situation
   * where it matters most.
   */
  'storage_migration.job_created',
  'storage_migration.job_planned',
  'storage_migration.queued',
  'storage_migration.started',
  'storage_migration.item_verified',
  'storage_migration.completed',
  'storage_migration.failed',
  'storage_migration.retried',
  'storage_migration.paused',
  'storage_migration.rolled_back',
  'storage_migration.provider_changed',
  // Local-copy lifecycle. Deletion is separate from archival because it is irreversible.
  'storage_migration.local_copy_archived',
  'storage_migration.local_copy_deleted',
  // Connection and synchronization.
  'drive_storage.connection_established',
  'drive_storage.connection_failed',
  'drive_storage.sync_started',
  'drive_storage.sync_completed',
  'drive_storage.sync_conflict',
  'drive_storage.file_missing',
  'drive_storage.recovery_resolved',
  /**
   * Inventory.
   *
   * Recorded here *as well as* in `stockTransactions`, which is not duplication: the ledger
   * answers "what happened to this material", the audit log answers "what did this person
   * do". An auditor reviewing an employee's activity reads one; a store manager reconciling
   * a shelf reads the other.
   */
  'inventory.item_created',
  'inventory.item_updated',
  'inventory.item_deactivated',
  'inventory.stock_added',
  'inventory.stock_issued',
  'inventory.stock_returned',
  'inventory.stock_adjusted',
  'inventory.stock_expired',
  'backup.run',
  'settings.updated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_OUTCOMES = ['success', 'denied', 'error'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

const auditLogSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },

    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorEmail: { type: String, default: null, maxlength: 320 },
    actorRoleKeys: { type: [String], default: [] },

    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    entityType: { type: String, required: true, maxlength: 60 },
    entityId: { type: String, default: null, maxlength: 100 },
    entityLabel: { type: String, default: null, maxlength: 300 },

    previousValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
    /** Required for sensitive actions (purge, permission change, deactivation). */
    reason: { type: String, default: null, maxlength: 500 },

    ip: { type: String, default: 'unknown', maxlength: 64 },
    userAgent: { type: String, default: 'unknown', maxlength: 512 },
    requestId: { type: String, default: null, maxlength: 64 },

    outcome: { type: String, enum: AUDIT_OUTCOMES, default: 'success' },
    severity: { type: String, enum: ['info', 'notice', 'warning', 'critical'], default: 'info' },
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

auditLogSchema.index({ organizationId: 1, createdAt: -1 });
auditLogSchema.index({ actorUserId: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ requestId: 1 });
auditLogSchema.index({ outcome: 1, createdAt: -1 });

const IMMUTABLE = 'Audit logs are append-only and cannot be modified or deleted';

for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'] as const) {
  auditLogSchema.pre(hook, function blockUpdate(next) {
    next(new Error(IMMUTABLE));
  });
}
for (const hook of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  auditLogSchema.pre(hook, function blockDelete(next) {
    next(new Error(IMMUTABLE));
  });
}
auditLogSchema.pre('save', function blockResave(next) {
  if (!this.isNew) {
    next(new Error(IMMUTABLE));
    return;
  }
  next();
});

export type AuditLogDocument = InferSchemaType<typeof auditLogSchema>;

export const AuditLogModel: Model<AuditLogDocument> =
  (models.AuditLog as Model<AuditLogDocument>) ??
  model<AuditLogDocument>('AuditLog', auditLogSchema);
