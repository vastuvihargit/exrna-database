/**
 * Keeping an approval honest when the content it approved lives somewhere we do not control.
 *
 * ── The problem this exists for ────────────────────────────────────────────────────────
 *
 * Every approval in this system is pinned to a version, and a version's bytes are immutable.
 * That was a complete guarantee for exactly as long as the bytes were on our own disk under
 * a key nothing rewrites. It stopped being complete the moment content moved into a Shared
 * Drive, because a Google Doc can be rewritten by anyone who can open it, and neither the
 * version record nor its `checksumSha256` changes when that happens. The approval would go
 * on saying "approved" over content nobody approved.
 *
 * §11 of the brief is unambiguous about the required behaviour: *do not silently keep the
 * old approval status*. So this module does three things and deliberately nothing else.
 *
 *   1. **Bind.** When an approval closes, record the exact remote revision it was granted
 *      against (`review.service` calls `bindApproval`).
 *   2. **Check.** Ask Drive what the current revision is and compare.
 *   3. **Return to review.** On a mismatch, the file goes back to `changes_requested`, the
 *      owner and the approver are told in plain language, and an audit entry is written.
 *
 * ── What is never done ────────────────────────────────────────────────────────────────
 *
 * The approval record is never deleted, never rewritten, and the version's `approvedBy` and
 * `approvedAt` are left exactly as they were. "Nobody approved this any more" and "this was
 * approved by Priya on the 3rd, and the document has since changed" are different claims,
 * and only the second one is true. `approvalSupersededAt` records the second.
 *
 * `isApproved` *is* cleared, because it is what the badge and the approved-files list read,
 * and a document whose content has changed must not appear in either. The history lives in
 * the Review documents and the audit log, which this never touches.
 *
 * ── Local versions are not checked, and that is not an omission ───────────────────────
 *
 * A locally-stored version is already pinned by a checksum over bytes that cannot change.
 * There is nothing to poll and nothing that could have drifted. Every function here treats a
 * local version as `unbound` and does no work — which is why enabling this on a deployment
 * part-way through migration costs nothing for the files that have not moved yet.
 */
import { withTransaction } from '@/server/db/connection';
import { getLogger } from '@/server/logging/logger';
import { auditService } from '@/server/audit/audit.service';
import * as fileRepository from '@/server/repositories/file.repository';
import * as notificationRepository from '@/server/repositories/notification.repository';
import * as versionRepository from '@/server/repositories/file-version.repository';
import type { VersionApprovalBinding } from '@/server/repositories/file-version.repository';
import { getObjectStore } from '@/server/storage';
import { isDriveStorageEnabled } from '@/server/storage/google';
import type {
  DriveContentFingerprint,
  GoogleDriveObjectStore,
} from '@/server/storage/google/google-drive-object-store';
import { isMissingObjectError } from '@/server/storage/missing-object';

/**
 * What a check concluded.
 *
 * `unavailable` is a distinct outcome from `unchanged` on purpose, and it is the one that
 * carries the risk: "Drive did not answer" must never be recorded as "the document is fine".
 * A sweep counts them separately and an administrator sees the count.
 */
export type ApprovalCheckOutcome =
  | 'unbound'
  | 'unchanged'
  | 'superseded'
  | 'unavailable'
  | 'missing';

export interface ApprovalCheckResult {
  versionId: string;
  fileId: string;
  outcome: ApprovalCheckOutcome;
  /** A plain sentence when something was wrong. Safe to show an employee. */
  detail?: string;
}

/**
 * The remote content identity, or null when there is nothing remote to read.
 *
 * Returns null rather than throwing for the two ordinary "not applicable" cases — a local
 * version, and a deployment with Drive switched off — because both are normal states during
 * migration and callers would otherwise all need the same two guards.
 */
