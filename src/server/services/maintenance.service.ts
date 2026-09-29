/**
 * Scheduled maintenance, for the deployment that has no scheduler container.
 *
 * On Node, `docker/scheduler/crontab` runs each of these as its own `npm run` job. A Cloudflare
 * Worker has no cron container, and after the cutover the Node scheduler is stopped — so without
 * this, a Worker deployment would silently never purge trash past retention, never release
 * abandoned uploads (whose staged bytes sit in the Shared Drive), never re-check approvals
 * against Drive, and never write off expired stock.
 *
 * The Worker's cron trigger enqueues one `maintenance.run` message per job on `SYNC_QUEUE`
 * (`queues/schedule.ts`); the consumer calls `runMaintenanceJob`. Each job calls the same
 * service function its Node script calls, so the two deployments cannot drift.
 *
 * ── Properties every job keeps ──────────────────────────────────────────────────────────
 *
 *   • **Idempotent.** Delivery is at-least-once and cron can overlap a manual run. A second
 *     run of any job finds nothing left to do: trash already purged is gone, a batch already
 *     written off holds zero, a released upload session no longer exists.
 *   • **Bounded.** Each run does a bounded amount of work; the next run continues.
 *   • **Organization-scoped where the data is.** Inventory is swept for the deployment's
 *     organization, resolved here, never taken from a message.
 */
import { auditService } from '@/server/audit/audit.service';
import * as organizationRepository from '@/server/repositories/organization.repository';
import { sweepRemoteApprovals } from '@/server/services/approval-integrity.service';
import { folderService } from '@/server/services/folder.service';
import { stockService } from '@/server/services/stock.service';
import { uploadService } from '@/server/services/upload.service';
import { isDriveStorageEnabled } from '@/server/storage/google';

import type { MaintenanceJob } from './maintenance-jobs';

export { MAINTENANCE_JOBS, type MaintenanceJob } from './maintenance-jobs';

/** Approvals checked per run: one Drive call each, on a quota shared with uploads. */
const APPROVAL_PAGE = 100;
const APPROVAL_MAX_PAGES = 5;

export async function runMaintenanceJob(job: MaintenanceJob): Promise<Record<string, unknown>> {
  switch (job) {
    case 'uploads.cleanup': {
      const { sessions } = await uploadService.cleanupExpired();
      return { sessionsRemoved: sessions };
    }

    case 'trash.purge': {
      const { purged, purgedFiles, reclaimedBytes } = await folderService.purgeExpiredTrash();
      return { foldersPurged: purged, filesPurged: purgedFiles, reclaimedBytes };
    }

    case 'approvals.check': {
      if (!isDriveStorageEnabled()) return { skipped: 'Google Drive storage is not enabled' };
      const totals = { checked: 0, superseded: 0, missing: 0, unavailable: 0, pages: 0 };
      let cursor: string | null = null;
      do {
        const page = await sweepRemoteApprovals({ limit: APPROVAL_PAGE, cursor });
        totals.checked += page.checked;
        totals.superseded += page.superseded;
        totals.missing += page.missing;
        totals.unavailable += page.unavailable;
        totals.pages += 1;
        cursor = page.nextCursor;
      } while (cursor && totals.pages < APPROVAL_MAX_PAGES);
      return { ...totals, complete: cursor === null };
    }

    case 'inventory.expire': {
      const organization = await organizationRepository.getPrimary();
      if (!organization) return { skipped: 'no organization has been set up' };

      const written = await stockService.sweepExpired(organization.id);
      if (written.length > 0) {
        await auditService.recordSystem({
          actorLabel: 'inventory-expiry-sweep',
          organizationId: organization.id,
          action: 'inventory.stock_expired',
          entityType: 'inventory_item',
          entityId: organization.id,
          entityLabel: `Expiry sweep — ${written.length} item(s)`,
          newValue: { itemsWrittenOff: written.length, transactionIds: written.map((row) => row.id) },
          severity: 'warning',
        });
      }
      return { itemsWrittenOff: written.length };
    }
  }
}
