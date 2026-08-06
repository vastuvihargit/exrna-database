/**
 * The project repository contract, stated without reference to either database.
 *
 * `ProjectRecord` is unchanged from the Mongoose version, field for field.
 *
 * ── Membership and tags moved inside the write operations ───────────────────────────────
 *
 * `create` and `updateById` previously took a `ClientSession`, and `project.service.ts`
 * wrapped them in `withTransaction` together with a separate `syncMembership` call — because
 * a project row and its membership must land together or not at all.
 *
 * D1 has no interactive transaction, so a session cannot cross the repository boundary. The
 * atomicity is therefore expressed where each database can actually deliver it: `memberUserIds`
 * and `tags` are now **fields on the write**, and each implementation makes the whole write
 * atomic its own way — a Mongo session inside the repository, `db.batch()` inside the D1 one.
 *
 * That removes the last `ClientSession` from this module's service layer and, more usefully,
 * makes "the project and its members are written together" a property of the repository rather
 * than of a caller remembering to open a transaction.
 */
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { ProjectStatus } from '@/server/db/models';

export interface ProjectRecord {
  id: string;
  organizationId: string;
  departmentId: string;
  name: string;
  code: string;
  description: string;
  leadUserId: string | null;
  memberUserIds: string[];
  rootFolderId: string | null;
  status: ProjectStatus;
  confidentiality: ConfidentialityLevel;
  startDate: Date | null;
  targetEndDate: Date | null;
  completedAt: Date | null;
  tags: string[];
  storageUsedBytes: number;
  fileCount: number;
  createdAt: Date;
}

export interface CreateProjectInput {
  organizationId: string;
  departmentId: string;
  name: string;
  code: string;
  description?: string;
  leadUserId?: string | null;
  memberUserIds?: string[];
  confidentiality: ConfidentialityLevel;
  startDate?: Date | null;
  targetEndDate?: Date | null;
  tags?: string[];
  createdBy: string;
}

/**
 * `undefined` leaves a field alone; `null` writes null.
 *
 * `memberUserIds` and `tags` are **replace-the-whole-set** semantics, matching what the
 * service already did — it computed the complete member list and handed it over.
 */
export interface ProjectPatch {
  name?: string;
  description?: string;
  leadUserId?: string | null;
  rootFolderId?: string | null;
  status?: ProjectStatus;
  confidentiality?: ConfidentialityLevel;
  startDate?: Date | null;
  targetEndDate?: Date | null;
  completedAt?: Date | null;
  storageUsedBytes?: number;
  fileCount?: number;
  memberUserIds?: string[];
  tags?: string[];
}

/**
 * Everything needed to answer "which projects may this actor see?" in one query.
 *
 * Built by the service from the actor, but expressed as plain string ids so that no layer
 * above the repository has to know about ObjectIds — which is what let this survive the move
 * to D1 without the caller changing.
 */
export interface VisibleProjectsInput {
  organizationId: string;
  companyWide: boolean;
  userId: string;
  departmentId: string | null;
  departmentScopeIds: string[];
  projectScopeIds: string[];
}

export interface ProjectRepository {
  findById(id: string): Promise<ProjectRecord | null>;
  findByIds(ids: string[]): Promise<ProjectRecord[]>;
  findByCode(organizationId: string, code: string): Promise<ProjectRecord | null>;
  listVisible(input: VisibleProjectsInput): Promise<ProjectRecord[]>;
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  updateById(id: string, patch: ProjectPatch): Promise<ProjectRecord | null>;
  softDelete(id: string, deletedBy: string): Promise<boolean>;
}
