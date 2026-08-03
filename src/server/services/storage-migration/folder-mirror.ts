/**
 * Mirroring the application's folder tree into the Shared Drive.
 *
 * **MongoDB remains the hierarchy.** This creates Drive's *copy* of it so uploaded objects
 * land somewhere a human browsing the Shared Drive can make sense of. Nothing in the
 * application ever reads the tree from Drive — permissions, breadcrumbs, listings and moves
 * are all pure database work, and that does not change.
 *
 * Three properties, in order of how expensive they are to get wrong:
 *
 * 1. **The mapping is stored, never inferred.** A folder is matched to its Drive
 *    counterpart through `googleDriveFolderId` and nothing else. Matching by name would
 *    write research data into whatever folder happened to share a label — and Drive
 *    cheerfully allows two siblings with the same name, so a name is not even unique.
 *
 * 2. **Creation is idempotent under concurrency.** Four transfer workers hitting the same
 *    unmapped folder must produce one Drive folder, not four. The unique partial index on
 *    `googleDriveFolderId` decides the winner; the losers re-read and use it.
 *
 * 3. **It is lazy.** A folder gets a Drive counterpart the first time content needs to land
 *    in it. Eager creation would put a remote call that can fail into `POST /api/folders` —
 *    turning a fast transactional write into a distributed operation — and would create
 *    tens of thousands of empty Drive folders against the Shared Drive's item limit.
 */
import { Types } from 'mongoose';

import { connectToDatabase } from '@/server/db/connection';
import { FolderModel } from '@/server/db/models/folder.model';
import { StorageError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';
import type { HierarchicalStorageProvider } from '@/server/storage/types';

/**
 * Drive's own ceiling. The application allows 32 levels (`MAX_FOLDER_DEPTH`), so a tree can
 * legitimately exist here that cannot be represented there. A dry run reports these before
 * anything moves; a live transfer refuses them rather than silently flattening.
 */
export const DRIVE_MAX_FOLDER_DEPTH = 20;

interface MappedFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
  pathAncestors: string[];
  depth: number;
  googleDriveFolderId: string | null;
}

async function loadFolders(ids: string[]): Promise<Map<string, MappedFolder>> {
  await connectToDatabase();
  const docs = await FolderModel.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
    .select({ name: 1, parentFolderId: 1, pathAncestors: 1, depth: 1, googleDriveFolderId: 1 })
    .setOptions({ withDeleted: true })
    .lean<
      Array<{
        _id: Types.ObjectId;
        name: string;
        parentFolderId: Types.ObjectId | null;
        pathAncestors: Types.ObjectId[];
        depth: number;
        googleDriveFolderId?: string | null;
      }>
    >()
    .exec();

  const map = new Map<string, MappedFolder>();
  for (const doc of docs) {
    map.set(String(doc._id), {
      id: String(doc._id),
      name: doc.name,
      parentFolderId: doc.parentFolderId ? String(doc.parentFolderId) : null,
      pathAncestors: (doc.pathAncestors ?? []).map(String),
      depth: doc.depth,
      googleDriveFolderId: doc.googleDriveFolderId ?? null,
    });
  }
  return map;
}

export interface FolderMirror {
  /** Drive folder id for the requested application folder. */
  externalId: string;
  /** How many Drive folders had to be created to get there. */
  created: number;
}

/**
 * Ensures every folder from the drive root down to `folderId` exists in Drive.
 *
 * Walks root → leaf so a parent always exists before its child is created. Each level is
 * recorded as it is created, so a crash half way down leaves a partially-mapped chain that
 * the next run completes rather than duplicates.
 */
