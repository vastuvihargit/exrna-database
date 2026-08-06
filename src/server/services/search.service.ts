/**
 * Cross-drive search.
 *
 * The security property this module exists to hold is narrow and absolute: a user must
 * never learn that a file they cannot open exists. Not its name, not a snippet of it,
 * not its folder, and not the fact that a result count went up by one.
 *
 * That is enforced in two independent places, deliberately:
 *
 *  1. `resourceVisibilityFilter` is folded into the MongoDB query, so restricted rows
 *     are never fetched and `total` never counts them. Filtering after the fetch would
 *     leak through the count and through pagination even with the rows removed.
 *
 *  2. Every returned row is then re-checked with the same `can()` the mutating routes
 *     use. If the query filter ever drifts from the authorization rules, the second
 *     check catches it and the count is corrected rather than the row being shown.
 *
 * The second pass is redundant by design. Redundancy is the point: one of them being
 * wrong is a bug, both being wrong at once is what it would take to leak.
 */
import { enforce, RATE_LIMITS } from '@/server/auth/rate-limit';
import type { Actor } from '@/server/permissions/actor';
import { can } from '@/server/permissions/authorize';
import { resourceVisibilityFilter } from '@/server/permissions/visibility';
import * as fileRepository from '@/server/repositories/file.repository';
import * as folderRepository from '@/server/repositories/folder.repository';
import * as starRepository from '@/server/repositories/star.repository';
import { fileResource, type FileContext } from './file-access';
import { folderResource } from './folder-access';
import { isPreviewable } from '@/server/domain/file-types';
import { fileCapabilities } from './file-access';
import { folderCapabilities } from './folder-access';
import type { FileView } from './file.service';
import type { FolderView } from './folder.service';
import { METADATA_QUERY_KEYS, type SearchQuery } from '@/server/validation/search.schemas';

export interface SearchResult {
  files: FileView[];
  folders: FolderView[];
  totals: { files: number; folders: number };
  /** True when the criteria were empty — the UI shows guidance instead of "no results". */
  empty: boolean;
}

export async function search(actor: Actor, query: SearchQuery): Promise<SearchResult> {
  // Text-index scans filtered by permission are the most expensive read in the system,
  // and a scripted search loop is also how somebody probes for filenames they cannot
  // open. The limit is well above any human search rate.
  enforce(`search:${actor.userId}`, RATE_LIMITS.search);

  const visibility = resourceVisibilityFilter(actor);

  const metadata: Record<string, string> = {};
  for (const key of METADATA_QUERY_KEYS) {
    const value = query[key];
    if (typeof value === 'string' && value.length > 0) metadata[key] = value;
  }

  const hasCriteria =
    Boolean(query.q) ||
    Object.keys(metadata).length > 0 ||
    Boolean(
      query.folderId ??
        query.underFolderId ??
        query.departmentId ??
        query.projectId ??
        query.experimentId ??
        query.ownerId ??
        query.category ??
        query.extension ??
        query.confidentiality ??
        query.reviewStatus ??
        query.approvalStatus ??
        query.tags?.length ??
        query.updatedFrom ??
        query.updatedTo ??
        query.minSize ??
        query.maxSize,
    );

  if (!hasCriteria) {
    return { files: [], folders: [], totals: { files: 0, folders: 0 }, empty: true };
  }

  const wantFiles = query.scope === 'all' || query.scope === 'files';
  const wantFolders = query.scope === 'all' || query.scope === 'folders';

  const [fileHits, folderHits] = await Promise.all([
    wantFiles
      ? fileRepository.search({
          visibility,
          organizationId: actor.organizationId,
          ...(query.q ? { text: query.q } : {}),
          ...(query.folderId ? { folderId: query.folderId } : {}),
          ...(query.underFolderId ? { underFolderId: query.underFolderId } : {}),
          ...(query.departmentId ? { departmentId: query.departmentId } : {}),
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.experimentId ? { experimentId: query.experimentId } : {}),
          ...(query.ownerId ? { ownerId: query.ownerId } : {}),
          ...(query.category ? { category: query.category } : {}),
          ...(query.extension ? { extension: query.extension } : {}),
          ...(query.confidentiality ? { confidentiality: query.confidentiality } : {}),
          ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
          ...(query.approvalStatus ? { approvalStatus: query.approvalStatus } : {}),
          ...(query.tags?.length ? { tags: query.tags } : {}),
          ...(Object.keys(metadata).length ? { metadata } : {}),
          ...(query.updatedFrom ? { updatedFrom: query.updatedFrom } : {}),
          ...(query.updatedTo ? { updatedTo: query.updatedTo } : {}),
          ...(query.minSize !== undefined ? { minSize: query.minSize } : {}),
          ...(query.maxSize !== undefined ? { maxSize: query.maxSize } : {}),
          includeArchived: query.includeArchived,
          page: query.page,
          pageSize: query.pageSize,
          sort: query.sort,
          order: query.order,
        })
      : Promise.resolve({ items: [], total: 0 }),

    // Folders answer a different question ("where does this live?") and are not filtered
    // by file-specific criteria — a folder has no extension or review status.
    wantFolders && !query.category && !query.extension && !query.reviewStatus && !query.approvalStatus
      ? folderRepository.search({
          actor,
          ...(query.q ? { text: query.q } : {}),
          ...(query.departmentId ? { departmentId: query.departmentId } : {}),
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.underFolderId ? { underFolderId: query.underFolderId } : {}),
          includeArchived: query.includeArchived,
          page: query.page,
          // Folders are the minority answer; a full page of them would bury the files.
          pageSize: Math.min(query.pageSize, 10),
        })
      : Promise.resolve({ items: [], total: 0 }),
  ]);

  // Second, independent authorization pass. See the note at the top of this file.
  const visibleFiles = fileHits.items.filter((file) => can(actor, 'file.view', fileResource(file)));
  const visibleFolders = folderHits.items.filter((folder) =>
    can(actor, 'file.view', folderResource(folder)),
  );

  const [starredFiles, starredFolders] = await Promise.all([
    starRepository.starredIdsAmong(actor.userId, 'file', visibleFiles.map((file) => file.id)),
    starRepository.starredIdsAmong(actor.userId, 'folder', visibleFolders.map((folder) => folder.id)),
  ]);

  return {
    files: visibleFiles.map((file) => {
      // Search matches from anywhere in the drive, so a per-result ancestor chain would
      // be one query per row. Capabilities are computed from the file's own ACL here and
      // re-derived in full — chain included — by the route that actually acts.
      const context: FileContext = { file, folderChain: [], ancestorAcls: [] };
      return {
        ...file,
        isStarred: starredFiles.has(file.id),
        previewable: isPreviewable(file.extension),
        capabilities: fileCapabilities(actor, context),
      };
    }),
    folders: visibleFolders.map((folder) => ({
      ...folder,
      isStarred: starredFolders.has(folder.id),
      capabilities: folderCapabilities(actor, { folder, ancestors: [], ancestorAcls: [] }),
    })),
    totals: {
      files: fileHits.total - (fileHits.items.length - visibleFiles.length),
      folders: folderHits.total - (folderHits.items.length - visibleFolders.length),
    },
    empty: false,
  };
}

/** Facet counts for the filter chips, computed over what this actor can see. */
export async function facets(actor: Actor) {
  return fileRepository.searchFacets(resourceVisibilityFilter(actor), actor.organizationId);
}

export const searchService = { search, facets };
