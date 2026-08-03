/**
 * "Is this failure *the object is not there*, or something else?"
 *
 * The distinction decides whether a read may fall back to the retained local copy, and
 * getting it wrong is expensive in both directions:
 *
 *   • Treating a transient Google outage as "missing" would mark thousands of perfectly
 *     healthy versions as conflicts during a five-minute blip, and page an administrator
 *     about data loss that never happened.
 *   • Treating a genuinely deleted object as transient would surface a 500 to the employee
 *     and leave the record claiming everything is fine, so nobody ever finds out.
 *
 * So the test is deliberately narrow: only the two errors that specifically mean *absent*
 * count. A 403, a 429, a timeout and a 500 are all "not right now", not "not there".
 *
 * Lives in the storage layer because it is the only place that knows both providers' error
 * shapes; the services above it ask this question without knowing which provider answered.
 */
import { StorageError } from '@/server/errors/app-error';
import { DriveApiError } from './google/drive-errors';

/** Node's error code for a path that does not exist, wherever it surfaces. */
function hasEnoentCause(error: unknown): boolean {
  let current: unknown = error;
  // The local provider wraps the original `fsp.open` rejection as `cause`, so the code is
  // one level down. The loop guards against a future second layer of wrapping rather than
  // assuming the depth stays one.
  for (let depth = 0; current && depth < 5; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isMissingObjectError(error: unknown): boolean {
  // Google Drive: the object is gone — deleted directly in the web UI, or purged from the
  // Drive trash after its 30 days.
  if (error instanceof DriveApiError) return error.status === 404;

  // Local: the bytes are not on the volume. Distinguished from "the volume is unreadable",
  // which arrives as EACCES or EIO and is emphatically not a missing file.
  if (error instanceof StorageError) return hasEnoentCause(error);

  return hasEnoentCause(error);
}