export async function readRemoteFingerprint(
  location: { provider: string; externalId?: string; key: string; area: string },
): Promise<DriveContentFingerprint | null> {
  if (location.provider !== 'google_drive' || !location.externalId) return null;
  if (!isDriveStorageEnabled()) return null;

  const store = getObjectStore('google_drive') as GoogleDriveObjectStore;
  return store.contentFingerprint({
    provider: 'google_drive',
    key: location.key,
    area: location.area as never,
    externalId: location.externalId,
  });
}

/**
 * Reads the current remote state of a version, for `review.service` to pin to a request.
 *
 * Failure is deliberately not fatal: a Drive hiccup must not stop somebody submitting work
 * for review. The consequence of returning null is that this particular review is pinned by
 * checksum alone — the pre-Phase-8 behaviour — which is weaker but not wrong, and the sweep
 * still covers the file once it is approved.
 */
export async function fingerprintForReview(versionId: string): Promise<{
  revisionId: string | null;
  contentModifiedAt: Date | null;
}> {
  const empty = { revisionId: null, contentModifiedAt: null };

  try {
    const location = await versionRepository.getStorageLocation(versionId);
    if (!location) return empty;

    const fingerprint = await readRemoteFingerprint(location);
    if (!fingerprint) return empty;

    return { revisionId: fingerprint.revisionId, contentModifiedAt: fingerprint.modifiedAt };
  } catch (error) {
    getLogger().warn(
      { versionId, err: error },
      'Could not read the Shared Drive revision when raising a review',
    );
    return empty;
  }
}

/**
 * Records what an approval was granted against.
 *
 * Called inside the approval transaction. A failure to read the revision must not abort an
 * approval a human just gave, so the read happens *before* the transaction and this only
 * writes what it was handed.
 */
export function approvalBindingUpdate(fingerprint: {
  revisionId: string | null;
  contentModifiedAt: Date | null;
}): Record<string, unknown> {
  return {
    approvedRevisionId: fingerprint.revisionId,
    approvedContentModifiedAt: fingerprint.contentModifiedAt,
    // A fresh approval is by definition not superseded. Set explicitly rather than left
    // alone, because a file can be approved, superseded, corrected and approved again, and
    // the stale marker from the first round must not survive into the second.
    approvalSupersededAt: null,
    approvalSupersededReason: null,
  };
}

/**
 * Has the content under this approval changed?
 *
 * Reads only, except for the one write that is the entire point: marking a superseded
 * approval. It never repairs, re-uploads, deletes or re-approves anything.
 */
export async function checkApprovedVersion(versionId: string): Promise<ApprovalCheckResult> {
  const binding = await versionRepository.getApprovalBinding(versionId);
  if (!binding) return { versionId, fileId: '', outcome: 'unbound' };

  return checkBinding(binding);
}

async function checkBinding(binding: VersionApprovalBinding): Promise<ApprovalCheckResult> {
  const { versionId, fileId } = binding;

  if (!binding.isApproved || binding.approvalSupersededAt) {
    return { versionId, fileId, outcome: 'unbound' };
  }

  const location = await versionRepository.getStorageLocation(versionId);
  if (!location || location.provider !== 'google_drive') {
    // Local content, pinned by an immutable checksum. Nothing can have drifted.
    return { versionId, fileId, outcome: 'unbound' };
  }

  let current: DriveContentFingerprint | null;
  try {
    current = await readRemoteFingerprint(location);
  } catch (error) {
    if (isMissingObjectError(error)) {
      // §16: never silently drop the record. The approval is not invalidated either — the
      // content did not change, it became unreachable, and those need different responses.
      await versionRepository.markStorageConflict(
        versionId,
        'The approved document could not be found in Google Drive',
      );
      return {
        versionId,
        fileId,
        outcome: 'missing',
        detail: 'The approved document could not be found in the company Shared Drive.',
      };
    }

    getLogger().warn(
      { versionId, fileId, err: error },
      'Could not read the Shared Drive revision for an approved version',
    );
    return { versionId, fileId, outcome: 'unavailable' };
  }

  if (!current) return { versionId, fileId, outcome: 'unbound' };

  /**
   * An approval granted before Phase 8, or one whose revision could not be read at the
   * time, has nothing to compare against. Adopting the current revision as the binding is
   * the only safe move: inventing a mismatch would send every historic approval back to
   * review over a change that never happened, and treating it as a *match* forever would
   * leave it permanently unwatched.
   */
  if (!binding.approvedRevisionId) {
    await versionRepository.updateFlags(versionId, {
      $set: {
        approvedRevisionId: current.revisionId,
        approvedContentModifiedAt: current.modifiedAt,
        googleDriveRevisionId: current.revisionId,
        googleDriveModifiedTime: current.modifiedAt,
      },
    });
    return { versionId, fileId, outcome: 'unchanged' };
  }

  if (current.revisionId === binding.approvedRevisionId) {
    return { versionId, fileId, outcome: 'unchanged' };
  }

  await supersedeApproval({
    binding,
    current,
    reason: 'The document was changed in the company Shared Drive after it was approved.',
  });

  return {
    versionId,
    fileId,
    outcome: 'superseded',
    detail: 'The document changed after it was approved and needs reviewing again.',
  };
}

