/**
 * What each cron trigger enqueues. Pure, so it can be tested without a Worker.
 *
 * The Worker's `scheduled` handler never does work inline: it turns the trigger into messages on
 * `SYNC_QUEUE`, where retries, the dead-letter queue and the logging already exist. Two triggers
 * (`wrangler.jsonc` → `triggers.crons`), kept few on purpose:
 *
 *   *\/15 * * * *   one Drive synchronization
 *   7 * * * *      hourly: expired uploads, the Drive approval check;
 *                  at 03:07 UTC also the trash purge and the inventory expiry sweep
 *
 * The times match the Node scheduler (`docker/scheduler/crontab`) closely enough that the two
 * deployments behave the same from a user's point of view.
 */
import type { MaintenanceJob } from '@/server/services/maintenance-jobs';
import type { DriveSyncMessage, MaintenanceMessage } from './messages';

export const DRIVE_SYNC_CRON = '*/15 * * * *';
export const MAINTENANCE_CRON = '7 * * * *';

/** The hour (UTC) at which the daily jobs ride along with the hourly trigger. */
export const DAILY_HOUR_UTC = 3;

export type SyncQueueMessage = DriveSyncMessage | MaintenanceMessage;

export function scheduledMessages(cron: string, at: Date): SyncQueueMessage[] {
  const requestedAt = at.toISOString();

  if (cron === DRIVE_SYNC_CRON) {
    return [{ kind: 'drive.sync', trigger: 'cron', requestedAt }];
  }

  if (cron === MAINTENANCE_CRON) {
    const jobs: MaintenanceJob[] = ['uploads.cleanup', 'approvals.check'];
    if (at.getUTCHours() === DAILY_HOUR_UTC) jobs.push('trash.purge', 'inventory.expire');
    return jobs.map((job) => ({ kind: 'maintenance.run', job, trigger: 'cron', requestedAt }));
  }

  return [];
}
