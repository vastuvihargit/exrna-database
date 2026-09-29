/**
 * File comments — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_COMMENTS`.
 *
 * `isValidId` is re-exported from the Mongo module because `comment.service.ts` uses it to reject
 * a malformed id before touching the database. It is an ObjectId shape check, so it is only
 * meaningful for rows written before the cutover — a D1 comment created afterwards carries a
 * UUID and would not pass it. The service therefore uses it as a *fast reject for Mongo-era ids*
 * and never as the authorization step; `requireFile` is what decides access.
 */
import { isD1 } from './data-source';
import { mongoCommentRepository, isValidId } from './comment.repository.mongo';
import { d1CommentRepository } from './comment.repository.d1';
import type {
  CommentRecord,
  CommentRepository,
  CommentTx,
  CreateCommentInput,
} from './comment.repository.contract';

export type { CommentRecord, CommentRepository, CommentTx, CreateCommentInput };
export { mongoCommentRepository, d1CommentRepository, isValidId };

function active(): CommentRepository {
  return isD1('comments') ? d1CommentRepository : mongoCommentRepository;
}

export function findById(id: string): Promise<CommentRecord | null> {
  return active().findById(id);
}

export function listForFile(
  fileId: string,
  options: { includeResolved?: boolean; limit?: number } = {},
): Promise<CommentRecord[]> {
  return active().listForFile(fileId, options);
}

export function countForFile(fileId: string): Promise<number> {
  return active().countForFile(fileId);
}

export function create(input: CreateCommentInput, tx?: CommentTx): Promise<CommentRecord> {
  return active().create(input, tx);
}

export function updateBody(id: string, body: string): Promise<CommentRecord | null> {
  return active().updateBody(id, body);
}

export function setResolved(
  id: string,
  resolved: boolean,
  userId: string,
): Promise<CommentRecord | null> {
  return active().setResolved(id, resolved, userId);
}

export function softDelete(id: string, userId: string): Promise<boolean> {
  return active().softDelete(id, userId);
}

export function countRepliesTo(commentId: string): Promise<number> {
  return active().countRepliesTo(commentId);
}

export function purgeForFiles(fileIds: string[]): Promise<number> {
  return active().purgeForFiles(fileIds);
}
