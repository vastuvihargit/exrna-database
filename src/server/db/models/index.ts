/**
 * Model registry.
 *
 * Importing this module registers every schema with Mongoose, which matters for
 * `populate()` and for `syncIndexes()` to see the full set. Models are added here as
 * each phase introduces them (Phase 3: Folder, Phase 4: File/FileVersion/UploadSession, …).
 */
export { OrganizationModel } from './organization.model';
export type { OrganizationDocument } from './organization.model';
export { AppSettingModel } from './app-setting.model';
export type { AppSettingDocument } from './app-setting.model';
export { UserModel, USER_STATUSES, AUTH_PROVIDERS } from './user.model';
export type { UserDocument, UserStatus, AuthProviderName } from './user.model';
export { DepartmentModel } from './department.model';
export type { DepartmentDocument } from './department.model';
export { RoleModel } from './role.model';
export type { RoleDocument } from './role.model';
export { UserRoleModel } from './user-role.model';
export type { UserRoleDocument } from './user-role.model';
export { SessionModel, SESSION_REVOKE_REASONS } from './session.model';
export type { SessionDocument, SessionRevokeReason } from './session.model';
export { LoginHistoryModel, LOGIN_OUTCOMES } from './login-history.model';
export type { LoginHistoryDocument, LoginOutcome } from './login-history.model';
export { AuditLogModel, AUDIT_ACTIONS, AUDIT_OUTCOMES } from './audit-log.model';
export type { AuditLogDocument, AuditAction, AuditOutcome } from './audit-log.model';
export { PasswordResetTokenModel } from './password-reset-token.model';
export type { PasswordResetTokenDocument } from './password-reset-token.model';
export { ProjectModel, PROJECT_STATUSES } from './project.model';
export type { ProjectDocument, ProjectStatus } from './project.model';
export { FolderModel, DRIVE_TYPES, MAX_FOLDER_DEPTH } from './folder.model';
export type { FolderDocument, DriveType } from './folder.model';
export { StarModel, STARRABLE_TYPES } from './star.model';
export type { StarDocument, StarrableType } from './star.model';
export { ActivityModel, ACTIVITY_ENTITY_TYPES } from './activity.model';
export type { ActivityDocument, ActivityEntityType } from './activity.model';
export { RecentItemModel, RECENT_ENTITY_TYPES } from './recent-item.model';
export type { RecentItemDocument, RecentEntityType } from './recent-item.model';
export { FileModel, REVIEW_STATUSES, APPROVAL_STATUSES } from './file.model';
export type { FileDocument, ReviewStatus, ApprovalStatus } from './file.model';
export { FileVersionModel, PROCESSING_STATUSES, VERSION_LABELS } from './file-version.model';
export type { FileVersionDocument, ProcessingStatus, VersionLabel } from './file-version.model';
export { UploadSessionModel, UPLOAD_STATUSES } from './upload-session.model';
export type { UploadSessionDocument, UploadStatus } from './upload-session.model';
export { SavedSearchModel } from './saved-search.model';
export type { SavedSearchDocument } from './saved-search.model';
export { CommentModel } from './comment.model';
export type { CommentDocument } from './comment.model';
export { NotificationModel, NOTIFICATION_TYPES } from './notification.model';
export type { NotificationDocument, NotificationType } from './notification.model';
export { ReviewModel, REVIEW_REQUEST_STATUSES, REVIEW_DECISIONS } from './review.model';
export type { ReviewDocument, ReviewRequestStatus, ReviewDecision } from './review.model';
export { ExperimentModel, EXPERIMENT_STATUSES, EXPERIMENT_OUTCOMES } from './experiment.model';
export type { ExperimentDocument, ExperimentStatus, ExperimentOutcome } from './experiment.model';
export { MigrationJobModel, MIGRATION_STATUSES } from './migration-job.model';
export type { MigrationJobDocument, MigrationStatus } from './migration-job.model';
export { MigrationItemModel, MIGRATION_ITEM_STATUSES } from './migration-item.model';
export type { MigrationItemDocument, MigrationItemStatus } from './migration-item.model';
export { AlertStateModel } from './alert-state.model';
export type { AlertStateDocument } from './alert-state.model';

