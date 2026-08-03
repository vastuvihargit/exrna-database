'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2,
  Download,
  FlaskConical,
  FolderOpen,
  HardDrive,
  RotateCcw,
  Share2,
  ShieldAlert,
  ShieldCheck,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { ApiError } from '@/lib/api-client';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { useFileVersions, useRestoreVersion, type FileDto } from '@/hooks/use-files';
import { useFileReviews } from '@/hooks/use-reviews';
import { SubmitReviewDialog } from '@/components/review/submit-review-dialog';
import { FileComments } from './file-comments';
import { FileIcon } from './file-icon';
import { FileMetadataEditor } from './file-metadata-editor';
import { RelatedFiles } from './related-files';
import { ShareDialog } from './share-dialog';

const CONFIDENTIALITY_LABEL: Record<string, string> = {
  public_internal: 'Public (internal)',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

const REVIEW_LABEL: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Under review',
  changes_requested: 'Changes requested',
  reviewed: 'Reviewed',
};

const APPROVAL_LABEL: Record<string, string> = {
  none: 'Not submitted',
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function FileDetailsPanel({
  file,
  onOpenChange,
}: {
  file: FileDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const versions = useFileVersions(file?.id ?? null);
  const restore = useRestoreVersion();
  const reviews = useFileReviews(file?.id ?? null);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);

  // At most one: an approval is granted to a single version, and it is cleared when a new
  // one is approved. `find` rather than a filter for that reason.
  const supersededVersion = versions.data?.find((version) => version.approvalSupersededAt);

  return (
    <Sheet open={file !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {file ? (
          <>
            <div className="space-y-1.5 pr-8">
              <SheetTitle className="flex min-w-0 items-center gap-2">
                <FileIcon category={file.category} className="size-4" />
                <span className="truncate">{file.displayName}</span>
              </SheetTitle>
              <SheetDescription>
                {formatBytes(file.sizeBytes)} · uploaded as {file.originalFilename}
              </SheetDescription>
            </div>

            <div className="mt-6 space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <DriveBadge driveType={file.driveType} />
                <Badge variant={file.confidentiality === 'restricted' ? 'destructive' : 'secondary'}>
                  {CONFIDENTIALITY_LABEL[file.confidentiality] ?? file.confidentiality}
                </Badge>
                {file.approvalStatus === 'approved' ? (
                  <Badge className="bg-emerald-600 hover:bg-emerald-600">Approved</Badge>
                ) : null}
                {file.status !== 'active' ? <Badge variant="outline">{file.status}</Badge> : null}
              </div>

              {file.approvalStatus === 'approved' ? (
                <p className="flex items-start gap-2 rounded-md border border-emerald-600/40 bg-emerald-600/10 p-3 text-xs">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  This file is approved and read-only. To change it, upload a new version — the
                  approved version stays available and keeps its approval record.
                </p>
              ) : null}

              {/* An approval that stopped holding. Deliberately worded as a fact plus the
                  next action, with no mention of Drive, revisions or storage — the employee
                  needs to know the sign-off no longer covers the document and that it needs
                  reviewing again, and none of the machinery helps them do that. */}
              {supersededVersion ? (
                <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {supersededVersion.approvalSupersededReason ??
                    'This document changed after it was approved.'}{' '}
                  It needs reviewing again — the earlier approval is kept in the file&apos;s
                  history.
                </p>
              ) : null}

              {!file.inheritPermissions ? (
                <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  This file has its own access rules and does not inherit them from its folder.
                </p>
              ) : null}

              <Separator />

              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Detail label="Type" value={`.${file.extension}`} />
                <Detail label="Size" value={formatBytes(file.sizeBytes)} />
                <Detail label="Versions" value={String(file.versionCount)} />
                <Detail label="Downloads" value={String(file.downloadCount)} />
                <Detail label="Review" value={REVIEW_LABEL[file.reviewStatus] ?? file.reviewStatus} />
                <Detail
                  label="Approval"
                  value={APPROVAL_LABEL[file.approvalStatus] ?? file.approvalStatus}
                />
                <Detail label="Uploaded" value={formatRelativeTime(file.createdAt)} />
                <Detail label="Modified" value={formatRelativeTime(file.updatedAt)} />
              </dl>

              <div className="grid grid-cols-2 gap-2">
                {/* Search, Starred, Recent and Shared all reach a file without ever showing
                    where it lives. This is the way back to its folder — and, often, to the
                    rest of the run it belongs to. */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    router.push(`/drive/${file.folderId}`);
                  }}
                >
                  <FolderOpen className="mr-2 size-3.5" aria-hidden="true" />
                  Open folder
                </Button>

                {file.capabilities.canShare || file.capabilities.canManageAccess ? (
                  <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
                    <Share2 className="mr-2 size-3.5" aria-hidden="true" />
                    Share
                  </Button>
                ) : null}

                {file.capabilities.canSubmitForReview ? (
                  <Button variant="outline" size="sm" onClick={() => setReviewOpen(true)}>
                    <ShieldCheck className="mr-2 size-3.5" aria-hidden="true" />
                    Submit for review
                  </Button>
                ) : null}

                {/* Google Docs, Sheets and Slides open in Google's own editor, because there
                    is nothing else that can render one. The link is resolved server-side
                    behind a permission check — this only ever points at our own route. */}
                {file.opensInGoogleEditor && file.capabilities.canDownload ? (
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href={`/api/files/${file.id}/open`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <SquareArrowOutUpRight className="mr-2 size-3.5" aria-hidden="true" />
                      Open in Google
                    </a>
                  </Button>
                ) : null}
              </div>

              {reviews.data && reviews.data.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-sm font-medium">Approval history</h3>
                  <ol className="space-y-2">
                    {reviews.data.map((review) => (
                      <li key={review.id} className="rounded-md border p-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Version {review.versionNumber}</span>
                          <Badge
                            variant={
                              review.status === 'approved'
                                ? 'default'
                                : review.status === 'rejected'
                                  ? 'destructive'
                                  : 'outline'
                            }
                            className={
                              review.status === 'approved'
                                ? 'bg-emerald-600 text-[10px] hover:bg-emerald-600'
                                : 'text-[10px]'
                            }
                          >
                            {review.status.replace('_', ' ')}
                          </Badge>
                        </div>
                        <p className="mt-1 text-muted-foreground">
                          requested by {review.requestedByName} ·{' '}
                          {formatRelativeTime(review.createdAt)}
                        </p>
                        {review.decisions.map((decision, index) => (
                          <p key={index} className="mt-1">
                            <span className="font-medium">{decision.reviewerName}</span>{' '}
                            {decision.decision.replace('_', ' ')}
                            {decision.comment ? ` — ${decision.comment}` : ''}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              <Separator />

              <div>
                <h3 className="mb-2 text-sm font-medium">Research metadata</h3>
                <FileMetadataEditor file={file} />
              </div>

              <Separator />

              <RelatedFiles file={file} />

              <Separator />

              <FileComments file={file} />

              <Separator />

              <div>
                <p className="text-xs text-muted-foreground">Checksum (SHA-256)</p>
                {/* Shown so a researcher can verify a download byte-for-byte against the
                    record — the reason the server measures it while streaming. */}
                <code className="mt-1 block break-all rounded bg-muted px-2 py-1.5 text-xs">
                  {file.checksumSha256}
                </code>
              </div>

              <Separator />

              <div>
                <h3 className="mb-2 text-sm font-medium">Version history</h3>
                {versions.isLoading ? (
                  <p className="text-xs text-muted-foreground">Loading versions…</p>
                ) : versions.data && versions.data.length > 0 ? (
                  <ol className="space-y-3">
                    {versions.data.map((version) => (
                      <li key={version.id} className="rounded-md border p-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Version {version.versionNumber}</span>
                          {version.isCurrent ? (
                            <Badge variant="secondary" className="text-[10px]">
                              Current
                            </Badge>
                          ) : null}
                          {version.isApproved ? (
                            <Badge className="bg-emerald-600 text-[10px] hover:bg-emerald-600">
                              Approved
                            </Badge>
                          ) : null}
                          {/* Not "Approved" — the approval is in the history, not on this
                              version any more, and a badge saying otherwise is exactly the
                              silence §11 of the brief forbids. */}
                          {version.approvalSupersededAt ? (
                            <Badge variant="outline" className="text-[10px]">
                              Needs review again
                            </Badge>
                          ) : null}
                          {file.capabilities.canDownload ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="ml-auto size-6"
                              asChild
                              aria-label={`Download version ${version.versionNumber}`}
                            >
                              <a
                                href={`/api/files/${file.id}/download?versionId=${version.id}`}
                                download
                              >
                                <Download className="size-3.5" aria-hidden="true" />
                              </a>
                            </Button>
                          ) : null}
                        </div>
                        <p className="mt-1 text-muted-foreground">
                          {formatBytes(version.fileSize)} · {formatRelativeTime(version.uploadedAt)}
                        </p>
                        {version.versionNote ? <p className="mt-1">{version.versionNote}</p> : null}

                        {/* Restoring appends a new version rather than rewinding to this
                            one — the wording says so, because "restore" usually implies
                            the opposite and the difference matters for an audit. */}
                        {!version.isCurrent && file.capabilities.canUploadVersion ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-2 h-7 text-xs"
                            disabled={restore.isPending}
                            onClick={async () => {
                              try {
                                const created = await restore.mutateAsync({
                                  fileId: file.id,
                                  versionId: version.id,
                                });
                                toast.success(
                                  `Version ${version.versionNumber} restored as version ${created.versionNumber}`,
                                  {
                                    description:
                                      'Nothing was overwritten — every earlier version is still in the history.',
                                  },
                                );
                              } catch (error) {
                                toast.error(
                                  error instanceof ApiError
                                    ? error.message
                                    : 'Could not restore that version',
                                );
                              }
                            }}
                          >
                            <RotateCcw className="mr-1.5 size-3" aria-hidden="true" />
                            Restore as new version
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-xs text-muted-foreground">No versions recorded.</p>
                )}
              </div>
            </div>
            <ShareDialog
              targetType="file"
              targetId={file.id}
              targetName={file.displayName}
              open={shareOpen}
              onOpenChange={setShareOpen}
            />

            <SubmitReviewDialog file={file} open={reviewOpen} onOpenChange={setReviewOpen} />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function DriveBadge({ driveType }: { driveType: string }) {
  const Icon =
    driveType === 'department' ? Building2 : driveType === 'project' ? FlaskConical : HardDrive;
  const label =
    driveType === 'department'
      ? 'Department drive'
      : driveType === 'project'
        ? 'Project drive'
        : 'My Drive';
  return (
    <Badge variant="secondary" className="gap-1">
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}
