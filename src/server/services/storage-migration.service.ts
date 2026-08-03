/**
 * The authorized entry points for the outbound storage migration.
 *
 * ⚠ Not `migration.service.ts` — that is the *inbound* Drive importer, running in the
 * opposite direction with a read-only scope. See §3 of the Phase 0 analysis.
 *
 * Everything here is gated on company-scoped `access.manage`, deliberately a higher bar
 * than the `audit.view` that guards the read-only status endpoints. This moves the
 * company's research data between storage systems; a department head administers their own
 * people, not the storage backend.
 *
 * Runs are started synchronously from an HTTP request and bounded by `maxItems`, so a
 * request cannot outlive the platform's 300-second ceiling. Resuming is just calling run
 * again — the claim/queue design means a job has no notion of "the run that owns it", which
 * is also what makes it survive the process dying mid-batch.
 */
import { ForbiddenError, NotFoundError, ValidationError } from '@/server/errors/app-error';
import { auditService } from '@/server/audit/audit.service';
import type { Actor } from '@/server/permissions/actor';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import type { RequestMeta } from '@/server/http/request-meta';
import * as migrationRepository from '@/server/repositories/storage-migration.repository';
import { storageRegistry } from '@/server/storage';
import { getGoogleDriveStorage, isDriveStorageEnabled } from '@/server/storage/google';
import { planJob, type PlanReport, type Selection } from './storage-migration/planner';
import { requireDriveStore } from './storage-migration/transfer';
import { rollbackJob, runJob, verifyJob, type RunSummary } from './storage-migration/runner';
import { countPending, drainPendingTransfers } from './storage-migration/pending-transfers';
import type { TransferDeps } from './storage-migration/transfer';

const MODES = ['dry_run', 'migrate', 'verify_only', 'rollback'] as const;
export type MigrationMode = (typeof MODES)[number];

function assertAdmin(actor: Actor): void {
  try {
    assertCompanyPermission(actor, 'access.manage');
  } catch {
    throw new ForbiddenError('You cannot manage storage migration');
  }
}

/**
 * Everything a run needs from Drive, resolved once.
 *
 * Refuses clearly when the backend is switched off rather than failing on the first
 * transfer with a registry error nobody can act on.
 */
function driveDeps(): TransferDeps {
  if (!isDriveStorageEnabled()) {
    throw new ValidationError(
      'Google Drive storage is not enabled on this deployment. Set GOOGLE_DRIVE_STORAGE_ENABLED=true and connect the Shared Drive first.',
    );
  }

  // Both halves come from the registry rather than straight from the module singleton, so
  // the same injection seam the tests use is the one production goes through.
  const store = requireDriveStore();
  const hierarchy = storageRegistry.hierarchy('google_drive');
  const { client } = getGoogleDriveStorage();
  return { store, client, hierarchy };
}

/**
 * Mongoose hands back ObjectIds where the planner wants ids as strings.
 *
 * Converted here, once, rather than making the planner tolerate both — a selection filter
 * that silently accepted the wrong id type would match nothing and report an empty
 * migration as a successful one.
 */
function toSelection(stored: unknown): Selection {
  const raw = (stored ?? {}) as Record<string, unknown>;
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((entry) => String(entry)) : [];

  return {
    folderIds: ids(raw.folderIds),
    includeDescendants: raw.includeDescendants !== false,
    departmentIds: ids(raw.departmentIds),
    projectIds: ids(raw.projectIds),
    versionIds: ids(raw.versionIds),
    extensions: Array.isArray(raw.extensions) ? raw.extensions.map(String) : [],
    uploadedAfter: raw.uploadedAfter ? new Date(raw.uploadedAfter as string) : null,
    uploadedBefore: raw.uploadedBefore ? new Date(raw.uploadedBefore as string) : null,
    currentVersionsOnly: raw.currentVersionsOnly === true,
  };
}

export async function createJob(
  actor: Actor,
  input: { name: string; description?: string; mode: MigrationMode; selection: Selection },
  meta: RequestMeta,
): Promise<{ id: string }> {
  assertAdmin(actor);

  if (!MODES.includes(input.mode)) throw new ValidationError('Unknown migration mode');
  if (!input.name.trim()) throw new ValidationError('Give the job a name so it can be recognised later');

  const job = await migrationRepository.createJob({
    organizationId: actor.organizationId,
    name: input.name.trim(),
    ...(input.description ? { description: input.description } : {}),
    mode: input.mode,
    selection: input.selection as Record<string, unknown>,
    createdBy: actor.userId,
  });

  await auditService.recordForActor(actor, meta, {
    action: 'storage_migration.job_created',
    entityType: 'storage_migration_job',
    entityId: job.id,
    entityLabel: job.name,
    newValue: { mode: input.mode, selection: input.selection },
    severity: 'notice',
  });

  return { id: job.id };
}

