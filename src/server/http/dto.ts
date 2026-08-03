/**
 * Response shaping.
 *
 * DTO mappers are the last line of defence for the "no internals in a response" rule:
 * password hashes, session token hashes and (from Phase 4) storage keys are simply not
 * present in the shapes below, so they cannot leak even if a repository starts
 * returning them.
 */
import { getEnv } from '@/server/config/env';
import type { Actor } from '@/server/permissions/actor';
import type { UserSummary, DirectoryEntry } from '@/server/services/user.service';
import type { DepartmentRecord } from '@/server/repositories/department.repository';
import type { SessionRecord } from '@/server/repositories/session.repository';
import type { LoginHistoryRecord } from '@/server/repositories/login-history.repository';
import type { FolderView, BreadcrumbEntry } from '@/server/services/folder.service';
import type { ProjectRecord } from '@/server/repositories/project.repository';
import type { ActivityRecord } from '@/server/repositories/activity.repository';
import type { FileView, RelatedFile } from '@/server/services/file.service';
import type { ExperimentView } from '@/server/services/experiment.service';
import type { InventoryItemView } from '@/server/services/inventory.service';
import type {
  MigrationItemRecord,
  MigrationJobRecord,
} from '@/server/repositories/migration.repository';
import type { VersionRecord } from '@/server/repositories/file-version.repository';
import type { SavedSearchRecord } from '@/server/repositories/saved-search.repository';
import type { NotificationRecord } from '@/server/repositories/notification.repository';
import type { ShareStateView } from '@/server/services/sharing.service';
import type { CommentView } from '@/server/services/comment.service';
import type { ReviewView } from '@/server/services/review.service';

export interface SessionDto {
  user: {
    id: string;
    email: string;
    name: string;
    departmentId: string | null;
    projectIds: string[];
    isSuperAdmin: boolean;
  };
  roles: Array<{ key: string; name: string; scopeType: string; scopeId: string | null }>;
  /**
   * Sent so the UI can hide actions the user cannot perform. It is a rendering hint —
   * every API route re-derives permission server-side and never trusts this list.
   */
  permissions: string[];
  storage: { usedBytes: number; quotaBytes: number };
}

export function toSessionDto(actor: Actor): SessionDto {
  return {
    user: {
      id: actor.userId,
      email: actor.email,
      name: actor.name,
      departmentId: actor.departmentId,
      projectIds: actor.projectIds,
      isSuperAdmin: actor.isSuperAdmin,
    },
    roles: actor.grants.map((grant) => ({
      key: grant.roleKey,
      name: grant.roleName,
      scopeType: grant.scopeType,
      scopeId: grant.scopeId,
    })),
    permissions: [...actor.permissions],
    storage: { usedBytes: actor.storageUsedBytes, quotaBytes: actor.storageQuotaBytes },
  };
}

export function toUserDto(user: UserSummary) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    jobTitle: user.jobTitle,
    avatarUrl: user.avatarUrl,
    departmentId: user.departmentId,
    status: user.status,
    isSuperAdmin: user.isSuperAdmin,
    roles: user.roles,
    storageQuotaBytes: user.storageQuotaBytes,
    storageUsedBytes: user.storageUsedBytes,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    mfaEnabled: user.mfaEnabled,
    authProviders: user.authProviders,
  };
}

export function toDirectoryDto(entry: DirectoryEntry) {
  return entry;
}

export function toDepartmentDto(department: DepartmentRecord) {
  return {
    id: department.id,
    name: department.name,
    code: department.code,
    description: department.description,
    headUserId: department.headUserId,
    parentDepartmentId: department.parentDepartmentId,
    storageQuotaBytes: department.storageQuotaBytes,
    storageUsedBytes: department.storageUsedBytes,
    memberCount: department.memberCount,
    isActive: department.isActive,
    createdAt: department.createdAt,
  };
}

/**
 * Folder response shape.
 *
 * `pathAncestors` is included because the client needs it to build "move into" guards,
 * but nothing physical is: a folder has no storage key, and the ACL array is omitted —
 * who else a folder is shared with is answered by the sharing endpoint, which applies
 * its own permission check (Phase 7).
 */
