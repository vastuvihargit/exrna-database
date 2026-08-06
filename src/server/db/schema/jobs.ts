/**
 * Job and synchronization state.
 *
 * Three unrelated things called "migration" meet in this file, so the D1 names disambiguate
 * what MongoDB did not:
 *
 *   `import_*`             reading somebody's Google Drive *into* this platform
 *                          (was `migrationJobs` / `migrationItems`)
 *   `storage_migration_*`  moving company files *into* the Shared Drive — unchanged
 *   `d1_migration_*`       this migration, MongoDB → D1 — new in Phase 5
 *
 * The `AUDIT_ACTIONS` enum keeps its existing `migration.*` and `storage_migration.*` strings
 * untouched: those are persisted data, and renaming them would orphan every historic row.
 */
import { index, sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { CONFIDENTIALITY_LEVELS } from '@/server/domain/permissions';
import { UPLOAD_STATUSES } from '@/server/db/models/upload-session.model';
import { MIGRATION_ITEM_STATUSES } from '@/server/db/models/migration-item.model';
import { MIGRATION_STATUSES as IMPORT_JOB_STATUSES } from '@/server/db/models/migration-job.model';
import {
  STORAGE_MIGRATION_JOB_STATUSES,
  STORAGE_MIGRATION_MODES,
} from '@/server/db/models/storage-migration-job.model';
import { STORAGE_MIGRATION_FAILURE_CODES } from '@/server/db/models/storage-migration-item.model';
import { RECOVERY_PHASES, RECOVERY_STATUSES } from '@/server/db/models/storage-recovery-item.model';
import { DRIVE_SYNC_STATES } from '@/server/db/models/drive-sync-state.model';
import { STORAGE_MIGRATION_STATUSES } from '@/server/db/storage-fields';
import { boolean, createdAtColumn, enumText, softDeleteColumns, timestampColumns } from './_shared';
import { departments, organizations, users } from './identity';
import { projects } from './research';
import { files, fileVersions, folders } from './drive';

/* ------------------------------------------------------------------ upload_sessions */

export const uploadSessions = sqliteTable(
  'upload_sessions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),

    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id),
    targetFileId: text('target_file_id').references(() => files.id),

    declaredFilename: text('declared_filename').notNull(),
    displayName: text('display_name').notNull(),
    extension: text('extension').notNull(),
    declaredSize: integer('declared_size').notNull(),
    declaredMimeType: text('declared_mime_type'),
    resolvedMimeType: text('resolved_mime_type').notNull(),
    versionNote: text('version_note').notNull().default(''),

    status: enumText('status', UPLOAD_STATUSES).notNull().default('pending'),
    receivedBytes: integer('received_bytes').notNull().default(0),
    chunkSize: integer('chunk_size').notNull().default(0),
    totalChunks: integer('total_chunks').notNull().default(0),
    /** JSON array of received chunk indexes; read whole to decide what to re-request. */
    receivedChunks: text('received_chunks').notNull().default('[]'),

    quarantineKey: text('quarantine_key'),
    checksumSha256: text('checksum_sha256'),

    resultFileId: text('result_file_id').references(() => files.id),
    resultVersionId: text('result_version_id').references(() => fileVersions.id),
    failureReason: text('failure_reason'),

    /** Set once on first successful finalization; a retry returns the same result. */
    finalizationKey: text('finalization_key'),
    expiresAt: text('expires_at').notNull(),
    ...timestampColumns,
  },
  (table) => [
    index('ix_upload_sessions_user').on(table.userId, table.status, table.createdAt),
    index('ix_upload_sessions_folder').on(table.folderId, table.status),
    index('ix_upload_sessions_org').on(table.organizationId, table.status, table.createdAt),
    /**
     * No TTL. An abandoned upload holds bytes in quarantine, and deleting the record without
     * deleting the object would strand them — the cleanup job removes both, in order.
     */
    index('ix_upload_sessions_expiry').on(table.expiresAt),
  ],
);

/* ------------------------------------------------------------------ import_* (inbound Drive) */

