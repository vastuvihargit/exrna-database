/**
 * A logical file — the thing a user names, moves, shares and reviews.
 *
 * The bytes live in `FileVersion`; this document never holds a storage key, so a
 * physical path cannot leak through a file listing however carelessly it is serialized.
 *
 * `folderPathAncestors` is denormalized from the containing folder. That is what makes
 * "everything under this folder" a single indexed query instead of a recursive walk,
 * and it is rewritten by the same subtree update that moves the folder.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import {
  applySoftDeleteFilter,
  baseSchemaOptions,
  softDeleteFields,
  RESOURCE_STATUSES,
  CONFIDENTIALITY_LEVELS,
} from '@/server/db/base-schema';
import { FILE_STORAGE_PROVIDERS } from '@/server/db/storage-fields';
import { aclEntrySchema } from '@/server/db/acl-schema';
import { FILE_CATEGORIES } from '@/server/domain/file-types';

export const REVIEW_STATUSES = [
  'draft',
  'submitted',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const APPROVAL_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

const fileSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },

    displayName: { type: String, required: true, trim: true, maxlength: 300 },
    displayNameLower: { type: String, required: true, maxlength: 300 },
    /** Exactly what the user's machine called it, kept for download and provenance. */
    originalFilename: { type: String, required: true, maxlength: 300 },
    extension: { type: String, required: true, lowercase: true, maxlength: 20 },
    category: { type: String, enum: FILE_CATEGORIES, default: 'other' },

    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', required: true },
    folderPathAncestors: { type: [Schema.Types.ObjectId], ref: 'Folder', default: [] },
    driveType: { type: String, enum: ['my', 'department', 'project'], required: true },

    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    experimentId: { type: Schema.Types.ObjectId, ref: 'Experiment', default: null },

    currentVersionId: { type: Schema.Types.ObjectId, ref: 'FileVersion', default: null },
    /** The version reviewers signed off. Never silently replaced by a new upload. */
    approvedVersionId: { type: Schema.Types.ObjectId, ref: 'FileVersion', default: null },
    versionCount: { type: Number, default: 0, min: 0 },

    /** Mirrors the current version, so a listing needs one query. */
    sizeBytes: { type: Number, default: 0, min: 0 },
    mimeType: { type: String, default: 'application/octet-stream', maxlength: 200 },
    checksumSha256: { type: String, default: null, maxlength: 64 },

    tags: { type: [String], default: [] },
    /** Research metadata, filled in from Phase 6. Free-form by design. */
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },

    confidentiality: { type: String, enum: CONFIDENTIALITY_LEVELS, default: 'internal' },
    reviewStatus: { type: String, enum: REVIEW_STATUSES, default: 'draft' },
    approvalStatus: { type: String, enum: APPROVAL_STATUSES, default: 'none' },
    status: { type: String, enum: RESOURCE_STATUSES, default: 'active' },

    permissions: { type: [aclEntrySchema], default: [] },
    inheritPermissions: { type: Boolean, default: true },

    downloadCount: { type: Number, default: 0, min: 0 },
    lastAccessedAt: { type: Date, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    archivedAt: { type: Date, default: null },
    trashedWithFolderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },

    /**
     * A read-only mirror of where this file's versions are stored, for listings and the
     * admin dashboard.
     *
     * **No Drive id is ever stored here.** The rule at the top of this file — that a
     * `File` never holds a storage location, so a physical address cannot leak through a
     * file listing however carelessly it is serialized — is preserved exactly. What this
     * carries is a category, not an address.
     *
     * `mixed` is a real and expected state during migration: v1 still local, v2 in Drive.
     * Maintained by the same writes that set `currentVersionId`.
     */
    storageProvider: { type: String, enum: FILE_STORAGE_PROVIDERS, default: 'local' },
    /** Drives the "open in Google editor" affordance and distinguishes native documents. */
    hasGoogleNativeContent: { type: Boolean, default: false },

    ...softDeleteFields,
  },
  baseSchemaOptions,
);

applySoftDeleteFilter(fileSchema);

fileSchema.index({ folderId: 1, deletedAt: 1, displayName: 1 });
fileSchema.index({ folderPathAncestors: 1, deletedAt: 1 });
fileSchema.index({ organizationId: 1, ownerId: 1, deletedAt: 1 });
fileSchema.index({ organizationId: 1, departmentId: 1, deletedAt: 1 });
fileSchema.index({ organizationId: 1, projectId: 1, deletedAt: 1 });
fileSchema.index({ 'permissions.principalId': 1 });
fileSchema.index({ organizationId: 1, reviewStatus: 1, updatedAt: -1 });
fileSchema.index({ organizationId: 1, approvalStatus: 1, updatedAt: -1 });
fileSchema.index({ checksumSha256: 1 });
fileSchema.index({ organizationId: 1, tags: 1 });

/**
 * One text index per collection is a MongoDB limit, so everything searchable has to be
 * in this one. Weights put a filename match above a tag match above a description.
 */
fileSchema.index(
  {
    displayName: 'text',
    originalFilename: 'text',
    tags: 'text',
    'metadata.sampleId': 'text',
    'metadata.experimentCode': 'text',
    'metadata.description': 'text',
  },
  {
    name: 'file_search',
    weights: {
      displayName: 10,
      originalFilename: 6,
      tags: 5,
      'metadata.sampleId': 5,
      'metadata.experimentCode': 5,
      'metadata.description': 1,
    },
  },
);

export type FileDocument = InferSchemaType<typeof fileSchema>;

export const FileModel: Model<FileDocument> =
  (models.File as Model<FileDocument>) ?? model<FileDocument>('File', fileSchema);
