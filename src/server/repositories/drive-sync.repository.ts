/**
 * The Drive change-feed cursor — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_DRIVE_SYNC`. This was the last repository on the request-reachable or
 * Worker-reachable list without a D1 implementation; the only two remaining without one are
 * `migration` and `storage-migration`, which read the local filesystem by definition and are
 * supposed to keep running on Node.
 *
 * The flag depends on `organizations` alone — `drive_sync_states.organization_id` is the only
 * foreign key on the table — but it should move with `files`, `folders` and `fileVersions` in
 * practice, because applying a Drive change writes all three. That is a runbook ordering point
 * rather than a constraint the database can enforce, so it is stated here and in the cutover
 * document rather than in `DATA_SOURCE_DEPENDENCIES`, which records only real foreign keys.
 */
import { isD1 } from './data-source';
import { mongoDriveSyncRepository } from './drive-sync.repository.mongo';
import { d1DriveSyncRepository } from './drive-sync.repository.d1';
import type {
  AdvanceCursorInput,
  DriveSyncRepository,
  DriveSyncStateRecord,
  DriveSyncStateUpdate,
} from './drive-sync.repository.contract';

export type {
  AdvanceCursorInput,
  DriveSyncRepository,
  DriveSyncStateRecord,
  DriveSyncStateUpdate,
};
export { mongoDriveSyncRepository, d1DriveSyncRepository };

function active(): DriveSyncRepository {
  return isD1('driveSync') ? d1DriveSyncRepository : mongoDriveSyncRepository;
}

export function ensureState(input: {
  organizationId: string;
  sharedDriveId: string;
}): Promise<DriveSyncStateRecord> {
  return active().ensureState(input);
}

export function findState(input: {
  organizationId: string;
  sharedDriveId: string;
}): Promise<DriveSyncStateRecord | null> {
  return active().findState(input);
}

export function listStates(): Promise<DriveSyncStateRecord[]> {
  return active().listStates();
}

export function updateState(id: string, update: DriveSyncStateUpdate): Promise<void> {
  return active().updateState(id, update);
}

export function advanceCursor(input: AdvanceCursorInput): Promise<boolean> {
  return active().advanceCursor(input);
}
