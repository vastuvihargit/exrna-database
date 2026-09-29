/**
 * The activity timeline — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_ACTIVITIES`.
 *
 * Not independently movable in practice, even though nothing structural forbids it: a timeline
 * split across two databases shows the half written since the flip and silently omits the rest,
 * which reads as "nothing happened here" rather than as an error. The migration copies the
 * table; the flag moves with it.
 */
import { isD1 } from './data-source';
import { mongoActivityRepository } from './activity.repository.mongo';
import { d1ActivityRepository } from './activity.repository.d1';
import type {
  ActivityEntityType,
  ActivityRecord,
  ActivityRepository,
  ActivityTx,
  AppendActivityInput,
} from './activity.repository.contract';

export type {
  ActivityEntityType,
  ActivityRecord,
  ActivityRepository,
  ActivityTx,
  AppendActivityInput,
};

export { mongoActivityRepository, d1ActivityRepository };

function active(): ActivityRepository {
  return isD1('activities') ? d1ActivityRepository : mongoActivityRepository;
}

export function append(input: AppendActivityInput, tx?: ActivityTx): Promise<void> {
  return active().append(input, tx);
}

export function listForEntity(
  entityType: ActivityEntityType,
  entityId: string,
  limit = 50,
): Promise<ActivityRecord[]> {
  return active().listForEntity(entityType, entityId, limit);
}

export function listForFolderTree(folderId: string, limit = 50): Promise<ActivityRecord[]> {
  return active().listForFolderTree(folderId, limit);
}

export function listForProject(projectId: string, limit = 30): Promise<ActivityRecord[]> {
  return active().listForProject(projectId, limit);
}

export function deleteOlderThan(cutoff: Date): Promise<number> {
  return active().deleteOlderThan(cutoff);
}
