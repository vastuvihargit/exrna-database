/**
 * Uniform API envelope.
 *
 *   success → { data, meta? }
 *   failure → { error: { code, message, details?, requestId } }
 *
 * This is the boundary between the framework-free server core and Next.js, so it is
 * the one place under src/server that is allowed to import from `next`.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AppError, isAppError } from '@/server/errors/app-error';
import { getLogger } from '@/server/logging/logger';

export interface ApiMeta {
  page?: number;
  pageSize?: number;
  total?: number;
  cursor?: string | null;
  hasMore?: boolean;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export function ok<T>(data: T, init?: { status?: number; meta?: ApiMeta; requestId?: string }) {
  const headers = new Headers();
  if (init?.requestId) headers.set('X-Request-Id', init.requestId);
  return NextResponse.json(
    init?.meta ? { data, meta: init.meta } : { data },
    { status: init?.status ?? 200, headers },
  );
}

export function created<T>(data: T, requestId?: string) {
  return ok(data, { status: 201, ...(requestId ? { requestId } : {}) });
}

export function noContent(requestId?: string) {
  const headers = new Headers();
  if (requestId) headers.set('X-Request-Id', requestId);
  return new NextResponse(null, { status: 204, headers });
}

/**
 * Converts any thrown value into a safe HTTP response.
 *
 * Unknown errors are logged in full and reported generically: their messages can
 * contain filesystem paths, driver internals or query fragments.
 */
export function toErrorResponse(error: unknown, requestId: string) {
  const log = getLogger();

  if (error instanceof ZodError) {
    const body: ApiErrorBody = {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request payload is invalid',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        requestId,
      },
    };
    return NextResponse.json(body, { status: 422, headers: { 'X-Request-Id': requestId } });
  }

  if (isAppError(error)) {
    logAppError(error, requestId);
    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message: error.expose ? error.message : genericMessageFor(error),
        ...(error.expose && error.details !== undefined ? { details: error.details } : {}),
        requestId,
      },
    };
    const headers: Record<string, string> = { 'X-Request-Id': requestId };
    if (error.code === 'RATE_LIMITED' && 'retryAfterSeconds' in error) {
      headers['Retry-After'] = String((error as { retryAfterSeconds: number }).retryAfterSeconds);
    }
    // RFC 9110 requires a 416 to state the object size so the client can correct its
    // request instead of retrying the same impossible range.
    if (error.code === 'RANGE_NOT_SATISFIABLE' && 'totalSize' in error) {
      headers['Content-Range'] = `bytes */${(error as { totalSize: number }).totalSize}`;
    }
    return NextResponse.json(body, { status: error.status, headers });
  }

  log.error({ err: error, requestId }, 'Unhandled error in route handler');
  const body: ApiErrorBody = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Quote the request id when reporting this.',
      requestId,
    },
  };
  return NextResponse.json(body, { status: 500, headers: { 'X-Request-Id': requestId } });
}

function logAppError(error: AppError, requestId: string): void {
  const log = getLogger();
  const payload = { code: error.code, status: error.status, requestId, err: error };
  if (error.status >= 500) log.error(payload, error.message);
  else if (error.status === 403 || error.status === 401) log.warn(payload, error.message);
  else log.info(payload, error.message);
}

function genericMessageFor(error: AppError): string {
  return error.status >= 500
    ? 'An unexpected error occurred. Quote the request id when reporting this.'
    : 'The request could not be completed.';
}