export function toFolderDto(folder: FolderView) {
  return {
    id: folder.id,
    name: folder.name,
    parentFolderId: folder.parentFolderId,
    pathAncestors: folder.pathAncestors,
    depth: folder.depth,
    driveType: folder.driveType,
    ownerId: folder.ownerId,
    departmentId: folder.departmentId,
    projectId: folder.projectId,
    confidentiality: folder.confidentiality,
    status: folder.status,
    description: folder.description,
    color: folder.color,
    templateKey: folder.templateKey,
    isSystem: folder.isSystem,
    isRoot: folder.parentFolderId === null,
    inheritPermissions: folder.inheritPermissions,
    childFolderCount: folder.childFolderCount,
    fileCount: folder.fileCount,
    isStarred: folder.isStarred,
    capabilities: folder.capabilities,
    createdBy: folder.createdBy,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    deletedAt: folder.deletedAt,
  };
}

export function toBreadcrumbDto(entry: BreadcrumbEntry) {
  return entry;
}

/**
 * File response shape.
 *
 * There is no storage key, no path and no version key here — and there is no field to
 * add one to, which is the point. A client that wants bytes asks the download endpoint,
 * which checks permission and streams; it never learns where the file lives.
 */
export function toFileDto(file: FileView) {
  return {
    id: file.id,
    displayName: file.displayName,
    originalFilename: file.originalFilename,
    extension: file.extension,
    category: file.category,
    folderId: file.folderId,
    driveType: file.driveType,
    ownerId: file.ownerId,
    departmentId: file.departmentId,
    projectId: file.projectId,
    experimentId: file.experimentId,
    currentVersionId: file.currentVersionId,
    approvedVersionId: file.approvedVersionId,
    versionCount: file.versionCount,
    sizeBytes: file.sizeBytes,
    mimeType: file.mimeType,
    checksumSha256: file.checksumSha256,
    tags: file.tags,
    metadata: file.metadata,
    confidentiality: file.confidentiality,
    reviewStatus: file.reviewStatus,
    approvalStatus: file.approvalStatus,
    status: file.status,
    inheritPermissions: file.inheritPermissions,
    downloadCount: file.downloadCount,
    isStarred: file.isStarred,
    previewable: file.previewable,
    /**
     * Whether to offer "Open in Google Docs" for this file.
     *
     * Two conditions, resolved here so the interface never has to reason about either: the
     * content really is a Google-native document, *and* this deployment has switched the
     * affordance on. A button that leads to a Google permission-denied page is worse than no
     * button, and only the server knows whether that is what would happen.
     */
    opensInGoogleEditor:
      file.hasGoogleNativeContent && getEnv().GOOGLE_DRIVE_NATIVE_EDITOR_ENABLED,
    capabilities: file.capabilities,
    createdBy: file.createdBy,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    deletedAt: file.deletedAt,
  };
}

export function toVersionDto(version: VersionRecord) {
  return {
    id: version.id,
    fileId: version.fileId,
    versionNumber: version.versionNumber,
    originalFilename: version.originalFilename,
    fileSize: version.fileSize,
    mimeType: version.mimeType,
    extension: version.extension,
    checksumSha256: version.checksumSha256,
    uploadedBy: version.uploadedBy,
    uploadedAt: version.uploadedAt,
    versionNote: version.versionNote,
    restoredFromVersionId: version.restoredFromVersionId,
    processingStatus: version.processingStatus,
    label: version.label,
    isCurrent: version.isCurrent,
    isApproved: version.isApproved,
    approvedBy: version.approvedBy,
    approvedAt: version.approvedAt,
    /**
     * Why an approval stopped holding, in a sentence an employee can act on. The revision
     * identifiers that produced it stay on the server: §19 keeps those out of this surface,
     * and knowing one would not help anybody decide what to do next.
     */
    approvalSupersededAt: version.approvalSupersededAt,
    approvalSupersededReason: version.approvalSupersededReason,
    previewStatus: version.previewStatus,
  };
}

/**
 * The share list.
 *
 * Principal *names* are included because a list of raw ids is unusable, but nothing else
 * about those people is: no department, no status, no role. The share dialog needs to
 * say who has access, not to become a second directory with different disclosure rules.
 */
export function toShareStateDto(state: ShareStateView) {
  return {
    targetType: state.targetType,
    targetId: state.targetId,
    targetName: state.targetName,
    inheritPermissions: state.inheritPermissions,
    ownerId: state.ownerId,
    confidentiality: state.confidentiality,
    capabilities: state.capabilities,
    entries: state.entries.map((entry) => ({
      principalType: entry.principalType,
      principalId: entry.principalId,
      principalName: entry.principalName,
      principalEmail: entry.principalEmail,
      accessLevel: entry.accessLevel,
      deny: entry.deny,
      expiresAt: entry.expiresAt,
      inherited: entry.inherited,
      inheritedFromFolderId: entry.inheritedFromFolderId,
      inheritedFromFolderName: entry.inheritedFromFolderName,
    })),
  };
}

