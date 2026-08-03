/**
 * Turning "these folders / this project / files of this type" into a concrete list of work.
 *
 * The unit is the **version**, not the file. A file with five versions is five transfers.
 * Migrating only current versions would make version history unrecoverable the moment local
 * copies are deleted, and version history is what makes "which bytes did they approve?"
 * answerable — so `currentVersionsOnly` exists but defaults to off.
 *
 * The planner also refuses an unbounded selection. "Migrate everything in one uncontrolled
 * operation" is precisely what the phase plan exists to prevent, so a job with no criteria
 * at all is a validation error rather than a very large job.
 */
import { Types } from 'mongoose';

import { connectToDatabase } from '@/server/db/connection';
import { FileModel } from '@/server/db/models/file.model';
import { FileVersionModel } from '@/server/db/models/file-version.model';
import { FolderModel } from '@/server/db/models/folder.model';
import { ValidationError } from '@/server/errors/app-error';
import * as migrationRepository from '@/server/repositories/storage-migration.repository';
import { DRIVE_MAX_FOLDER_DEPTH } from './folder-mirror';

/** Shared Drive hard ceiling on items. It cannot be raised, by anyone, ever. */
export const SHARED_DRIVE_ITEM_LIMIT = 500_000;
/** Where a single Shared Drive stops being a safe assumption. */
export const SHARED_DRIVE_ITEM_WARNING = 350_000;

export interface Selection {
  folderIds?: string[];
  includeDescendants?: boolean;
  departmentIds?: string[];
  projectIds?: string[];
  extensions?: string[];
  uploadedAfter?: Date | null;
  uploadedBefore?: Date | null;
  versionIds?: string[];
  currentVersionsOnly?: boolean;
}

export interface PlanReport {
  selected: number;
  selectedBytes: number;
  /** Already in Drive and verified — counted, never transferred again. */
  alreadyMigrated: number;
  /** Google-native documents have no bytes to move. */
  skippedNative: number;
  /** Versions whose folder is nested deeper than Drive can represent. */
  tooDeep: Array<{ id: string; name: string; depth: number }>;
  /** R1: what this drive would hold afterwards. */
  itemProjection: {
    existingVersions: number;
    existingFolders: number;
    projectedItems: number;
    limit: number;
    withinLimit: boolean;
    approachingLimit: boolean;
  };
  distinctFolders: number;
}

function oid(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

function toObjectIds(values: string[] | undefined): Types.ObjectId[] {
  return (values ?? []).filter((v) => Types.ObjectId.isValid(v)).map(oid);
}

function hasAnyCriterion(selection: Selection): boolean {
  return Boolean(
    selection.folderIds?.length ||
      selection.departmentIds?.length ||
      selection.projectIds?.length ||
      selection.versionIds?.length ||
      selection.extensions?.length ||
      selection.uploadedAfter ||
      selection.uploadedBefore,
  );
}

/**
 * Builds the `File` filter.
 *
 * `folderPathAncestors` is what makes "everything under this folder" one indexed query
 * rather than a recursive walk — it is maintained by the same subtree update that moves a
 * folder, so it is always current.
 */
function buildFileFilter(organizationId: string, selection: Selection): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    organizationId: oid(organizationId),
    // Trashed files are excluded: migrating something on its way to being purged wastes a
    // transfer and puts an object in company storage that is about to be deleted.
    deletedAt: null,
  };

  const folderIds = toObjectIds(selection.folderIds);
  if (folderIds.length > 0) {
    filter[selection.includeDescendants === false ? 'folderId' : 'folderPathAncestors'] = {
      $in: folderIds,
    };
  }

  const departmentIds = toObjectIds(selection.departmentIds);
  if (departmentIds.length > 0) filter.departmentId = { $in: departmentIds };

  const projectIds = toObjectIds(selection.projectIds);
  if (projectIds.length > 0) filter.projectId = { $in: projectIds };

  const extensions = (selection.extensions ?? []).map((e) => e.trim().toLowerCase().replace(/^\./, ''));
  if (extensions.length > 0) filter.extension = { $in: extensions };

  return filter;
}

function buildVersionFilter(selection: Selection): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    // Only versions whose bytes are still here. Anything already verified in Drive is
    // counted as skipped rather than re-transferred (§7.4 layer 3).
    storageProvider: { $in: ['local', null] },
    // A version that never finished processing has no trustworthy bytes to move.
    processingStatus: 'ready',
  };

  if (selection.currentVersionsOnly) filter.isCurrent = true;

  const uploadedAt: Record<string, Date> = {};
  if (selection.uploadedAfter) uploadedAt.$gte = selection.uploadedAfter;
  if (selection.uploadedBefore) uploadedAt.$lte = selection.uploadedBefore;
  if (Object.keys(uploadedAt).length > 0) filter.uploadedAt = uploadedAt;

  return filter;
}

/** R1. Cheap enough to run on every plan, and the answer changes as the corpus grows. */
async function projectItemCount(newItems: number): Promise<PlanReport['itemProjection']> {
  await connectToDatabase();
  const [existingVersions, existingFolders] = await Promise.all([
    FileVersionModel.countDocuments({ googleDriveFileId: { $type: 'string' } }).exec(),
    FolderModel.countDocuments({ googleDriveFolderId: { $type: 'string' } })
      .setOptions({ withDeleted: true })
      .exec(),
  ]);

  const projectedItems = existingVersions + existingFolders + newItems;
  return {
    existingVersions,
    existingFolders,
    projectedItems,
    limit: SHARED_DRIVE_ITEM_LIMIT,
    withinLimit: projectedItems < SHARED_DRIVE_ITEM_LIMIT,
    approachingLimit: projectedItems >= SHARED_DRIVE_ITEM_WARNING,
  };
}

