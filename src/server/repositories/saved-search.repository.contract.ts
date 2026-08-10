/**
 * Saved searches — the shape both engines implement.
 *
 * A saved search stores *criteria*, never results. Results are re-run through the permission
 * filter on every open, so a saved search cannot become a stale window onto a file the owner
 * later restricted — which is exactly what caching result ids would create.
 *
 * Every mutating method is keyed on `(userId, id)` rather than on `id` alone. A saved search is
 * private, and "find by id, then check the owner" is one forgotten check away from an IDOR;
 * this shape has nowhere to forget it.
 */
export interface SavedSearchRecord {
  id: string;
  userId: string;
  name: string;
  criteria: Record<string, unknown>;
  isPinned: boolean;
  lastRunAt: Date | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertSavedSearchInput {
  organizationId: string;
  userId: string;
  name: string;
  criteria: Record<string, unknown>;
  isPinned?: boolean;
}

export interface SavedSearchRepository {
  listForUser(userId: string): Promise<SavedSearchRecord[]>;
  findOwned(userId: string, id: string): Promise<SavedSearchRecord | null>;
  /** Keyed on the case-folded name, so saving twice under one name replaces rather than piles up. */
  upsert(input: UpsertSavedSearchInput): Promise<SavedSearchRecord>;
  update(
    userId: string,
    id: string,
    changes: { name?: string; isPinned?: boolean },
  ): Promise<SavedSearchRecord | null>;
  remove(userId: string, id: string): Promise<boolean>;
  /** Fire-and-forget usage counter — never blocks returning results. */
  markRun(userId: string, id: string): Promise<void>;
}
