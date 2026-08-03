/**
 * A search a user chose to keep.
 *
 * Stores the *criteria*, never the results. Results are re-run through the permission
 * filter on every open, so a saved search cannot become a stale window onto a file the
 * owner later restricted — which is exactly what caching result ids would create.
 *
 * Saved searches are private to their owner. Sharing one would be sharing a description
 * of files the recipient may not be allowed to see, and the name a user gives a search
 * ("Q3 tox findings") can itself be sensitive.
 */
import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from '@/server/db/base-schema';

const savedSearchSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    nameLower: { type: String, required: true, maxlength: 120 },

    /**
     * The criteria, validated against the search schema before it is written. Mixed
     * because the filter set grows with the platform, but nothing is read back out of
     * here without going through `searchQuerySchema.parse()` first.
     */
    criteria: { type: Schema.Types.Mixed, required: true },

    /** Pinned searches appear in the sidebar. */
    isPinned: { type: Boolean, default: false },
    lastRunAt: { type: Date, default: null },
    runCount: { type: Number, default: 0, min: 0 },
  },
  baseSchemaOptions,
);

// One name per user — re-saving under an existing name updates it rather than
// accumulating duplicates the user has to tell apart.
savedSearchSchema.index({ userId: 1, nameLower: 1 }, { unique: true });
savedSearchSchema.index({ userId: 1, isPinned: -1, updatedAt: -1 });

export type SavedSearchDocument = InferSchemaType<typeof savedSearchSchema>;

export const SavedSearchModel: Model<SavedSearchDocument> =
  (models.SavedSearch as Model<SavedSearchDocument>) ??
  model<SavedSearchDocument>('SavedSearch', savedSearchSchema);