export async function ensureDriveFolderPath(input: {
  folderId: string;
  hierarchy: HierarchicalStorageProvider;
}): Promise<FolderMirror> {
  const { folderId, hierarchy } = input;

  await connectToDatabase();
  const seed = await loadFolders([folderId]);
  const leaf = seed.get(folderId);
  if (!leaf) throw new StorageError('STORAGE_ERROR', 'The folder to mirror no longer exists');

  // Already mapped: the overwhelmingly common case once a project has been migrated once.
  if (leaf.googleDriveFolderId) {
    return { externalId: leaf.googleDriveFolderId, created: 0 };
  }

  assertMirrorableDepth(leaf.depth, leaf.name);

  // Root → leaf. `pathAncestors` is already stored in that order.
  const chain = [...leaf.pathAncestors, folderId];
  const folders = await loadFolders(chain);

  let parentExternalId: string | null = null;
  let created = 0;

  for (const id of chain) {
    const folder = folders.get(id);
    if (!folder) throw new StorageError('STORAGE_ERROR', 'A folder in the path no longer exists');

    if (folder.googleDriveFolderId) {
      parentExternalId = folder.googleDriveFolderId;
      continue;
    }

    const result = await hierarchy.ensureFolder({
      name: folder.name,
      parentExternalId,
      // Stamped onto the Drive folder so an orphan left by a crash between "Drive created
      // it" and "MongoDB recorded it" can be adopted rather than duplicated.
      appFolderId: folder.id,
    });

    if (!result) {
      throw new StorageError('STORAGE_ERROR', 'The storage provider did not return a folder to mirror into');
    }

    parentExternalId = await recordMapping({
      folderId: folder.id,
      externalId: result.externalId,
      parentExternalId,
    });
    created += 1;
  }

  if (!parentExternalId) {
    throw new StorageError('STORAGE_ERROR', 'Folder mirroring produced no destination');
  }
  return { externalId: parentExternalId, created };
}

/**
 * Writes the mapping, and loses the race gracefully.
 *
 * Two workers mirroring the same folder both call `ensureFolder`; adoption by stamped id
 * means they usually get the *same* Drive folder back, but if both created one the unique
 * index rejects the second write. The loser re-reads the winner's id and uses that — the
 * folder it created is left orphaned in Drive, which a reconciliation sweep can adopt or
 * remove later. Returning a wrong id here would scatter one folder's contents across two.
 */
async function recordMapping(input: {
  folderId: string;
  externalId: string;
  parentExternalId: string | null;
}): Promise<string> {
  try {
    await FolderModel.updateOne(
      { _id: new Types.ObjectId(input.folderId) },
      {
        $set: {
          googleDriveFolderId: input.externalId,
          googleDriveParentFolderId: input.parentExternalId,
          driveMappingStatus: 'mapped',
          driveMappedAt: new Date(),
        },
      },
      { withDeleted: true } as never,
    ).exec();
    return input.externalId;
  } catch (error) {
    const winner = await loadFolders([input.folderId]);
    const existing = winner.get(input.folderId)?.googleDriveFolderId;
    if (existing) {
      getLogger().warn(
        { folderId: input.folderId, discarded: input.externalId, adopted: existing },
        'Lost a folder-mirroring race; using the mapping that was recorded first',
      );
      return existing;
    }
    throw error;
  }
}

export function assertMirrorableDepth(depth: number, name: string): void {
  if (depth >= DRIVE_MAX_FOLDER_DEPTH) {
    throw new StorageError(
      'STORAGE_ERROR',
      `"${name}" is nested ${depth} levels deep. Google Drive supports at most ${DRIVE_MAX_FOLDER_DEPTH}, so this folder cannot be mirrored until the tree is flattened.`,
    );
  }
}

/**
 * Folders in the selection that are too deep for Drive to represent.
 *
 * Reported by a dry run so the tree can be flattened *before* a migration starts, rather
 * than discovered as a run of failures half way through one.
 */
export async function findTooDeepFolders(folderIds: string[]): Promise<
  Array<{ id: string; name: string; depth: number }>
> {
  if (folderIds.length === 0) return [];
  await connectToDatabase();

  const docs = await FolderModel.find({
    _id: { $in: folderIds.map((id) => new Types.ObjectId(id)) },
    depth: { $gte: DRIVE_MAX_FOLDER_DEPTH },
  })
    .select({ name: 1, depth: 1 })
    .setOptions({ withDeleted: true })
    .lean<Array<{ _id: Types.ObjectId; name: string; depth: number }>>()
    .exec();

  return docs.map((doc) => ({ id: String(doc._id), name: doc.name, depth: doc.depth }));
}

/** Clears a folder's Drive mapping. Used by rollback; the Drive folder is left in place. */
export async function clearFolderMapping(folderIds: string[]): Promise<void> {
  if (folderIds.length === 0) return;
  await connectToDatabase();
  await FolderModel.updateMany(
    { _id: { $in: folderIds.map((id) => new Types.ObjectId(id)) } },
    {
      $set: {
        googleDriveFolderId: null,
        googleDriveParentFolderId: null,
        driveMappingStatus: 'none',
        driveMappedAt: null,
      },
    },
  ).exec();
}
