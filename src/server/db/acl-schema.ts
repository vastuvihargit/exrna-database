/**
 * Access-control entries embedded on folders and files.
 *
 * Embedded rather than a separate collection because every visibility query needs them
 * in the same document: `permissions.principalId` is what
 * `resourceVisibilityFilter()` matches against, and a $lookup per listed row would make
 * the drive listing unusable at scale.
 *
 * The array is intentionally small — broad access comes from role scope, not from
 * thousands of per-user rows.
 */
import { Schema } from 'mongoose';
import { ACCESS_LEVELS, PRINCIPAL_TYPES } from '@/server/domain/permissions';

export const aclEntrySchema = new Schema(
  {
    principalType: { type: String, enum: PRINCIPAL_TYPES, required: true },
    principalId: { type: Schema.Types.ObjectId, required: true },
    accessLevel: { type: String, enum: ACCESS_LEVELS, required: true },
    /** An explicit deny beats every allow, including an inherited one. */
    deny: { type: Boolean, default: false },
    expiresAt: { type: Date, default: null },
    grantedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    grantedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** Maximum entries on one resource; beyond this, share with a department or role instead. */
export const MAX_ACL_ENTRIES = 200;
