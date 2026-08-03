/**
 * Keeping the Shared Drive's copy of the tree in step with the application's.
 *
 * ── The ordering rule ──────────────────────────────────────────────────────────────────
 *
 * **Drive first, then MongoDB, and undo Drive if MongoDB fails.**
 *
 * The alternative — commit locally and mirror afterwards — produces a record that says a
 * file was renamed, moved or trashed while the Shared Drive still shows the old state, and
 * nothing in the system knows the two disagree. Doing Drive first means a Drive failure
 * happens *before* anything local has changed: both sides are still at the original state
 * and the user gets a plain "that did not work", which is the truth.
 *
 * The remaining window is small and handled: Drive succeeded, MongoDB then failed. The
 * compensating Drive call puts it back. If the compensation *also* fails, that is logged
 * loudly and left for Phase 9's reconciliation — but the local state is unchanged either
 * way, so nothing an employee sees is wrong.
 *
 * ── What is mirrored, and what is not ──────────────────────────────────────────────────
 *
 * A **folder** operation is one Drive call, because Drive cascades: moving or trashing a
 * mirrored folder carries its contents. A **file** operation touches one Drive object per
 * migrated version, because each version is a separate object.
 *
 * Creating a folder is deliberately *not* mirrored — decision D7 keeps folder mirroring
 * lazy, so a Drive folder appears the first time content needs to land in it. Making
 * `POST /api/folders` wait on a remote call would turn a fast transactional write into a
 * distributed one, and would fill the Shared Drive's item budget with empty folders.
 */
import { Types } from 'mongoose';