const FILE_PAGE = 500;

/**
 * Walks the selection and writes one item per version.
 *
 * Pages over files by `_id` rather than loading every match into memory: a department-wide
 * selection can be tens of thousands of files, and holding them all to build one giant
 * `insertMany` is how a migration planner becomes the thing that runs the server out of
 * heap.
 *
 * `dryRun` performs the identical walk and records nothing, so the report is produced by
 * the same code the real run uses — a dry run that took a different path would be reporting
 * on a migration that is not the one about to happen.
 */
export async function planJob(input: {
  jobId: string;
  organizationId: string;
  selection: Selection;
  dryRun: boolean;
}): Promise<PlanReport> {
  const { selection } = input;

  if (!hasAnyCriterion(selection)) {
    throw new ValidationError(
      'Select at least one folder, department, project, file type, date range or explicit file. ' +
        'A migration with no criteria would move the entire corpus in one uncontrolled operation.',
    );
  }

  await connectToDatabase();

  const explicitVersionIds = toObjectIds(selection.versionIds);
  const versionFilterBase = buildVersionFilter(selection);

  let selected = 0;
  let selectedBytes = 0;
  let alreadyMigrated = 0;
  let skippedNative = 0;
  const folderIdsTouched = new Set<string>();

  /** Shared by both branches so the accounting cannot drift between them. */
  const absorb = async (versionFilter: Record<string, unknown>): Promise<void> => {
    const versions = await FileVersionModel.find(versionFilter)
      .select({ fileId: 1, versionNumber: 1, fileSize: 1, isGoogleNative: 1, originalFilename: 1 })
      .sort({ _id: 1 })
      .lean<
        Array<{
          _id: Types.ObjectId;
          fileId: Types.ObjectId;
          versionNumber: number;
          fileSize: number;
          isGoogleNative?: boolean;
          originalFilename: string;
        }>
      >()
      .exec();

    if (versions.length === 0) return;

    // One lookup for the parent files: the item row denormalizes name and folder so the
    // dashboard can list thousands of items without joining.
    const fileIds = [...new Set(versions.map((v) => String(v.fileId)))];
    const files = await FileModel.find({ _id: { $in: fileIds.map(oid) } })
      .select({ displayName: 1, folderId: 1, organizationId: 1 })
      .lean<Array<{ _id: Types.ObjectId; displayName: string; folderId: Types.ObjectId }>>()
      .exec();
    const fileById = new Map(files.map((f) => [String(f._id), f]));

    const items: migrationRepository.NewItem[] = [];

    for (const version of versions) {
      const file = fileById.get(String(version.fileId));
      // The parent was trashed or purged between the two queries. Skipping is correct:
      // there is nothing for the object to belong to.
      if (!file) continue;

      if (version.isGoogleNative) {
        skippedNative += 1;
        continue;
      }

      folderIdsTouched.add(String(file.folderId));
      selected += 1;
      selectedBytes += version.fileSize;

      items.push({
        jobId: input.jobId,
        organizationId: input.organizationId,
        versionId: String(version._id),
        fileId: String(version.fileId),
        folderId: String(file.folderId),
        displayName: file.displayName,
        versionNumber: version.versionNumber,
        sizeBytes: version.fileSize,
        status: 'queued',
      });
    }

    if (!input.dryRun && items.length > 0) {
      await migrationRepository.insertItems(items);
    }
  };

  if (explicitVersionIds.length > 0) {
    // An explicit list overrides every other criterion — an administrator naming specific
    // versions means those, not those-intersected-with-a-folder-filter.
    await absorb({ _id: { $in: explicitVersionIds }, processingStatus: 'ready' });
    alreadyMigrated = await FileVersionModel.countDocuments({
      _id: { $in: explicitVersionIds },
      storageProvider: 'google_drive',
    }).exec();
  } else {
    const fileFilter = buildFileFilter(input.organizationId, selection);
    let afterId: Types.ObjectId | null = null;

    for (;;) {
      const page = await FileModel.find(afterId ? { ...fileFilter, _id: { $gt: afterId } } : fileFilter)
        .select({ _id: 1 })
        .sort({ _id: 1 })
        .limit(FILE_PAGE)
        .lean<Array<{ _id: Types.ObjectId }>>()
        .exec();

      if (page.length === 0) break;

      const pageIds = page.map((f) => f._id);
      await absorb({ ...versionFilterBase, fileId: { $in: pageIds } });

      alreadyMigrated += await FileVersionModel.countDocuments({
        fileId: { $in: pageIds },
        storageProvider: 'google_drive',
      }).exec();

      afterId = page[page.length - 1]!._id;
      if (page.length < FILE_PAGE) break;
    }
  }

  const [tooDeep, itemProjection] = await Promise.all([
    // R2: reported rather than silently failed, and reported *before* anything moves.
    FolderModel.find({
      _id: { $in: [...folderIdsTouched].map(oid) },
      depth: { $gte: DRIVE_MAX_FOLDER_DEPTH },
    })
      .select({ name: 1, depth: 1 })
      .setOptions({ withDeleted: true })
      .lean<Array<{ _id: Types.ObjectId; name: string; depth: number }>>()
      .exec()
      .then((docs) => docs.map((d) => ({ id: String(d._id), name: d.name, depth: d.depth }))),
    // Folders count towards the Shared Drive item limit too, so the projection includes
    // the ones this job would have to mirror.
    projectItemCount(selected + folderIdsTouched.size),
  ]);

  return {
    selected,
    selectedBytes,
    alreadyMigrated,
    skippedNative,
    tooDeep,
    itemProjection,
    distinctFolders: folderIdsTouched.size,
  };
}
