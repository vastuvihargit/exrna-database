/**
 * Browser-side API client.
 *
 * Every mutating request carries the CSRF token read from the readable `bd_csrf`
 * cookie (double-submit) — the server compares it to the hash stored on the session.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(message: string, status: number, code: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

const CSRF_COOKIE = 'bd_csrf';

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(`${CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) : null;
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  // `body` is pulled out of the rest so the unknown-typed value never reaches
  // fetch's RequestInit directly — it is serialized below.
  const { body, ...rest } = options;
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);

  if (body !== undefined) headers.set('Content-Type', 'application/json');

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers.set('x-csrf-token', csrf);
  }

  const response = await fetch(path, {
    ...rest,
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code: string; message: string; details?: unknown; requestId?: string } }
    | null;

  if (!response.ok || payload?.error) {
    const error = payload?.error;
    throw new ApiError(
      error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.details,
      error?.requestId,
    );
  }

  return payload?.data as T;
}
