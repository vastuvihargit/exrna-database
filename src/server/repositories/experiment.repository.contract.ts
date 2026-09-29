/**
 * The experiment repository contract, stated without reference to either database.
 *
 * `ExperimentRecord` is unchanged from the Mongoose version, field for field.
 *
 * ── Soft delete works differently here than in the project repository ───────────────────
 *
 * `experiment.model.ts` **does** call `applySoftDeleteFilter`; `project.model.ts` does not.
 * So every experiment read excludes soft-deleted rows, and every project read includes them —
 * in the same module, in MongoDB, today. Both implementations reproduce the asymmetry rather
 * than smoothing it, because smoothing it in either direction changes what a user sees.
 *
 * ── Three embedded arrays ───────────────────────────────────────────────────────────────
 *
 * `collaboratorUserIds`, `sampleIds` and `tags` were arrays on the document and are child
 * tables in D1 (`experiment_collaborators`, `experiment_samples`, `resource_tags`). They are
 * fields on `create` and `updateById` with replace-the-whole-set semantics, so the row and its
 * children are written atomically by the repository rather than by a caller holding a session.
 */
import type { ConfidentialityLevel } from '@/server/domain/permissions';
import type { ExperimentOutcome, ExperimentStatus } from '@/server/db/models';

export interface ExperimentRecord {
  id: string;
  organizationId: string;
  projectId: string;
  departmentId: string | null;
  code: string;
  title: string;
  objective: string;
  status: ExperimentStatus;
  outcome: ExperimentOutcome;
  outcomeSummary: string;
  leadUserId: string | null;
  collaboratorUserIds: string[];
  protocolRef: string;
  instrumentRef: string;
  organism: string;
  sampleIds: string[];
  startedOn: Date | null;
  completedOn: Date | null;
  folderId: string | null;
  confidentiality: ConfidentialityLevel;
  tags: string[];
  fileCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListExperimentsInput {
  organizationId: string;
  /** Restricted to these projects — the caller has already decided which it may see. */
  projectIds: string[];
  status?: ExperimentStatus;
  text?: string;
  sampleId?: string;
  page: number;
  pageSize: number;
}

export interface CreateExperimentInput {
  organizationId: string;
  projectId: string;
  departmentId: string | null;
  code: string;
  title: string;
  objective?: string;
  status?: ExperimentStatus;
  outcome?: ExperimentOutcome;
  leadUserId?: string | null;
  collaboratorUserIds?: string[];
  protocolRef?: string;
  instrumentRef?: string;
  organism?: string;
  sampleIds?: string[];
  startedOn?: Date | null;
  completedOn?: Date | null;
  folderId?: string | null;
  confidentiality: ConfidentialityLevel;
  tags?: string[];
  createdBy: string;
}

/** `undefined` leaves a field alone; `null` writes null. Array fields replace the whole set. */
export interface ExperimentPatch {
  title?: string;
  objective?: string;
  status?: ExperimentStatus;
  outcome?: ExperimentOutcome;
  outcomeSummary?: string;
  leadUserId?: string | null;
  protocolRef?: string;
  instrumentRef?: string;
  organism?: string;
  startedOn?: Date | null;
  completedOn?: Date | null;
  folderId?: string | null;
  confidentiality?: ConfidentialityLevel;
  departmentId?: string | null;
  updatedBy?: string | null;
  collaboratorUserIds?: string[];
  sampleIds?: string[];
  tags?: string[];
}

export interface ExperimentRepository {
  findById(id: string): Promise<ExperimentRecord | null>;
  findByIds(ids: string[]): Promise<ExperimentRecord[]>;
  findByCode(organizationId: string, code: string): Promise<ExperimentRecord | null>;
  list(input: ListExperimentsInput): Promise<{ items: ExperimentRecord[]; total: number }>;
  listForProject(projectId: string, limit?: number): Promise<ExperimentRecord[]>;
  create(input: CreateExperimentInput): Promise<ExperimentRecord>;
  updateById(id: string, patch: ExperimentPatch): Promise<ExperimentRecord | null>;
  adjustFileCount(id: string, delta: number): Promise<void>;
  softDelete(id: string, deletedBy: string): Promise<boolean>;
  countByStatusForProject(projectId: string): Promise<Record<string, number>>;
}