export function toCommentDto(comment: CommentView) {
  return {
    id: comment.id,
    fileId: comment.fileId,
    versionId: comment.versionId,
    versionNumber: comment.versionNumber,
    parentCommentId: comment.parentCommentId,
    authorUserId: comment.authorUserId,
    authorName: comment.authorName,
    body: comment.body,
    mentionedUserIds: comment.mentionedUserIds,
    isReviewComment: comment.isReviewComment,
    resolvedAt: comment.resolvedAt,
    resolvedBy: comment.resolvedBy,
    editedAt: comment.editedAt,
    createdAt: comment.createdAt,
    capabilities: comment.capabilities,
    replies: comment.replies.map((reply) => ({
      id: reply.id,
      parentCommentId: reply.parentCommentId,
      authorUserId: reply.authorUserId,
      authorName: reply.authorName,
      body: reply.body,
      mentionedUserIds: reply.mentionedUserIds,
      editedAt: reply.editedAt,
      createdAt: reply.createdAt,
    })),
  };
}

/**
 * A review request and its decisions.
 *
 * The version checksum is included deliberately: it is what lets a reader verify that
 * the approved bytes are the bytes still on disk, which is the whole claim an approval
 * makes. The reviewer's IP and user agent are *not* included — they are evidence for the
 * audit log, not something every colleague who opens the file needs to see.
 */
export function toReviewDto(review: ReviewView) {
  return {
    id: review.id,
    fileId: review.fileId,
    fileName: review.fileName,
    versionId: review.versionId,
    versionNumber: review.versionNumber,
    versionChecksum: review.versionChecksum,
    requestedBy: review.requestedBy,
    requestedByName: review.requestedByName,
    requestNote: review.requestNote,
    reviewerUserIds: review.reviewerUserIds,
    requiredApprovals: review.requiredApprovals,
    approvalsSoFar: review.approvalsSoFar,
    status: review.status,
    dueAt: review.dueAt,
    closedAt: review.closedAt,
    createdAt: review.createdAt,
    capabilities: review.capabilities,
    decisions: review.decisions.map((decision) => ({
      reviewerUserId: decision.reviewerUserId,
      reviewerName: decision.reviewerName,
      decision: decision.decision,
      comment: decision.comment,
      decidedAt: decision.decidedAt,
    })),
  };
}

export function toNotificationDto(entry: NotificationRecord) {
  return {
    id: entry.id,
    type: entry.type,
    actorUserId: entry.actorUserId,
    actorName: entry.actorName,
    entityType: entry.entityType,
    entityId: entry.entityId,
    entityLabel: entry.entityLabel,
    message: entry.message,
    readAt: entry.readAt,
    createdAt: entry.createdAt,
  };
}