/** Inventory management. Two collections; everything else it needs it references. */
export { InventoryItemModel } from './inventory-item.model';
export type { InventoryItemDocument, InventoryBatchDocument } from './inventory-item.model';
export { StockTransactionModel, STOCK_ACTIONS, STOCK_ISSUE_TARGETS } from './stock-transaction.model';
export type { StockTransactionDocument, StockAction, StockIssueTarget } from './stock-transaction.model';

/**
 * Google Shared Drive storage backend.
 *
 * Note the `Storage` prefix: `MigrationJob`/`MigrationItem` above are the *inbound* Drive
 * importer and are a different feature entirely. See the header of
 * `storage-migration-job.model.ts`.
 */
export { StorageMigrationJobModel, STORAGE_MIGRATION_MODES, STORAGE_MIGRATION_JOB_STATUSES } from './storage-migration-job.model';
export type { StorageMigrationJobDocument, StorageMigrationMode, StorageMigrationJobStatus } from './storage-migration-job.model';
export { StorageMigrationItemModel, STORAGE_MIGRATION_FAILURE_CODES } from './storage-migration-item.model';
export type { StorageMigrationItemDocument, StorageMigrationFailureCode } from './storage-migration-item.model';
export { StorageRecoveryItemModel, RECOVERY_PHASES, RECOVERY_STATUSES } from './storage-recovery-item.model';
export type { StorageRecoveryItemDocument, RecoveryPhase, RecoveryStatus } from './storage-recovery-item.model';
export { DriveSyncStateModel, DRIVE_SYNC_STATES } from './drive-sync-state.model';
export type { DriveSyncStateDocument, DriveSyncRunState } from './drive-sync-state.model';

import { OrganizationModel } from './organization.model';
import { AppSettingModel } from './app-setting.model';
import { UserModel } from './user.model';
import { DepartmentModel } from './department.model';
import { RoleModel } from './role.model';
import { UserRoleModel } from './user-role.model';
import { SessionModel } from './session.model';
import { LoginHistoryModel } from './login-history.model';
import { AuditLogModel } from './audit-log.model';
import { PasswordResetTokenModel } from './password-reset-token.model';
import { ProjectModel } from './project.model';
import { FolderModel } from './folder.model';
import { StarModel } from './star.model';
import { ActivityModel } from './activity.model';
import { RecentItemModel } from './recent-item.model';
import { FileModel } from './file.model';
import { FileVersionModel } from './file-version.model';
import { UploadSessionModel } from './upload-session.model';
import { SavedSearchModel } from './saved-search.model';
import { CommentModel } from './comment.model';
import { NotificationModel } from './notification.model';
import { ReviewModel } from './review.model';
import { ExperimentModel } from './experiment.model';
import { MigrationJobModel } from './migration-job.model';
import { MigrationItemModel } from './migration-item.model';
import { AlertStateModel } from './alert-state.model';
import { InventoryItemModel } from './inventory-item.model';
import { StockTransactionModel } from './stock-transaction.model';
import { StorageMigrationJobModel } from './storage-migration-job.model';
import { StorageMigrationItemModel } from './storage-migration-item.model';
import { StorageRecoveryItemModel } from './storage-recovery-item.model';
import { DriveSyncStateModel } from './drive-sync-state.model';

/** Every registered model, used by the index-sync script and health reporting. */
export const registeredModels = [
  OrganizationModel,
  AppSettingModel,
  UserModel,
  DepartmentModel,
  RoleModel,
  UserRoleModel,
  SessionModel,
  LoginHistoryModel,
  AuditLogModel,
  PasswordResetTokenModel,
  ProjectModel,
  FolderModel,
  StarModel,
  ActivityModel,
  RecentItemModel,
  FileModel,
  FileVersionModel,
  UploadSessionModel,
  SavedSearchModel,
  CommentModel,
  NotificationModel,
  ReviewModel,
  ExperimentModel,
  MigrationJobModel,
  MigrationItemModel,
  AlertStateModel,
  InventoryItemModel,
  StockTransactionModel,
  StorageMigrationJobModel,
  StorageMigrationItemModel,
  StorageRecoveryItemModel,
  DriveSyncStateModel,
] as const;

/**
 * Builds every declared index. Called by the seed script and by deploys — never
 * implicitly on first query (`autoIndex: false`), because an accidental index build
 * against a large production collection is a self-inflicted outage.
 */
export async function syncAllIndexes(): Promise<void> {
  for (const registered of registeredModels) {
    await registered.syncIndexes();
  }
}