/**
 * The transition: an approved file goes back to needing review.
 *
 * Version and file are written in one transaction. A half-applied transition — a version
 * marked superseded while the file still shows an approved badge, or the reverse — is worse
 * than either end state, because nothing later would notice the disagreement.
 */
async function supersedeApproval(input: {
  binding: VersionApprovalBinding;
  current: DriveContentFingerprint;
  reason: string;
}): Promise<void> {
  const { binding, current, reason } = input;

  const file = await fileRepository.findById(binding.fileId, { includeDeleted: true });
  if (!file) {
    getLogger().warn(
      { versionId: binding.versionId, fileId: binding.fileId },
      'An approved version has no file record; skipping the approval transition',
    );
    return;
  }

  await withTransaction(async (session) => {
    await versionRepository.updateFlags(
      binding.versionId,
      {
        $set: {
          // Cleared because this is what the badge and the approved-files list read.
          // `approvedBy` and `approvedAt` stay: who signed, and when, remains true.
          isApproved: false,
          label: 'changes_requested',
          approvalSupersededAt: new Date(),
          approvalSupersededReason: reason.slice(0, 300),
          // The version now tracks the content that is actually there.
          googleDriveRevisionId: current.revisionId,
          googleDriveModifiedTime: current.modifiedAt,
          ...(current.md5 ? { googleDriveMd5: current.md5 } : {}),
        },
      },
      session,
    );

    // Only clears the approval if this version is still the one holding it. A newer version
    // may have been approved since, and returning *that* to review because an older one
    // drifted would be wrong.
    await fileRepository.updateByIdWhere(
      binding.fileId,
      { approvedVersionId: binding.versionId },
      {
        $set: {
          reviewStatus: 'changes_requested',
          approvalStatus: 'none',
          approvedVersionId: null,
        },
      },
      session,
    );
  });

  await auditService.recordSystem({
    action: 'file.approval_invalidated',
    organizationId: file.organizationId,
    actorLabel: 'approval-integrity',
    entityType: 'file',
    entityId: binding.fileId,
    entityLabel: file.displayName,
    previousValue: {
      approvalStatus: 'approved',
      approvedVersionId: binding.versionId,
      approvedAt: binding.approvedAt,
      approvedBy: binding.approvedBy,
      approvedRevisionId: binding.approvedRevisionId,
    },
    newValue: {
      approvalStatus: 'none',
      reviewStatus: 'changes_requested',
      versionNumber: binding.versionNumber,
      currentRevisionId: current.revisionId,
      contentModifiedAt: current.modifiedAt,
    },
    reason,
    severity: 'warning',
  });

  const message = `"${file.displayName}" changed after it was approved and needs reviewing again`;

  // The owner always, and the person who approved it when that is somebody else — they
  // signed it, so they are the one whose signature no longer covers what is there.
  const recipients = new Set([file.ownerId, ...(binding.approvedBy ? [binding.approvedBy] : [])]);

  // Awaited, unlike the fire-and-forget notifications elsewhere in this codebase. Those are
  // detached to keep a person's request fast; nobody is waiting on this one, and telling the
  // owner their approval no longer holds is the point of the whole exercise rather than a
  // nicety that can be dropped if the process ends first.
  await notificationRepository
    .createMany(
      [...recipients].map((userId) => ({
        organizationId: file.organizationId,
        userId,
        type: 'review.reopened' as const,
        entityType: 'file',
        entityId: binding.fileId,
        entityLabel: file.displayName,
        message,
      })),
    )
    .catch(() => undefined);

  /**
   * Deliberately no activity-feed entry.
   *
   * The feed answers "who did what", and its `actorUserId` is a required reference to a real
   * person. Nobody did this: a document changed and a sweep noticed. Attributing it to a
   * synthetic user would put a fictional person in the one view colleagues read to find out
   * who touched their work. The audit log carries it — with `system:approval-integrity` as
   * the actor, which is the truth — and the two people it affects are notified directly.
   */
  getLogger().warn(
    {
      fileId: binding.fileId,
      versionId: binding.versionId,
      versionNumber: binding.versionNumber,
    },
    'An approved document changed in the Shared Drive and has been returned to review',
  );
}

