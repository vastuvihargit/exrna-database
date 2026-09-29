/**
 * The migration order.
 *
 * Order is stated once, here, and is the same for a dry run, a rehearsal, the bulk load and the
 * final delta pass. Every entry's `requires` is checked against what has already run, so a
 * partial run (`--steps files`) refuses rather than failing on a foreign key halfway through a
 * batch — which in D1 takes the other 499 records in that batch with it.
 *
 * ── What is deliberately not migrated ───────────────────────────────────────────────────
 *
 * `upload_sessions`  — an upload in flight. The cutover has a write freeze; by definition
 *                      there are none, and copying a half-finished upload would resume it
 *                      against a quarantine directory the Worker does not have.
 * `password_reset_tokens` — single-use and short-lived. A reset link issued minutes before the
 *                      cutover is worth less than the risk of copying a live credential, and
 *                      the user can request another.
 * `import_*`, `storage_migration_*`, `storage_recovery_items`, `sync_jobs`
 *                    — Node-only tooling state. `migration` and `storage-migration` read the
 *                      local filesystem by definition and keep running on Node against MongoDB
 *                      until the byte migration finishes; copying their job rows into D1 would
 *                      create a second, stale copy of a queue that is still being worked.
 *
 * Each of these is a decision with a reason, not an omission. `verify.ts` lists them so a
 * count comparison does not report them as missing.
 */
import {
  appSettingsStep,
  departmentBackfillStep,
  departmentsStep,
  organizationsStep,
  userBackfillStep,
  usersStep,
} from './steps/identity';
import { fileAclStep, folderAclStep, rolesStep, userRolesStep } from './steps/access';
import { experimentsStep, projectsStep } from './steps/research';
import {
  fileVersionBackfillStep,
  fileVersionsStep,
  filesStep,
  folderHierarchyStep,
  foldersStep,
} from './steps/drive';
import {
  commentBackfillStep,
  commentsStep,
  notificationsStep,
  reviewsStep,
} from './steps/collaboration';
import {
  activitiesStep,
  auditLogsStep,
  loginHistoryStep,
  recentItemsStep,
  savedSearchesStep,
  sessionBackfillStep,
  sessionsStep,
  starsStep,
} from './steps/activity';
import { inventoryItemsStep, stockTransactionsStep } from './steps/inventory';
import { alertStatesStep, driveSyncStatesStep } from './steps/operations';
import type { MigrationStep } from './types';

export const MIGRATION_STEPS: readonly MigrationStep[] = [
  // Identity first: everything below carries an organization_id foreign key.
  organizationsStep,
  departmentsStep,
  usersStep,
  departmentBackfillStep,
  userBackfillStep,
  appSettingsStep,

  // Authorization before anything it protects.
  rolesStep,
  userRolesStep,

  // Research structure, which folders and files point at.
  projectsStep,
  experimentsStep,

  // The drive. Folders flat, then the tree, then files, then versions.
  foldersStep,
  folderHierarchyStep,
  filesStep,
  fileVersionsStep,
  fileVersionBackfillStep,

  // Resource ACLs, once both kinds of resource exist.
  folderAclStep,
  fileAclStep,

  // Collaboration, which points at exact versions.
  commentsStep,
  commentBackfillStep,
  reviewsStep,
  notificationsStep,

  // The record of what happened.
  auditLogsStep,
  sessionsStep,
  sessionBackfillStep,
  loginHistoryStep,
  activitiesStep,
  starsStep,
  recentItemsStep,
  savedSearchesStep,

  // Inventory.
  inventoryItemsStep,
  stockTransactionsStep,

  // Operational state.
  driveSyncStatesStep,
  alertStatesStep,
];

export function stepByName(name: string): MigrationStep | undefined {
  return MIGRATION_STEPS.find((step) => step.name === name);
}

/**
 * Tables no step writes, with the reason.
 *
 * Kept next to the registry rather than in the verifier, because the reason a table is empty is
 * a migration decision and belongs where the decisions are.
 */
export const INTENTIONALLY_NOT_MIGRATED: Record<string, string> = {
  upload_sessions: 'in-flight uploads; the cutover write freeze means there are none',
  password_reset_tokens: 'single-use short-lived credentials; users request a new link',
  import_jobs: 'Node-only inbound-import tooling that keeps running against MongoDB',
  import_items: 'Node-only inbound-import tooling that keeps running against MongoDB',
  storage_migration_jobs: 'byte-migration tooling; reads the local filesystem, stays on Node',
  storage_migration_items: 'byte-migration tooling; reads the local filesystem, stays on Node',
  storage_recovery_items: 'byte-migration tooling; reads the local filesystem, stays on Node',
  sync_jobs: 'queue state; drained before the cutover rather than copied mid-flight',
  permissions: 'a catalogue seeded by migration 0001, not application data',
  d1_migration_runs: 'the migration’s own checkpoint table',
  d1_migration_failures: 'the migration’s own failure report',
};
