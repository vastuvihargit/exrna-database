/**
 * The complete D1 schema.
 *
 * Every MongoDB collection listed in `src/server/db/models/index.ts` has a mapping here.
 * The full collection → table table, including every embedded array that had to be
 * normalized and why, is in `docs/cloudflare-migration/00-phase-0-analysis.md` §3.
 *
 * Importing this module is what `drizzle-kit` reads to generate migrations, and what the
 * Phase 3 repositories will import to build queries. It is types and table definitions only —
 * no connection, no runtime behaviour.
 */

export * from './_shared';
export * from './identity';
export * from './access';
export * from './research';
export * from './drive';
export * from './collaboration';
export * from './inventory';
export * from './audit';
export * from './jobs';

import * as identity from './identity';
import * as access from './access';
import * as research from './research';
import * as drive from './drive';
import * as collaboration from './collaboration';
import * as inventory from './inventory';
import * as audit from './audit';
import * as jobs from './jobs';

/**
 * Every table, for the migration tooling and the schema-contract test.
 *
 * `access` re-exports three tables from `identity` for convenience; they are listed once
 * here, from `identity`, so a count of this object is a count of real tables.
 */
export const schema = {
  // identity
  organizations: identity.organizations,
  departments: identity.departments,
  users: identity.users,
  userAuthProviders: identity.userAuthProviders,
  appSettings: identity.appSettings,

  // access control
  permissions: access.permissions,
  roles: access.roles,
  rolePermissions: access.rolePermissions,
  roleScopeTypes: access.roleScopeTypes,
  userRoles: access.userRoles,
  resourcePermissions: access.resourcePermissions,

  // research
  projects: research.projects,
  projectMembers: research.projectMembers,
  experiments: research.experiments,
  experimentCollaborators: research.experimentCollaborators,
  experimentSamples: research.experimentSamples,

  // drive
  folders: drive.folders,
  folderAncestors: drive.folderAncestors,
  files: drive.files,
  fileFolderAncestors: drive.fileFolderAncestors,
  fileMetadata: drive.fileMetadata,
  fileVersions: drive.fileVersions,
  resourceTags: drive.resourceTags,

  // collaboration
  comments: collaboration.comments,
  commentMentions: collaboration.commentMentions,
  reviews: collaboration.reviews,
  reviewReviewers: collaboration.reviewReviewers,
  approvals: collaboration.approvals,
  notifications: collaboration.notifications,

  // inventory
  inventoryItems: inventory.inventoryItems,
  inventoryBatches: inventory.inventoryBatches,
  inventoryItemDocuments: inventory.inventoryItemDocuments,
  stockTransactions: inventory.stockTransactions,
  stockTransactionDocuments: inventory.stockTransactionDocuments,

  // audit & per-user state
  auditLogs: audit.auditLogs,
  sessions: audit.sessions,
  loginHistory: audit.loginHistory,
  passwordResetTokens: audit.passwordResetTokens,
  activities: audit.activities,
  activityFolders: audit.activityFolders,
  stars: audit.stars,
  recentItems: audit.recentItems,
  savedSearches: audit.savedSearches,

  // jobs & synchronization
  uploadSessions: jobs.uploadSessions,
  importJobs: jobs.importJobs,
  importItems: jobs.importItems,
  storageMigrationJobs: jobs.storageMigrationJobs,
  storageMigrationItems: jobs.storageMigrationItems,
  storageRecoveryItems: jobs.storageRecoveryItems,
  driveSyncStates: jobs.driveSyncStates,
  alertStates: jobs.alertStates,
  syncJobs: jobs.syncJobs,
  d1MigrationRuns: jobs.d1MigrationRuns,
  d1MigrationFailures: jobs.d1MigrationFailures,
} as const;

export type Schema = typeof schema;
