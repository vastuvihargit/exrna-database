/**
 * "Recent" — the shape both engines implement.
 *
 * Like stars, every method is scoped to a `userId` and the repository decides no visibility of
 * its own: `listForUser` returns ids and the file and folder services put them straight back
 * through their permission-aware `findByIds`. Opening a file and later losing access to it
 * removes it from Recent on the next read.
 *
 * The one thing worth stating explicitly is that this is a *set*, not a log. `touch()` is an
 * upsert, so a user who opens the same folder fifty times does not push everything else out of
 * their own recent list.
 */
import type { RecentEntityType } from '@/server/db/models/recent-item.model';

export type { RecentEntityType };

export interface RecentRef {
  entityType: RecentEntityType;
  entityId: string;
  lastAction: string;
  lastAccessedAt: Date;
}

export interface TouchRecentInput {
  userId: string;
  organizationId: string;
  entityType: RecentEntityType;
  entityId: string;
  /** `opened` | `edited` | `uploaded`. Defaults to `opened`. */
  action?: string;
}

export interface RecentItemRepository {
  touch(input: TouchRecentInput): Promise<void>;
  listForUser(
    userId: string,
    options?: { entityType?: RecentEntityType; limit?: number },
  ): Promise<RecentRef[]>;
  removeAllFor(entityType: RecentEntityType, entityIds: string[]): Promise<void>;
}
