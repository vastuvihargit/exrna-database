/**
 * Stars — the shape both engines implement.
 *
 * A star is private to the person who set it, which is what makes this module simpler than it
 * looks: there is no ACL here and there must never be one. Every method is already scoped to a
 * `userId`, so the only rows any call can reach belong to the caller.
 *
 * That is also why the star repository **never decides visibility**. `listForUser` returns ids,
 * and the file and folder services immediately put those ids back through their own
 * permission-aware `findByIds`. Access revoked after something was starred therefore removes it
 * from the Starred page on the next read — a star cannot hold a door open. Anything that
 * short-circuited that round trip would turn a private bookmark into a capability.
 */
import type { StarrableType } from '@/server/db/models/star.model';

export type { StarrableType };

export interface StarRef {
  entityType: StarrableType;
  entityId: string;
  createdAt: Date;
}

export interface AddStarInput {
  userId: string;
  organizationId: string;
  entityType: StarrableType;
  entityId: string;
}

export interface RemoveStarInput {
  userId: string;
  entityType: StarrableType;
  entityId: string;
}

export interface StarRepository {
  /** Idempotent: starring an already-starred item is a no-op, not a second row. */
  add(input: AddStarInput): Promise<void>;
  remove(input: RemoveStarInput): Promise<void>;
  /**
   * Which of these ids the viewer has starred.
   *
   * A Set so a listing can annotate hundreds of rows without a query each.
   */
  starredIdsAmong(
    userId: string,
    entityType: StarrableType,
    entityIds: string[],
  ): Promise<Set<string>>;
  listForUser(
    userId: string,
    options?: { entityType?: StarrableType; limit?: number },
  ): Promise<StarRef[]>;
  /** Called when an item is purged, so stars do not point at nothing. */
  removeAllFor(entityType: StarrableType, entityIds: string[]): Promise<void>;
}