export function toSavedSearchDto(saved: SavedSearchRecord) {
  return {
    id: saved.id,
    name: saved.name,
    criteria: saved.criteria,
    isPinned: saved.isPinned,
    lastRunAt: saved.lastRunAt,
    runCount: saved.runCount,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}

export function toProjectDto(project: ProjectRecord) {
  return {
    id: project.id,
    name: project.name,
    code: project.code,
    description: project.description,
    departmentId: project.departmentId,
    leadUserId: project.leadUserId,
    memberUserIds: project.memberUserIds,
    rootFolderId: project.rootFolderId,
    status: project.status,
    confidentiality: project.confidentiality,
    startDate: project.startDate,
    targetEndDate: project.targetEndDate,
    completedAt: project.completedAt,
    tags: project.tags,
    storageUsedBytes: project.storageUsedBytes,
    fileCount: project.fileCount,
    createdAt: project.createdAt,
  };
}

export function toExperimentDto(experiment: ExperimentView) {
  return {
    id: experiment.id,
    projectId: experiment.projectId,
    projectCode: experiment.projectCode,
    projectName: experiment.projectName,
    departmentId: experiment.departmentId,
    code: experiment.code,
    title: experiment.title,
    objective: experiment.objective,
    status: experiment.status,
    outcome: experiment.outcome,
    outcomeSummary: experiment.outcomeSummary,
    leadUserId: experiment.leadUserId,
    collaboratorUserIds: experiment.collaboratorUserIds,
    protocolRef: experiment.protocolRef,
    instrumentRef: experiment.instrumentRef,
    organism: experiment.organism,
    sampleIds: experiment.sampleIds,
    startedOn: experiment.startedOn,
    completedOn: experiment.completedOn,
    folderId: experiment.folderId,
    confidentiality: experiment.confidentiality,
    tags: experiment.tags,
    fileCount: experiment.fileCount,
    capabilities: experiment.capabilities,
    createdAt: experiment.createdAt,
    updatedAt: experiment.updatedAt,
  };
}

export function toRelatedFileDto(related: RelatedFile) {
  return { reasons: related.reasons, file: toFileDto(related.file) };
}

/**
 * An inventory item.
 *
 * `batches` is included because a store manager deciding what to hand over needs to see
 * which batch expires first, and a scientist reading the item needs to know that half the
 * stock expires next week. It carries no identifiers beyond the batch number printed on the
 * container itself.
 */
export function toInventoryItemDto(item: InventoryItemView) {
  return {
    id: item.id,
    departmentId: item.departmentId,
    departmentName: item.departmentName,
    name: item.name,
    code: item.code,
    category: item.category,
    unit: item.unit,
    description: item.description,
    availableQuantity: item.availableQuantity,
    minimumStock: item.minimumStock,
    stockState: item.stockState,
    expiryState: item.expiryState,
    batches: item.batches.map((batch) => ({
      batchNumber: batch.batchNumber,
      quantity: batch.quantity,
      expiryDate: batch.expiryDate,
      supplier: batch.supplier,
      storageLocation: batch.storageLocation,
      receivedAt: batch.receivedAt,
    })),
    batchNumber: item.batchNumber,
    expiryDate: item.expiryDate,
    storageLocation: item.storageLocation,
    supplier: item.supplier,
    status: item.status,
    documentFileIds: item.documentFileIds,
    capabilities: item.capabilities,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * A migration job.
 *
 * There is no field here for the Google refresh token, and the record this maps from does
 * not carry one either — the credential is read by exactly one function, by name, in the
 * migration service. `connected` is a boolean, which is all a client needs to know.
 */
export function toMigrationJobDto(job: MigrationJobRecord) {
  return {
    id: job.id,
    name: job.name,
    description: job.description,
    status: job.status,
    targetFolderId: job.targetFolderId,
    departmentId: job.departmentId,
    projectId: job.projectId,
    confidentiality: job.confidentiality,
    sourceFolderIds: job.sourceFolderIds,
    connection: {
      connected: job.connection.connected,
      accountEmail: job.connection.accountEmail,
      scope: job.connection.scope,
      connectedAt: job.connection.connectedAt,
    },
    options: job.options,
    counters: job.counters,
    scanStartedAt: job.scanStartedAt,
    scanCompletedAt: job.scanCompletedAt,
    importStartedAt: job.importStartedAt,
    completedAt: job.completedAt,
    lastError: job.lastError,
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function toMigrationItemDto(item: MigrationItemRecord) {
  return {
    id: item.id,
    driveFileId: item.driveFileId,
    sourcePath: item.sourcePath,
    name: item.name,
    mimeType: item.mimeType,
    declaredSize: item.declaredSize,
    isGoogleNative: item.isGoogleNative,
    status: item.status,
    targetFolderId: item.targetFolderId,
    resultFileId: item.resultFileId,
    checksumSha256: item.checksumSha256,
    importedBytes: item.importedBytes,
    duplicateOfFileId: item.duplicateOfFileId,
    attempts: item.attempts,
    lastError: item.lastError,
    driveCreatedTime: item.driveCreatedTime,
    driveModifiedTime: item.driveModifiedTime,
    importedAt: item.importedAt,
  };
}

export function toActivityDto(entry: ActivityRecord) {
  return {
    id: entry.id,
    actorUserId: entry.actorUserId,
    actorName: entry.actorName,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    entityLabel: entry.entityLabel,
    detail: entry.detail,
    createdAt: entry.createdAt,
  };
}

export function toSessionListDto(session: SessionRecord, currentSessionId: string) {
  return {
    id: session.id,
    deviceLabel: session.deviceLabel,
    ip: session.ip,
    provider: session.provider,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    isCurrent: session.id === currentSessionId,
  };
}

export function toLoginHistoryDto(entry: LoginHistoryRecord) {
  return {
    id: entry.id,
    email: entry.email,
    outcome: entry.outcome,
    provider: entry.provider,
    ip: entry.ip,
    userAgent: entry.userAgent,
    detail: entry.detail,
    createdAt: entry.createdAt,
  };
}