export const importJobs = sqliteTable(
  'import_jobs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),

    status: enumText('status', IMPORT_JOB_STATUSES).notNull().default('draft'),

    targetFolderId: text('target_folder_id')
      .notNull()
      .references(() => folders.id),
    departmentId: text('department_id').references(() => departments.id),
    projectId: text('project_id').references(() => projects.id),
    confidentiality: enumText('confidentiality', CONFIDENTIALITY_LEVELS)
      .notNull()
      .default('internal'),

    /** Drive folder ids to read from, as a JSON array of strings. */
    sourceFolderIds: text('source_folder_ids').notNull().default('[]'),

    connectionAccountEmail: text('connection_account_email'),
    /**
     * The sealed OAuth refresh token, `v1.iv.tag.ct`.
     *
     * Migrated as an opaque string. `secret-box.ts` keeps the exact same wire format across
     * the Node and Worker runtimes, so a token sealed before the migration opens after it —
     * which is what stops a cutover silently disconnecting every configured import.
     */
    connectionRefreshTokenCipher: text('connection_refresh_token_cipher'),
    connectionScope: text('connection_scope'),
    connectedAt: text('connected_at'),
    connectedBy: text('connected_by').references(() => users.id),

    optionPreserveHierarchy: boolean('option_preserve_hierarchy').notNull().default(true),
    optionPreserveDates: boolean('option_preserve_dates').notNull().default(true),
    optionSkipDuplicates: boolean('option_skip_duplicates').notNull().default(true),
    optionExportGoogleDocs: boolean('option_export_google_docs').notNull().default(true),

    /** Progress counters as JSON — eight integers, always read together. */
    counters: text('counters').notNull().default('{}'),

    scanStartedAt: text('scan_started_at'),
    scanCompletedAt: text('scan_completed_at'),
    importStartedAt: text('import_started_at'),
    completedAt: text('completed_at'),
    lastError: text('last_error'),

    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    index('ix_import_jobs_org').on(table.organizationId, table.status, table.createdAt),
    index('ix_import_jobs_creator').on(table.createdBy, table.createdAt),
  ],
);

export const importItems = sqliteTable(
  'import_items',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    jobId: text('job_id')
      .notNull()
      .references(() => importJobs.id, { onDelete: 'cascade' }),

    driveFileId: text('drive_file_id').notNull(),
    driveParentId: text('drive_parent_id'),
    sourcePath: text('source_path').notNull().default(''),

    name: text('name').notNull(),
    mimeType: text('mime_type').notNull().default(''),
    declaredSize: integer('declared_size').notNull().default(0),
    driveMd5: text('drive_md5'),
    driveCreatedTime: text('drive_created_time'),
    driveModifiedTime: text('drive_modified_time'),
    isGoogleNative: boolean('is_google_native').notNull().default(false),

    status: enumText('status', MIGRATION_ITEM_STATUSES).notNull().default('pending'),
    targetFolderId: text('target_folder_id').references(() => folders.id),
    resultFileId: text('result_file_id').references(() => files.id),
    resultVersionId: text('result_version_id').references(() => fileVersions.id),
    checksumSha256: text('checksum_sha256'),
    importedBytes: integer('imported_bytes').notNull().default(0),

    duplicateOfFileId: text('duplicate_of_file_id').references(() => files.id),

    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    importedAt: text('imported_at'),
    ...timestampColumns,
  },
  (table) => [
    /** One row per Drive file per job — a re-scan updates rather than re-importing. */
    uniqueIndex('ux_import_items_job_drive_file').on(table.jobId, table.driveFileId),
    index('ix_import_items_job_status').on(table.jobId, table.status, table.id),
    index('ix_import_items_org_drive_file').on(table.organizationId, table.driveFileId),
    index('ix_import_items_result').on(table.resultFileId),
  ],
);

/* ------------------------------------------------------------------ storage_migration_* */

export const storageMigrationJobs = sqliteTable(
  'storage_migration_jobs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),

    mode: enumText('mode', STORAGE_MIGRATION_MODES).notNull(),
    status: enumText('status', STORAGE_MIGRATION_JOB_STATUSES).notNull().default('draft'),

    /** Selection criteria and counters as JSON — read whole when the job is planned or shown. */
    selection: text('selection').notNull().default('{}'),
    counters: text('counters').notNull().default('{}'),
    throughputSamples: text('throughput_samples').notNull().default('[]'),
    failureCounts: text('failure_counts').notNull().default('{}'),

    pauseRequested: boolean('pause_requested').notNull().default(false),
    cancelRequested: boolean('cancel_requested').notNull().default(false),

    plannedAt: text('planned_at'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    lastError: text('last_error'),
    lastProgressAt: text('last_progress_at'),

    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    ...timestampColumns,
  },
  (table) => [
    index('ix_storage_migration_jobs_org').on(table.organizationId, table.status, table.createdAt),
    index('ix_storage_migration_jobs_creator').on(table.createdBy, table.createdAt),
  ],
);