export async function listJobs(actor: Actor): Promise<migrationRepository.JobRecord[]> {
  assertAdmin(actor);
  return migrationRepository.listJobs(actor.organizationId);
}

async function requireJob(actor: Actor, jobId: string): Promise<migrationRepository.JobRecord> {
  const job = await migrationRepository.findJob(jobId);
  // Scoped to the actor's organization: a valid id from elsewhere must read as absent, not
  // as forbidden, so the endpoint cannot confirm that another tenant's job exists.
  if (!job || job.organizationId !== actor.organizationId) throw new NotFoundError();
  return job;
}

/**
 * Works out what a job would do, and records it.
 *
 * A dry run walks exactly the same selection code as a real one and writes nothing — the
 * report therefore describes the migration that is actually about to happen, rather than an
 * approximation of it.
 */
export async function planJobForActor(
  actor: Actor,
  jobId: string,
  meta: RequestMeta,
): Promise<PlanReport> {
  assertAdmin(actor);
  const job = await requireJob(actor, jobId);

  await migrationRepository.updateJob(jobId, { $set: { status: 'planning' } });

  const report = await planJob({
    jobId,
    organizationId: actor.organizationId,
    selection: toSelection(job.selection),
    dryRun: job.mode === 'dry_run',
  });

  await migrationRepository.updateJob(jobId, {
    $set: {
      status: 'planned',
      plannedAt: new Date(),
      'counters.selected': report.selected,
      'counters.selectedBytes': report.selectedBytes,
      'counters.skipped': report.skippedNative + report.alreadyMigrated,
    },
  });

  await auditService.recordForActor(actor, meta, {
    action: 'storage_migration.job_planned',
    entityType: 'storage_migration_job',
    entityId: jobId,
    entityLabel: job.name,
    newValue: {
      selected: report.selected,
      bytes: report.selectedBytes,
      tooDeep: report.tooDeep.length,
      projectedItems: report.itemProjection.projectedItems,
    },
    severity: report.tooDeep.length > 0 || !report.itemProjection.withinLimit ? 'warning' : 'notice',
  });

  return report;
}

export async function runJobForActor(
  actor: Actor,
  jobId: string,
  meta: RequestMeta,
  options: { maxItems?: number; retryFailed?: boolean } = {},
): Promise<RunSummary> {
  assertAdmin(actor);
  const job = await requireJob(actor, jobId);

  if (job.mode === 'dry_run') {
    throw new ValidationError('This job is a dry run. Create a migrate job to move anything.');
  }
  if (job.status === 'draft') {
    throw new ValidationError('Plan the job before running it, so you can see what it would move.');
  }

  await auditService.recordForActor(actor, meta, {
    action: 'storage_migration.started',
    entityType: 'storage_migration_job',
    entityId: jobId,
    entityLabel: job.name,
    severity: 'notice',
  });

  const summary = await runJob({
    jobId,
    workerId: `http:${meta.requestId}`,
    deps: driveDeps(),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
    ...(options.retryFailed ? { retryFailed: true } : {}),
  });

  await auditService.recordForActor(actor, meta, {
    action: summary.failed > 0 ? 'storage_migration.failed' : 'storage_migration.completed',
    entityType: 'storage_migration_job',
    entityId: jobId,
    entityLabel: job.name,
    newValue: summary,
    outcome: summary.failed > 0 ? 'error' : 'success',
    severity: summary.failed > 0 ? 'warning' : 'info',
  });

  return summary;
}

export async function pauseJob(actor: Actor, jobId: string, meta: RequestMeta): Promise<void> {
  assertAdmin(actor);
  const job = await requireJob(actor, jobId);

  // Requested, not applied: the running worker stops at the next item boundary rather than
  // tearing a transfer in half and leaving a partial object behind.
  await migrationRepository.updateJob(jobId, { $set: { pauseRequested: true } });

  await auditService.recordForActor(actor, meta, {
    action: 'storage_migration.paused',
    entityType: 'storage_migration_job',
    entityId: jobId,
    entityLabel: job.name,
  });
}

