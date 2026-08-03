/**
 * A review request against one specific version.
 *
 * `versionId` is required and never changes. That single decision is what makes the
 * whole approval story defensible: a reviewer signs off on an exact set of bytes with a
 * known checksum, and no later upload can retroactively become "the approved version".
 * A review request that pointed at a *file* would silently change meaning every time
 * someone uploaded, which is precisely the Google Drive failure this platform exists to
 * fix ("difficulty identifying the latest approved version").
 *
 * Decisions are embedded rather than a separate collection: they are meaningless outside
 * their request, they are bounded (a handful of reviewers), and every read of a request
 * wants them. They are append-only in practice — the service never rewrites one, and a
 * reviewer who changes their mind adds a new decision, so the history of who said what
 * and when survives.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

export const REVIEW_REQUEST_STATUSES = [
  'pending',
  'changes_requested',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type ReviewRequestStatus = (typeof REVIEW_REQUEST_STATUSES)[number];

export const REVIEW_DECISIONS = ['approve', 'reject', 'request_changes'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * The evidence captured with a decision.
 *
 * IP and user agent are recorded because §15 of the brief asks for them: an approval is
 * the closest thing this system has to a signature, and "who, from where, on what" is
 * what makes it hold up when questioned months later.
 */
const reviewDecisionSchema = new Schema(
  {
    reviewerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewerName: { type: String, required: true, maxlength: 200 },
    reviewerEmail: { type: String, required: true, maxlength: 320 },
    decision: { type: String, enum: REVIEW_DECISIONS, required: true },
    comment: { type: String, default: '', maxlength: 2000 },
    decidedAt: { type: Date, default: Date.now },
    ip: { type: String, default: 'unknown', maxlength: 64 },
    userAgent: { type: String, default: 'unknown', maxlength: 512 },
    requestId: { type: String, default: null, maxlength: 64 },
  },
  { _id: false },
);

const reviewSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },

    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true },
    /** Immutable. The exact bytes under review. */
    versionId: { type: Schema.Types.ObjectId, ref: 'FileVersion', required: true },
    versionNumber: { type: Number, required: true, min: 1 },
    /** Denormalized so the pending-review dashboard renders without a join. */
    fileName: { type: String, required: true, maxlength: 300 },
    /** Copied at request time so a decision can be checked against the bytes it signed. */
    versionChecksum: { type: String, required: true, maxlength: 64 },

    /**
     * The remote content state at the moment the review was raised.
     *
     * `versionChecksum` above is sufficient for a locally-stored version, because such an
     * object is immutable — the bytes cannot change under the reviewer. Content in Google
     * Drive has no such property: a Doc can be edited between "please review this" and "I
     * approve", and the checksum in this document would still match, because it describes
     * the version *record*, not what Drive currently holds.
     *
     * Null for every local version and every review raised before Phase 8, and a null is
     * read as "nothing remote to check" rather than as a mismatch — so existing approvals
     * remain valid and no backfill is needed.
     */
    versionRevisionId: { type: String, default: null, maxlength: 200 },
    versionContentModifiedAt: { type: Date, default: null },

    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByName: { type: String, required: true, maxlength: 200 },
    requestNote: { type: String, default: '', maxlength: 2000 },

    reviewerUserIds: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
    /**
     * How many approvals close the request. Defaults to 1; a study that needs two
     * signatures sets 2 and the request stays open until both arrive.
     */
    requiredApprovals: { type: Number, default: 1, min: 1, max: 10 },

    status: { type: String, enum: REVIEW_REQUEST_STATUSES, default: 'pending' },
    decisions: { type: [reviewDecisionSchema], default: [] },

    dueAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },

    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
  },
  baseSchemaOptions,
);

// The pending-review dashboard: "what is waiting on me".
reviewSchema.index({ reviewerUserIds: 1, status: 1, createdAt: -1 });
reviewSchema.index({ fileId: 1, createdAt: -1 });
reviewSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ requestedBy: 1, status: 1, createdAt: -1 });
// One open request per version — a second would let two reviewers approve the same bytes
// through different requests and produce two conflicting histories.
reviewSchema.index(
  { versionId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

export type ReviewDocument = InferSchemaType<typeof reviewSchema>;

export const ReviewModel: Model<ReviewDocument> =
  (models.Review as Model<ReviewDocument>) ?? model<ReviewDocument>('Review', reviewSchema);