export const storageMigrationItems = sqliteTable(
  'storage_migration_items',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    jobId: text('job_id')
      .notNull()
      .references(() => storageMigrationJobs.id, { onDelete: 'cascade' }),

    versionId: text('version_id')
      .notNull()
      .references(() => fileVersions.id),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id),
    displayName: text('display_name').notNull().default(''),
    versionNumber: integer('version_number').notNull().default(1),
    sizeBytes: integer('size_bytes').notNull().default(0),

    status: enumText('status', STORAGE_MIGRATION_STATUSES).notNull().default('not_started'),

    claimActive: boolean('claim_active').notNull().default(false),
    claimedAt: text('claimed_at'),
    claimedBy: text('claimed_by'),

    idempotencyKey: text('idempotency_key').notNull(),

    googleDriveFileId: text('google_drive_file_id'),
    googleDriveParentId: text('google_drive_parent_id'),

    localSha256: text('local_sha256'),
    localMd5: text('local_md5'),
    remoteMd5: text('remote_md5'),
    checksumVerified: boolean('checksum_verified').notNull().default(false),

    attempts: integer('attempts').notNull().default(0),
    failureCode: enumText('failure_code', STORAGE_MIGRATION_FAILURE_CODES),
    failureDetail: text('failure_detail'),

    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    transferMs: integer('transfer_ms'),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('ux_storage_migration_items_job_version').on(table.jobId, table.versionId),
    /**
     * **One active claim per version, across all jobs.**
     *
     * Partial on `claim_active = 1`, reproducing the Mongo index. This is what stops two
     * workers — or a worker and a manual drain — transferring the same version concurrently
     * and producing two Drive files for it.
     */
    uniqueIndex('ux_storage_migration_items_claim')
      .on(table.versionId)
      .where(sql`claim_active = 1`),
    index('ix_storage_migration_items_job_status').on(table.jobId, table.status, table.id),
    index('ix_storage_migration_items_failures').on(table.jobId, table.failureCode),
    index('ix_storage_migration_items_version').on(table.versionId, table.status),
    /** Stale-claim reaping: which claims have been held too long? */
    index('ix_storage_migration_items_stale')
      .on(table.claimedAt)
      .where(sql`claim_active = 1`),
  ],
);

export const storageRecoveryItems = sqliteTable(
  'storage_recovery_items',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),

    versionId: text('version_id').references(() => fileVersions.id),
    folderId: text('folder_id').references(() => folders.id),
    jobId: text('job_id').references(() => storageMigrationJobs.id),

    phase: enumText('phase', RECOVERY_PHASES).notNull(),
    status: enumText('status', RECOVERY_STATUSES).notNull().default('open'),

    idempotencyKey: text('idempotency_key').notNull(),
    observedDriveFileId: text('observed_drive_file_id'),
    /** The state to revert to, as JSON. */
    previousState: text('previous_state'),

    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: text('last_attempt_at'),
    detail: text('detail'),

    resolvedAt: text('resolved_at'),
    resolvedBy: text('resolved_by').references(() => users.id),
    ...timestampColumns,
  },
  (table) => [
    /** One open recovery per idempotency key — a retry adopts rather than duplicates. */
    uniqueIndex('ux_storage_recovery_items_open')
      .on(table.idempotencyKey)
      .where(sql`status = 'open'`),
    index('ix_storage_recovery_items_open')
      .on(table.organizationId, table.lastAttemptAt)
      .where(sql`status = 'open'`),
    index('ix_storage_recovery_items_org').on(table.organizationId, table.status, table.createdAt),
    index('ix_storage_recovery_items_version').on(table.versionId),
  ],
);

/* ------------------------------------------------------------------ drive_sync_states */

export const driveSyncStates = sqliteTable(
  'drive_sync_states',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    sharedDriveId: text('shared_drive_id').notNull(),

    state: enumText('state', DRIVE_SYNC_STATES).notNull().default('idle'),

    /** The change-feed cursor. Advancing it is what makes the next poll incremental. */
    startPageToken: text('start_page_token'),
    tokenExpiredAt: text('token_expired_at'),

    lastPollAt: text('last_poll_at'),
    lastSuccessfulPollAt: text('last_successful_poll_at'),
    lastFullReconcileAt: text('last_full_reconcile_at'),

    changesApplied: integer('changes_applied').notNull().default(0),
    conflictsDetected: integer('conflicts_detected').notNull().default(0),

    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastError: text('last_error'),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('ux_drive_sync_states').on(table.organizationId, table.sharedDriveId),
  ],
);

/* ------------------------------------------------------------------ alert_states */

