/**
 * Typed application errors.
 *
 * Every error that crosses the API boundary is one of these. Anything else is treated
 * as an unexpected failure: logged in full, reported to the client as a generic message
 * plus a request id. Internal messages never reach the browser.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RANGE_NOT_SATISFIABLE'
  | 'QUOTA_EXCEEDED'
  | 'STORAGE_ERROR'
  | 'INVALID_KEY'
  | 'PATH_ESCAPE'
  | 'FILE_LOCKED_APPROVED'
  | 'VERSION_MOVED'
  /**
   * The content itself changed underneath a request — distinct from `VERSION_MOVED`, which
   * means the *record* moved on. Only reachable for content in the Shared Drive, where the
   * bytes are not immutable, and the two need different explanations to the person reading
   * the message.
   */
  | 'CONTENT_CHANGED'
  | 'CIRCULAR_MOVE'
  | 'UPLOAD_SESSION_EXPIRED'
  | 'SERVICE_UNAVAILABLE'
  /** A Node-only administrative tool reached on a Worker. See `http/node-only.ts`. */
  | 'NODE_ONLY_OPERATION'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** Safe to show the user verbatim. Unexpected errors are never marked safe. */
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    options?: { details?: unknown; cause?: unknown; expose?: boolean },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = options?.details;
    this.expose = options?.expose ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request payload is invalid', details?: unknown) {
    super('VALIDATION_FAILED', message, 422, { details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super('FORBIDDEN', message, 403);
  }
}

/**
 * Also used when a resource exists but is invisible to the actor.
 *
 * Returning 403 for an existing-but-restricted record would confirm its existence —
 * an information-disclosure oracle. See docs/phase-0/08-security-threat-model.md.
 */
export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found') {
    super('NOT_FOUND', message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'The request conflicts with the current state', code: ErrorCode = 'CONFLICT') {
    super(code, message, 409);
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds = 60, message = 'Too many requests') {
    super('RATE_LIMITED', message, 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'The uploaded file exceeds the maximum allowed size') {
    super('PAYLOAD_TOO_LARGE', message, 413);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'This file type is not allowed', details?: unknown) {
    super('UNSUPPORTED_MEDIA_TYPE', message, 415, { details });
  }
}

/**
 * A `Range` header that cannot be satisfied.
 *
 * Carries the object size because RFC 9110 requires the 416 response to state it in
 * `Content-Range: bytes * /size` so the client can correct itself.
 */
export class RangeNotSatisfiableError extends AppError {
  readonly totalSize: number;

  constructor(totalSize: number, message = 'The requested byte range is outside this file') {
    super('RANGE_NOT_SATISFIABLE', message, 416);
    this.totalSize = totalSize;
  }
}

export class QuotaExceededError extends AppError {
  constructor(message = 'Storage quota exceeded') {
    super('QUOTA_EXCEEDED', message, 507);
  }
}

/**
 * Storage failures are never exposed verbatim: their messages can contain
 * filesystem paths, which must not leave the server.
 */
export class StorageError extends AppError {
  constructor(code: 'STORAGE_ERROR' | 'INVALID_KEY' | 'PATH_ESCAPE' = 'STORAGE_ERROR', message = 'Storage operation failed', cause?: unknown) {
    super(code, message, code === 'STORAGE_ERROR' ? 500 : 400, { cause, expose: false });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super('SERVICE_UNAVAILABLE', message, 503);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
