/**
 * Operational state: the Drive change-feed cursor and the alert de-duplication table.
 *
 * Small, and easy to dismiss as not worth migrating. Both are worth it for the same reason:
 * losing them does not break anything visibly, it just makes the first hours after cutover
 * behave differently from every hour after that.
 *
 * A lost `start_page_token` means the change feed restarts from "now" and the reconciler has no
 * cursor, so edits made in Google Drive during the cutover window are never seen. A lost alert
 * table means every already-firing alert re-notifies once, which is how a cutover produces a
 * pager storm that has nothing to do with the cutover.
 */
import { AlertStateModel, DriveSyncStateModel } from '@/server/db/models';
import { DRIVE_SYNC_STATES } from '@/server/db/models/drive-sync-state.model';
import {
  enumValue,
  iso,
  nullableStr,
  num,
  requiredIso,
  requiredOid,
  str,
} from '../convert';
import { upsert } from '../sql';
import { modelStep } from '../step-helpers';
import type { MigrationStep } from '../types';
import { timestamps } from './identity';

export const driveSyncStatesStep: MigrationStep = modelStep({
  name: 'drive-sync-states',
  description: 'The Drive change-feed cursor',
  targets: ['drive_sync_states'],
  requires: ['organizations'],
  model: DriveSyncStateModel as never,
  deltaField: 'updatedAt',
  transform(document, context) {
    const id = requiredOid(document._id, 'drive_sync_states._id');
    const organizationId = requiredOid(
      document.organizationId,
      'drive_sync_states.organizationId',
    );
    if (!context.known.get('organizations')?.has(organizationId)) {
      return { kind: 'skip', reason: `organization ${organizationId} was not migrated` };
    }

    return {
      kind: 'write',
      statements: [
        upsert('drive_sync_states', {
          id,
          organization_id: organizationId,
          shared_drive_id: str(document.sharedDriveId),
          state: enumValue(document.state, DRIVE_SYNC_STATES, 'idle'),
          // The cursor itself. Copied verbatim: a token is opaque to us and re-deriving one
          // would silently skip every change made before the new token was issued.
          start_page_token: nullableStr(document.startPageToken),
          token_expired_at: iso(document.tokenExpiredAt),
          last_poll_at: iso(document.lastPollAt),
          last_successful_poll_at: iso(document.lastSuccessfulPollAt),
          last_full_reconcile_at: iso(document.lastFullReconcileAt),
          changes_applied: num(document.changesApplied),
          conflicts_detected: num(document.conflictsDetected),
          consecutive_failures: num(document.consecutiveFailures),
          last_error: nullableStr(document.lastError),
          ...timestamps(document),
        }),
      ],
    };
  },
});

export const alertStatesStep: MigrationStep = modelStep({
  name: 'alert-states',
  description: 'Alert de-duplication state',
  targets: ['alert_states'],
  requires: [],
  model: AlertStateModel as never,
  deltaField: 'updatedAt',
  transform(document) {
    const id = requiredOid(document._id, 'alert_states._id');
    const createdAt = requiredIso(document.createdAt, new Date(0).toISOString());

    return {
      kind: 'write',
      statements: [
        upsert('alert_states', {
          id,
          key: str(document.key),
          severity: enumValue(document.severity, ['warning', 'critical'] as const, 'warning'),
          last_sent_at: requiredIso(document.lastSentAt, createdAt),
          occurrences: num(document.occurrences, 1),
          last_detail: str(document.lastDetail),
          resolved_at: iso(document.resolvedAt),
          ...timestamps(document),
        }),
      ],
    };
  },
});
