/**
 * Folder — the hierarchy every drive is built from.
 *
 * Hierarchy is stored as a parent reference *plus* a materialized ancestor array
 * (`pathAncestors`, ordered root → parent), never as a text path. That combination is
 * what makes three things cheap at once:
 *   • breadcrumbs           — one $in query over pathAncestors
 *   • subtree operations    — { pathAncestors: folderId } finds every descendant
 *   • circular-move checks  — the target's ancestors are already loaded
 *
 * A text path would additionally break the moment a folder is renamed.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import {
  applySoftDeleteFilter,
  baseSchemaOptions,
  softDeleteFields,
  RESOURCE_STATUSES,
  CONFIDENTIALITY_LEVELS,
} from '@/server/db/base-schema';
import { driveFolderFields } from '@/server/db/storage-fields';
import { aclEntrySchema } from '@/server/db/acl-schema';

/** Which drive a folder belongs to. Determines the default audience and the root. */
export const DRIVE_TYPES = ['my', 'department', 'project'] as const;
export type DriveType = (typeof DRIVE_TYPES)[number];

/** Hard ceiling on nesting: deep trees make subtree updates and breadcrumbs expensive. */
export const MAX_FOLDER_DEPTH = 32;

const folderSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    /**
     * Case-folded name, maintained by the service. Exists so "Protocols" and "protocols"
     * cannot both live in one parent — the duplicate-file complaint in the brief starts
     * with duplicate folders.
     */
    nameLower: { type: String, required: true, maxlength: 200 },

    parentFolderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
    /** Ordered root → parent. Empty for a drive root. */
    pathAncestors: { type: [Schema.Types.ObjectId], ref: 'Folder', default: [] },
    depth: { type: Number, default: 0, min: 0, max: MAX_FOLDER_DEPTH },

    driveType: { type: String, enum: DRIVE_TYPES, required: true },
    /**
     * Set only on drive roots, and unique — this is what makes "get or create the root
     * for this user/department/project" race-safe under concurrent requests.
     * Format: `my:{userId}` | `department:{departmentId}` | `project:{projectId}`.
     */
    rootKey: { type: String, default: null },

    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },

    /** Direct ACL entries. Inherited access is resolved by walking pathAncestors. */
    permissions: { type: [aclEntrySchema], default: [] },
    /** When false, ancestor ACLs stop applying at this folder. */
    inheritPermissions: { type: Boolean, default: true },

    confidentiality: { type: String, enum: CONFIDENTIALITY_LEVELS, default: 'internal' },
    status: { type: String, enum: RESOURCE_STATUSES, default: 'active' },

    description: { type: String, default: '', maxlength: 2000 },
    color: { type: String, default: null, maxlength: 20 },
    /** Marks folders generated from a project template (Phase 9). */
    templateKey: { type: String, default: null, maxlength: 60 },
    /** A system folder is a drive root or a template folder: renaming/deleting is refused. */
    isSystem: { type: Boolean, default: false },

    /** Denormalized counters, refreshed by the services that change them. */
    childFolderCount: { type: Number, default: 0, min: 0 },
    fileCount: { type: Number, default: 0, min: 0 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    archivedAt: { type: Date, default: null },
    /** Set when the folder was trashed as part of an ancestor's deletion, so that
     *  restoring the ancestor restores exactly the same set. */
    trashedWithFolderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },

    /**
     * The mirrored Drive folder, if one has been created yet.
     *
     * **MongoDB remains the hierarchy.** These fields record where Drive's copy of it is;
     * they are never consulted to render a tree, resolve a breadcrumb or check a
     * permission. Mirroring is lazy — a folder gets a Drive counterpart the first time
     * content needs to land in it — so `none` is the normal state for most rows and for
     * every empty folder.
     */
    ...driveFolderFields,

    ...softDeleteFields,
  },
  baseSchemaOptions,
);

/**
 * Trashed folders disappear from every ordinary query. Opting back in is explicit —
 * `withDeleted: true` in the query options, or a `deletedAt` condition in the filter —
 * which is what the trash listing, the restore path and the purge job use.
 */
applySoftDeleteFilter(folderSchema);

/** One root per user / department / project. Sparse: only roots carry a rootKey. */
folderSchema.index(
  { rootKey: 1 },
  { unique: true, partialFilterExpression: { rootKey: { $type: 'string' } } },
);

/**
 * No two live folders share a name inside one parent. Restricted to documents that have
 * a real parent so the several roots with `parentFolderId: null` do not collide.
 */
folderSchema.index(
  { parentFolderId: 1, nameLower: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null, parentFolderId: { $type: 'objectId' } },
  },
);

folderSchema.index({ organizationId: 1, parentFolderId: 1, deletedAt: 1, name: 1 });
folderSchema.index({ pathAncestors: 1 });
folderSchema.index({ organizationId: 1, driveType: 1, ownerId: 1, deletedAt: 1 });
folderSchema.index({ organizationId: 1, departmentId: 1, deletedAt: 1 });
folderSchema.index({ organizationId: 1, projectId: 1, deletedAt: 1 });
folderSchema.index({ 'permissions.principalId': 1 });
folderSchema.index({ organizationId: 1, status: 1, deletedAt: 1 });
// `deletedAt` alone is already indexed by softDeleteFields; declaring it again here
// would collide on the auto-generated index name.
folderSchema.index({ name: 'text', description: 'text' });

/**
 * One application folder maps to exactly one Drive folder, forever.
 *
 * This unique partial index is what makes "reuse the existing Drive folder, never create a
 * second one" an enforced invariant rather than a convention the mirroring code is trusted
 * to follow. Two concurrent uploads into the same new folder therefore produce one Drive
 * folder, not two — the loser of the race fails and re-reads.
 *
 * Note there is no index on folder *name* for this purpose, and deliberately so: folders
 * are matched to their Drive counterpart only through this stored mapping. Matching by
 * name would happily adopt a folder somebody created by hand for something else.
 */
folderSchema.index(
  { googleDriveFolderId: 1 },
  { unique: true, partialFilterExpression: { googleDriveFolderId: { $type: 'string' } } },
);

/** The mirroring worker's cursor, and the admin dashboard's "how many are mapped" count. */
folderSchema.index({ organizationId: 1, driveMappingStatus: 1 });

export type FolderDocument = InferSchemaType<typeof folderSchema>;

export const FolderModel: Model<FolderDocument> =
  (models.Folder as Model<FolderDocument>) ?? model<FolderDocument>('Folder', folderSchema);