export async function retryFailed(
  actor: Actor,
  jobId: string,
  meta: RequestMeta,
): Promise<{ requeued: number }> {
  assertAdmin(actor);
  const job = await requireJob(actor, jobId);

  const requeued = await migrationRepository.requeueFailed(jobId);

  await auditService.recordForActor(actor, meta, {
    action: 'storage_migration.retried',
    entityType: 'storage_migration_job',
    entityId: jobId,
    entityLabel: job.name,
    newValue: { requeued },
    severity: 'notice',
  });

  return { requeued };
}

export async function verifyJobForActor(
  actor: Actor,
  jobId: string,
  meta: RequestMeta,
  options: { limit?: number } = {},
): Promise<{ checked: number; ok: number; failed: number }> {
  assertAdmin(actor);
  const job = await requireJob(actor, jobId);

  const result = await verifyJob({
    jobId,
    deps: driveDeps(),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });

  await auditService.recordForActor(actor, meta, {
    action: 'storage_migration.item_verified',
    entityType: 'storage_migration_job',
    entityId: jobId,
    entityLabel: job.name,
    newValue: result,
    outcome: result.failed > 0 ? 'error' : 'success',
    severity: result.failed > 0 ? 'warning' : 'info',
  });

  return result;
}

export async function rollbackJobForActor(
  actor: Actor,
  jobId: string,
  meta: RequestMeta,
): Promise<{ rolledBack: number; skipped: number }> {
  assertAdmin(actor);
  const job = await requireJob(actor, jobId);

  const result = await rollbackJob(jobId);

  await auditService.recordForActor(actor, meta, {
    action: 'storage_migration.rolled_back',
    entityType: 'storage_migration_job',
    entityId: jobId,
    entityLabel: job.name,
    newValue: result,
    // Skipped items are versions whose local copy is gone, so they could not be reverted.
    // That is exactly the situation an administrator must not miss.
    severity: result.skipped > 0 ? 'critical' : 'notice',
    ...(result.skipped > 0
      ? { reason: `${result.skipped} version(s) had no local copy to revert to` }
      : {}),
  });

  return result;
}

/**
 * Moves queued uploads on to Drive.
 *
 * Separate from the job machinery on purpose: these are files an employee uploaded a minute
 * ago, not a planned migration, and they carry no job, no plan and no selection. Running it
 * is safe at any time and from anywhere — a failure leaves each file exactly as it was
 * (local, readable, still queued), so the worst outcome of a bad run is that nothing moved.
 */
export async function drainPendingForActor(
  actor: Actor,
  options: { limit?: number } = {},
): Promise<{ transferred: number; failed: number; bytes: number; remaining: number }> {
  assertAdmin(actor);

  const result = await drainPendingTransfers({
    deps: driveDeps(),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });

  return { ...result, remaining: await countPending() };
}

/** Read-only: how many uploads are still waiting. Used by the admin surfaces. */
export async function pendingTransferCount(actor: Actor): Promise<number> {
  assertAdmin(actor);
  return countPending();
}

export interface JobDetail {
  job: migrationRepository.JobRecord;
  itemCounts: Record<string, number>;
  openRecoveries: number;
}

export async function getJobDetail(actor: Actor, jobId: string): Promise<JobDetail> {
  assertAdmin(actor);
  const job = await requireJob(actor, jobId);

  const [itemCounts, openRecoveries] = await Promise.all([
    migrationRepository.countItemsByStatus(jobId),
    migrationRepository.countOpenRecoveries(actor.organizationId),
  ]);

  return { job, itemCounts, openRecoveries };
}

export async function listJobItems(
  actor: Actor,
  jobId: string,
  options: { failedOnly?: boolean; limit?: number; afterId?: string } = {},
): Promise<migrationRepository.ItemRecord[]> {
  assertAdmin(actor);
  await requireJob(actor, jobId);

  return migrationRepository.listItems({
    jobId,
    limit: Math.min(options.limit ?? 100, 500),
    ...(options.failedOnly ? { failedOnly: true } : {}),
    ...(options.afterId ? { afterId: options.afterId } : {}),
  });
}

export const storageMigrationService = {
  createJob,
  listJobs,
  planJobForActor,
  runJobForActor,
  pauseJob,
  retryFailed,
  verifyJobForActor,
  rollbackJobForActor,
  getJobDetail,
  listJobItems,
  drainPendingForActor,
  pendingTransferCount,
};
