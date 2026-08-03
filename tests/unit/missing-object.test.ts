/**
 * "Absent" versus "not right now".
 *
 * This one predicate decides whether a read is allowed to fall back to the retained local
 * copy and mark the record as conflicted. Both directions of error are expensive:
 *
 *   • Too broad — a five-minute Google outage marks thousands of healthy versions as
 *     conflicts and pages an administrator about data loss that never happened.
 *   • Too narrow — a genuinely deleted object surfaces as a 500 while the record goes on
 *     claiming everything is fine, so nobody ever finds out.
 *
 * So the tests are mostly about what must **not** count.
 */
import { describe, expect, it } from 'vitest';

import { isMissingObjectError } from '@/server/storage/missing-object';
import { DriveApiError } from '@/server/storage/google/drive-errors';
import { NotFoundError, StorageError } from '@/server/errors/app-error';

/** How the local provider actually reports a missing file: ENOENT wrapped as a cause. */
function localOpenFailure(code: string): StorageError {
  const cause = Object.assign(new Error(`${code}: no such file or directory`), { code });
  return new StorageError('STORAGE_ERROR', 'Stored file could not be opened', cause);
}

describe('what counts as a missing object', () => {
  it('treats a Drive 404 as missing', () => {
    expect(
      isMissingObjectError(new DriveApiError({ status: 404, reason: 'notFound', message: 'File not found' })),
    ).toBe(true);
  });

  it('treats a local ENOENT as missing, through the provider’s wrapping', () => {
    expect(isMissingObjectError(localOpenFailure('ENOENT'))).toBe(true);
  });

  /** A path component that is not a directory means the same thing: it is not there. */
  it('treats ENOTDIR as missing', () => {
    expect(isMissingObjectError(localOpenFailure('ENOTDIR'))).toBe(true);
  });

  it('reads a bare errno object as well as a wrapped one', () => {
    expect(isMissingObjectError(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe(true);
  });
});

describe('what must not count', () => {
  /**
   * The dangerous one. Retrying is the right response to all of these; falling back to a
   * possibly-stale local copy and declaring the record conflicted is not.
   */
  it.each([
    [500, 'Backend Error'],
    [503, 'Service Unavailable'],
    [429, 'Rate Limit Exceeded'],
    [504, 'Timeout'],
  ])('does not treat a %i from Drive as missing', (status, message) => {
    expect(isMissingObjectError(new DriveApiError({ status, message }))).toBe(false);
  });

  it('does not treat a Drive permissions failure as missing', () => {
    expect(
      isMissingObjectError(
        new DriveApiError({ status: 403, reason: 'insufficientFilePermissions', message: 'Denied' }),
      ),
    ).toBe(false);
  });

  /**
   * An unreadable volume is emphatically not an absent file. Treating a permissions or I/O
   * fault on the storage mount as "the file is gone" would mark an entire corpus as
   * conflicted the moment a mount came back read-only.
   */
  it.each(['EACCES', 'EIO', 'EBUSY', 'EPERM'])(
    'does not treat a local %s as missing',
    (code) => {
      expect(isMissingObjectError(localOpenFailure(code))).toBe(false);
    },
  );

  it('does not treat a storage error with no cause as missing', () => {
    expect(isMissingObjectError(new StorageError('STORAGE_ERROR', 'Stored path is not a regular file'))).toBe(
      false,
    );
  });

  it('does not treat unrelated errors as missing', () => {
    expect(isMissingObjectError(new NotFoundError())).toBe(false);
    expect(isMissingObjectError(new TypeError('programming error'))).toBe(false);
    expect(isMissingObjectError(null)).toBe(false);
    expect(isMissingObjectError(undefined)).toBe(false);
    expect(isMissingObjectError('ENOENT')).toBe(false);
  });

  /** A cyclic cause chain must terminate rather than hang the read path. */
  it('does not loop on a self-referencing cause', () => {
    const error = new Error('looping') as Error & { cause?: unknown };
    error.cause = error;
    expect(isMissingObjectError(error)).toBe(false);
  });
});
