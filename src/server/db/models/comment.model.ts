/**
 * A comment on a file.
 *
 * Threading is one level deep by design: a comment either starts a thread or replies to
 * one. Arbitrary nesting produces conversations nobody can follow in a side panel, and
 * makes "show me the unresolved threads on this file" a recursive query instead of a
 * grouped one.
 *
 * `resolvedAt` exists because a review comment that has been acted on should stop
 * demanding attention without being deleted — the record of what was raised, and that it
 * was addressed, is part of the file's history.
 *
 * Comments never touch file data. They are a separate collection with no write path into
 * `File` or `FileVersion`, so a commenter can never alter what they are commenting on.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { applySoftDeleteFilter, baseSchemaOptions, softDeleteFields } from '@/server/db/base-schema';

const commentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true },

    /**
     * The version this comment was written against.
     *
     * Recorded so a comment on version 3 does not silently appear to be about version 7.
     * "Which version was this objection about?" is a question a reviewer will ask.
     */
    versionId: { type: Schema.Types.ObjectId, ref: 'FileVersion', default: null },
    versionNumber: { type: Number, default: null },

    /** null for a top-level comment; the thread root for a reply. One level only. */
    parentCommentId: { type: Schema.Types.ObjectId, ref: 'Comment', default: null },

    authorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, required: true, maxlength: 200 },

    body: { type: String, required: true, maxlength: 5000 },
    /** Resolved user ids for @mentions, validated against the directory before insert. */
    mentionedUserIds: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },

    /** Set when the comment was written as part of a review decision. */
    isReviewComment: { type: Boolean, default: false },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    editedAt: { type: Date, default: null },

    ...softDeleteFields,
  },
  baseSchemaOptions,
);

applySoftDeleteFilter(commentSchema);

commentSchema.index({ fileId: 1, parentCommentId: 1, createdAt: 1 });
commentSchema.index({ fileId: 1, resolvedAt: 1, createdAt: -1 });
commentSchema.index({ mentionedUserIds: 1, createdAt: -1 });
commentSchema.index({ authorUserId: 1, createdAt: -1 });

export type CommentDocument = InferSchemaType<typeof commentSchema>;

export const CommentModel: Model<CommentDocument> =
  (models.Comment as Model<CommentDocument>) ?? model<CommentDocument>('Comment', commentSchema);
