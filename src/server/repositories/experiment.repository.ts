/**
 * Experiment repository — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_EXPERIMENTS`. Move it together with `projects`: `list()` is given the
 * set of project ids the actor may see, computed by `project.service.ts` from the project
 * repository, so a split flag means one database deciding visibility for rows in another.
 */
import { isD1 } from './data-source';
import { mongoExperimentRepository } from './experiment.repository.mongo';
import { d1ExperimentRepository } from './experiment.repository.d1';
import type {
  CreateExperimentInput,
  ExperimentPatch,
  ExperimentRecord,
  ExperimentRepository,
  ListExperimentsInput,
} from './experiment.repository.contract';

export type {
  CreateExperimentInput,
  ExperimentPatch,
  ExperimentRecord,
  ExperimentRepository,
  ListExperimentsInput,
};

export { mongoExperimentRepository, d1ExperimentRepository };

function active(): ExperimentRepository {
  return isD1('experiments') ? d1ExperimentRepository : mongoExperimentRepository;
}

export function findById(id: string): Promise<ExperimentRecord | null> {
  return active().findById(id);
}

export function findByIds(ids: string[]): Promise<ExperimentRecord[]> {
  return active().findByIds(ids);
}

export function findByCode(
  organizationId: string,
  code: string,
): Promise<ExperimentRecord | null> {
  return active().findByCode(organizationId, code);
}

export function list(
  input: ListExperimentsInput,
): Promise<{ items: ExperimentRecord[]; total: number }> {
  return active().list(input);
}

export function listForProject(projectId: string, limit?: number): Promise<ExperimentRecord[]> {
  return active().listForProject(projectId, limit);
}

export function create(input: CreateExperimentInput): Promise<ExperimentRecord> {
  return active().create(input);
}

export function updateById(
  id: string,
  patch: ExperimentPatch,
): Promise<ExperimentRecord | null> {
  return active().updateById(id, patch);
}

export function adjustFileCount(id: string, delta: number): Promise<void> {
  return active().adjustFileCount(id, delta);
}

export function softDelete(id: string, deletedBy: string): Promise<boolean> {
  return active().softDelete(id, deletedBy);
}

export function countByStatusForProject(projectId: string): Promise<Record<string, number>> {
  return active().countByStatusForProject(projectId);
}
