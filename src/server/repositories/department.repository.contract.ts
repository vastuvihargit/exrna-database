/**
 * The department repository contract, stated without reference to either database.
 *
 * Same reasoning as `user.repository.contract.ts`: `list()` took a raw
 * `FilterQuery<DepartmentDocument>` and `updateById()` took `{ $set: … }`.
 *
 * `DepartmentRecord` is unchanged from the Mongoose version, field for field.
 */

export interface DepartmentRecord {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  description: string;
  headUserId: string | null;
  parentDepartmentId: string | null;
  rootFolderId: string | null;
  storageQuotaBytes: number;
  storageUsedBytes: number;
  memberCount: number;
  isActive: boolean;
  createdAt: Date;
}

/**
 * Replaces `FilterQuery<DepartmentDocument>`.
 *
 * ── Soft-deleted departments are included, deliberately ─────────────────────────────────
 *
 * `department.model.ts` includes `softDeleteFields` but does **not** call
 * `applySoftDeleteFilter` — only `comment`, `experiment`, `file`, `folder` and `inventory-item`
 * do. So `DepartmentModel.find({ organizationId })` returns soft-deleted departments today,
 * and `softDelete()` sets `isActive: false` alongside `deletedAt`, which is what actually
 * keeps them out of the places that matter.
 *
 * The D1 implementation therefore must **not** add `deleted_at IS NULL`. Adding it would look
 * like a tidy-up and would be a silent behaviour change: a department that is visible today
 * would vanish from the list the moment the flag flipped. `includeDeleted` is spelled out here
 * so that the choice is a decision on the page rather than an omission.
 */
export interface ListDepartmentsCriteria {
  organizationId: string;
  /** Defaults to `true`, matching MongoDB. Pass `false` for a listing that hides them. */
  includeDeleted?: boolean;
}

/** `undefined` leaves a column alone; `null` writes null. */
export interface DepartmentPatch {
  name?: string;
  description?: string;
  headUserId?: string | null;
  parentDepartmentId?: string | null;
  rootFolderId?: string | null;
  storageQuotaBytes?: number;
  storageUsedBytes?: number;
  memberCount?: number;
  isActive?: boolean;
}

export interface CreateDepartmentInput {
  organizationId: string;
  name: string;
  code: string;
  description?: string;
  headUserId?: string | null;
  parentDepartmentId?: string | null;
  storageQuotaBytes: number;
  createdBy: string;
}

export interface DepartmentRepository {
  list(criteria: ListDepartmentsCriteria): Promise<DepartmentRecord[]>;
  findById(id: string): Promise<DepartmentRecord | null>;
  findByIds(ids: string[]): Promise<DepartmentRecord[]>;
  findByCode(organizationId: string, code: string): Promise<DepartmentRecord | null>;
  create(input: CreateDepartmentInput): Promise<DepartmentRecord>;
  updateById(id: string, patch: DepartmentPatch): Promise<DepartmentRecord | null>;
  softDelete(id: string, deletedBy: string): Promise<boolean>;
  refreshMemberCount(departmentId: string): Promise<number>;
}