export const alertStates = sqliteTable(
  'alert_states',
  {
    id: text('id').primaryKey(),
    /** Stable identity of the condition, e.g. `disk` or `backup`. */
    key: text('key').notNull(),
    severity: enumText('severity', ['warning', 'critical'] as const).notNull(),
    lastSentAt: text('last_sent_at').notNull(),
    occurrences: integer('occurrences').notNull().default(1),
    lastDetail: text('last_detail').notNull().default(''),
    /** Set when the condition clears, so a recovery notice is sent exactly once. */
    resolvedAt: text('resolved_at'),
    ...timestampColumns,
  },
  (table) => [uniqueIndex('ux_alert_states_key').on(table.key)],
);

/* ------------------------------------------------------------------ sync_jobs (Phase 4) */

/**
 * Queue and workflow job status, visible to administrators.
 *
 * The brief requires job status to live in D1 and failures to be admin-visible. This is that
 * table. It is written by the Phase 4 queue consumers and workflow steps, and read by the
 * admin System page.
 *
 * `idempotency_key` is unique and is the duplicate-processing guard: a redelivered queue
 * message inserts, collides, and the consumer treats the collision as "already done" rather
 * than doing the work twice. At-least-once delivery makes this mandatory, not optional.
 */
export const syncJobs = sqliteTable(
  'sync_jobs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').references(() => organizations.id),

    /** `drive.sync`, `search.index`, `notification.send`, `file.metadata`, … */
    kind: text('kind').notNull(),
    /** `queue` for a Queues consumer, `workflow` for a Workflows step. */
    source: enumText('source', ['queue', 'workflow'] as const).notNull(),
    queueName: text('queue_name'),

    status: enumText('status', [
      'pending',
      'running',
      'succeeded',
      'failed',
      'dead_lettered',
    ] as const)
      .notNull()
      .default('pending'),

    idempotencyKey: text('idempotency_key').notNull(),

    /** What the job is about — polymorphic, so not a foreign key. */
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** The message body as JSON, so a failed job can be inspected and replayed. */
    payload: text('payload'),

    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),

    scheduledAt: text('scheduled_at'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    ...timestampColumns,
  },
  (table) => [
    /** The duplicate-processing guard. */
    uniqueIndex('ux_sync_jobs_idempotency').on(table.idempotencyKey),
    index('ix_sync_jobs_status').on(table.status, table.scheduledAt),
    index('ix_sync_jobs_kind').on(table.kind, table.status, table.createdAt),
    index('ix_sync_jobs_entity').on(table.entityType, table.entityId),
    /** The admin failure view — small, because most jobs succeed. */
    index('ix_sync_jobs_failures')
      .on(table.organizationId, table.finishedAt)
      .where(sql`status IN ('failed', 'dead_lettered')`),
  ],
);

/* ------------------------------------------------------------------ d1_migration_* (Phase 5) */

/**
 * MongoDB → D1 migration checkpoints.
 *
 * One row per collection per run. `lastId` is the resume cursor: ObjectId hex sorts
 * monotonically by creation time, so `WHERE _id > :last_id` is stable across restarts and
 * makes resume a matter of reading one row rather than re-deriving progress.
 */
export const d1MigrationRuns = sqliteTable(
  'd1_migration_runs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    collection: text('collection').notNull(),

    status: enumText('status', [
      'pending',
      'running',
      'completed',
      'failed',
      'skipped',
    ] as const)
      .notNull()
      .default('pending'),

    /** True for a dry run: everything validated and transformed, nothing written. */
    dryRun: boolean('dry_run').notNull().default(false),

    lastId: text('last_id'),
    rowsRead: integer('rows_read').notNull().default(0),
    rowsWritten: integer('rows_written').notNull().default(0),
    rowsSkipped: integer('rows_skipped').notNull().default(0),
    rowsFailed: integer('rows_failed').notNull().default(0),

    /** Record-count comparison, filled by the verification pass. */
    sourceCount: integer('source_count'),
    targetCount: integer('target_count'),

    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    lastError: text('last_error'),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('ux_d1_migration_runs').on(table.runId, table.collection),
    index('ix_d1_migration_runs_status').on(table.runId, table.status),
  ],
);

/** Per-record failure report. The payload is kept so a fix can be replayed, not re-derived. */
export const d1MigrationFailures = sqliteTable(
  'd1_migration_failures',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    collection: text('collection').notNull(),
    /** The source `_id`, so the offending document can be found in MongoDB directly. */
    sourceId: text('source_id').notNull(),
    reason: text('reason').notNull(),
    payload: text('payload'),
    ...createdAtColumn,
  },
  (table) => [
    index('ix_d1_migration_failures_run').on(table.runId, table.collection),
    index('ix_d1_migration_failures_source').on(table.sourceId),
  ],
);