export interface ApprovalSweepSummary {
  checked: number;
  unchanged: number;
  superseded: number;
  unavailable: number;
  missing: number;
  /** Where the next run should resume. Null when the corpus was walked to the end. */
  nextCursor: string | null;
}

/**
 * Walks the live approvals whose content lives in Drive.
 *
 * Bounded by `limit` and resumable by cursor rather than run-to-completion, because this is
 * one Drive call per approval and a large corpus would otherwise be a single unbounded burst
 * against a quota shared with uploads and downloads — the two things employees are actually
 * waiting on.
 *
 * One failing file never stops the sweep. A Drive outage during a run shows up as a
 * non-zero `unavailable` count and nothing else; those rows keep their approval and are
 * checked again next time, which is the correct behaviour for "we could not tell".
 */
export async function sweepRemoteApprovals(input: {
  limit?: number;
  cursor?: string | null;
} = {}): Promise<ApprovalSweepSummary> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));

  const summary: ApprovalSweepSummary = {
    checked: 0,
    unchanged: 0,
    superseded: 0,
    unavailable: 0,
    missing: 0,
    nextCursor: null,
  };

  if (!isDriveStorageEnabled()) return summary;

  const bindings = await versionRepository.listLiveRemoteApprovals({
    limit,
    afterId: input.cursor ?? null,
  });

  for (const binding of bindings) {
    summary.checked += 1;
    try {
      const result = await checkBinding(binding);
      if (result.outcome === 'superseded') summary.superseded += 1;
      else if (result.outcome === 'unavailable') summary.unavailable += 1;
      else if (result.outcome === 'missing') summary.missing += 1;
      else summary.unchanged += 1;
    } catch (error) {
      // Counted as unavailable rather than swallowed silently: the row was not checked, and
      // a summary that said otherwise would be the one misleading number in this report.
      summary.unavailable += 1;
      getLogger().error(
        { versionId: binding.versionId, fileId: binding.fileId, err: error },
        'Approval integrity check failed for a version',
      );
    }
  }

  // A short page means the end of the corpus; a full one means there is probably more.
  summary.nextCursor =
    bindings.length === limit ? (bindings[bindings.length - 1]?.versionId ?? null) : null;

  return summary;
}

export const approvalIntegrityService = {
  fingerprintForReview,
  approvalBindingUpdate,
  checkApprovedVersion,
  sweepRemoteApprovals,
};