import { connectToDatabase } from '@/server/db/connection';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { FolderModel } from '@/server/db/models/folder.model';
import { getEnv } from '@/server/config/env';
import { ServiceUnavailableError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';
import { storageRegistry } from '@/server/storage';
import { isDriveStorageEnabled } from '@/server/storage/google';
import type { HierarchicalStorageProvider } from '@/server/storage/types';
import { ensureDriveFolderPath } from './folder-mirror';

/**
 * The Drive hierarchy, or `null` when this deployment does not mirror at all.
 *
 * Null is the normal answer on a deployment that has not enabled Drive, and every caller
 * treats it as "there is nothing to keep in step" rather than as an error — which is what
 * lets all of this be threaded through the mutation services without a flag at each site.
 */
export function driveHierarchy(): HierarchicalStorageProvider | null {
  if (!isDriveStorageEnabled()) return null;
  if (!storageRegistry.has('google_drive')) return null;
  try {
    return storageRegistry.hierarchy('google_drive');
  } catch {
    return null;
  }
}

/** Every Drive object belonging to a file — one per migrated version. */
export async function driveObjectsForFile(fileId: string): Promise<string[]> {
  await connectToDatabase();
  const versions = await FileVersionModel.find({
    fileId: new Types.ObjectId(fileId),
    googleDriveFileId: { $type: 'string' },
  })
    .select({ googleDriveFileId: 1 })
    .lean<Array<{ googleDriveFileId: string }>>()
    .exec();

  return versions.map((version) => version.googleDriveFileId);
}

/** Every Drive object under a folder subtree. Used only where Drive cannot cascade. */
export async function driveObjectsUnderFolder(folderId: string, limit = 500): Promise<string[]> {
  await connectToDatabase();
  const { FileModel } = await import('@/server/db/models/file.model');

  const files = await FileModel.find({
    $or: [{ folderId: new Types.ObjectId(folderId) }, { folderPathAncestors: new Types.ObjectId(folderId) }],
  })
    .select({ _id: 1 })
    .setOptions({ withDeleted: true })
    .limit(limit)
    .lean<Array<{ _id: Types.ObjectId }>>()
    .exec();

  if (files.length === 0) return [];

  const versions = await FileVersionModel.find({
    fileId: { $in: files.map((file) => file._id) },
    googleDriveFileId: { $type: 'string' },
  })
    .select({ googleDriveFileId: 1 })
    .lean<Array<{ googleDriveFileId: string }>>()
    .exec();

  return versions.map((version) => version.googleDriveFileId);
}

export async function driveFolderFor(folderId: string): Promise<string | null> {
  await connectToDatabase();
  const folder = await FolderModel.findById(new Types.ObjectId(folderId))
    .select({ googleDriveFolderId: 1 })
    .setOptions({ withDeleted: true })
    .lean<{ googleDriveFolderId?: string | null }>()
    .exec();

  return folder?.googleDriveFolderId ?? null;
}

/**
 * The Drive folder a file's objects should live in, creating the path if needed.
 *
 * Returns null when nothing is mirrored yet *and* nothing needs to be — a move of a file
 * with no Drive objects has no destination to prepare.
 */
export async function ensureDriveFolder(
  folderId: string,
  hierarchy: HierarchicalStorageProvider,
): Promise<string> {
  const mirror = await ensureDriveFolderPath({ folderId, hierarchy });
  return mirror.externalId;
}

/**
 * Applies an operation to each object, undoing the ones that succeeded if a later one fails.
 *
 * Without this, renaming a three-version file where the second call fails leaves one object
 * renamed and two not — a state no later operation would ever notice or correct.
 */
async function applyToEach(
  ids: readonly string[],
  apply: (id: string) => Promise<void>,
  undo: (id: string) => Promise<void>,
): Promise<void> {
  const done: string[] = [];
  try {
    for (const id of ids) {
      await apply(id);
      done.push(id);
    }
  } catch (error) {
    for (const id of done) {
      await undo(id).catch((undoError: unknown) => {
        getLogger().error(
          { externalId: id, err: undoError },
          'Could not undo a partially applied Shared Drive change',
        );
      });
    }
    throw error;
  }
}

/**
 * Drive first, MongoDB second, Drive put back if MongoDB fails.
 *
 * `apply` and `revert` are no-ops when nothing is mirrored, which is the ordinary case on a
 * deployment part-way through migration — so this wrapper is safe to use unconditionally.
 */
export async function withDriveMirror<T>(input: {
  /** The Drive change. Runs first; a failure here means nothing local has changed. */
  apply: () => Promise<void>;
  /** Puts Drive back. Runs only if the local commit fails. */
  revert: () => Promise<void>;
  /** The MongoDB change. */
  commit: () => Promise<T>;
  /** For the log line if compensation fails. */
  describe: string;
}): Promise<T> {
  try {
    await input.apply();
  } catch (error) {
    getLogger().warn({ err: error, operation: input.describe }, 'A Shared Drive change failed');
    // Deliberately a plain, non-technical message: an employee cannot act on a Drive API
    // error, and the important part is the second sentence.
    throw new ServiceUnavailableError(
      'This could not be completed in the company Shared Drive. Nothing was changed — try again in a moment.',
    );
  }

  try {
    return await input.commit();
  } catch (error) {
    await input.revert().catch((revertError: unknown) => {
      // Both sides now disagree, and this is the one case that needs a human or Phase 9.
      // Local state is still correct, so nothing an employee sees is wrong.
      getLogger().error(
        { err: revertError, operation: input.describe },
        'A Shared Drive change could not be undone after the database write failed',
      );
    });
    throw error;
  }
}

/* --------------------------------------------------------------- named operations */

export async function mirrorRename(input: {
  hierarchy: HierarchicalStorageProvider;
  externalIds: readonly string[];
  from: string;
  to: string;
}): Promise<{ apply: () => Promise<void>; revert: () => Promise<void> }> {
  const { hierarchy, externalIds, from, to } = input;
  return {
    apply: () =>
      applyToEach(
        externalIds,
        (id) => hierarchy.renameItem(id, to),
        (id) => hierarchy.renameItem(id, from),
      ),
    revert: () =>
      applyToEach(
        externalIds,
        (id) => hierarchy.renameItem(id, from),
        () => Promise.resolve(),
      ),
  };
}

export function mirrorMove(input: {
  hierarchy: HierarchicalStorageProvider;
  externalIds: readonly string[];
  fromParent: string | null;
  toParent: string;
}): { apply: () => Promise<void>; revert: () => Promise<void> } {
  const { hierarchy, externalIds, fromParent, toParent } = input;
  return {
    apply: () =>
      applyToEach(
        externalIds,
        (id) => hierarchy.moveItem(id, toParent, fromParent ?? undefined),
        (id) => (fromParent ? hierarchy.moveItem(id, fromParent, toParent) : Promise.resolve()),
      ),
    revert: () =>
      fromParent
        ? applyToEach(
            externalIds,
            (id) => hierarchy.moveItem(id, fromParent, toParent),
            () => Promise.resolve(),
          )
        : Promise.resolve(),
  };
}

export function mirrorTrash(input: {
  hierarchy: HierarchicalStorageProvider;
  externalIds: readonly string[];
  trashed: boolean;
}): { apply: () => Promise<void>; revert: () => Promise<void> } {
  const { hierarchy, externalIds, trashed } = input;
  const forward = (id: string) => (trashed ? hierarchy.trashItem(id) : hierarchy.restoreItem(id));
  const backward = (id: string) => (trashed ? hierarchy.restoreItem(id) : hierarchy.trashItem(id));

  return {
    apply: () => applyToEach(externalIds, forward, backward),
    revert: () => applyToEach(externalIds, backward, () => Promise.resolve()),
  };
}

/** Nothing to mirror: the pair a caller uses when Drive is not in play. */
export const NO_MIRROR = {
  apply: () => Promise.resolve(),
  revert: () => Promise.resolve(),
};

/**
 * How many Drive objects one user action may touch before it is refused.
 *
 * A folder operation is one call because Drive cascades, so this only bounds *file*
 * operations — and a file with more than this many migrated versions is pathological. The
 * ceiling exists so a single click can never turn into a thousand sequential Drive calls
 * inside one HTTP request.
 */
export const MAX_MIRRORED_OBJECTS_PER_ACTION = 50;

export function assertMirrorableCount(count: number): void {
  if (count > MAX_MIRRORED_OBJECTS_PER_ACTION) {
    throw new ServiceUnavailableError(
      'This item has too many stored versions to update in one step. An administrator needs to do this.',
    );
  }
}

/** True when new content is destined for Drive, which is what makes mirroring worthwhile. */
export function driveIsDefault(): boolean {
  return getEnv().DEFAULT_STORAGE_PROVIDER === 'google_drive';
}
