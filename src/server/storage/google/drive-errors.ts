/**
 * What a Drive failure means, and whether trying again can help.
 *
 * Kept separate from the client and free of I/O so the classification — the part that
 * decides whether a migration pauses, retries, or gives up and leaves a file local — is
 * testable without a network, a clock, or a Google account.
 *
 * The distinction that matters most here is **retryable vs. fatal**. Retrying a fatal error
 * turns one failed upload into five, five times the quota consumption, and a five-times
 * longer wait before the user is told the truth. Failing to retry a transient one turns a
 * routine rate-limit into a "migration failed" report an administrator has to triage.
 */

/** Reason strings Google returns in `error.errors[].reason` that mean "slow down". */
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
  'backendError',
  'internalError',
]);

export class DriveApiError extends Error {
  readonly status: number;
  readonly reason: string | null;
  readonly retryable: boolean;
  /** Seconds Google asked us to wait, when it said so. */
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    status: number;
    reason?: string | null;
    message: string;
    retryAfterSeconds?: number | null;
  }) {
    super(input.message);
    this.name = 'DriveApiError';
    this.status = input.status;
    this.reason = input.reason ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
    this.retryable = isRetryableDriveFailure(input.status, this.reason);
  }
}

/**
 * A 403 is the interesting case, and it is genuinely ambiguous in Drive: it carries both
 * "you are going too fast" (retry) and "this credential may not do that" (never retry).
 * Only the `reason` distinguishes them, so a 403 without a recognised rate-limit reason is
 * treated as permanent — the safe direction, because retrying a permissions failure against
 * the whole company's storage is how a migration burns its quota to no purpose.
 */
export function isRetryableDriveFailure(status: number, reason: string | null): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  if (status === 403 && reason && RATE_LIMIT_REASONS.has(reason)) return true;
  return false;
}

/** Whether a failure means the token is dead and a fresh one should be minted before retrying. */
export function isAuthFailure(status: number): boolean {
  return status === 401;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof DriveApiError && error.status === 404;
}

/**
 * Builds the error from a Drive response body.
 *
 * Google's message is preserved because it is genuinely diagnostic ("The user has exceeded
 * their Drive storage quota", "File not found: 1a2b3c"), and this error never reaches a
 * browser — the calling service converts it to a `StorageError`, which is `expose: false`.
 */
export function driveErrorFromResponse(status: number, body: string, retryAfter?: string | null): DriveApiError {
  let reason: string | null = null;
  let message = `Google Drive returned ${status}`;

  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    };
    if (parsed.error?.message) message = parsed.error.message;
    reason = parsed.error?.errors?.[0]?.reason ?? null;
  } catch {
    // A non-JSON body (an HTML error page from a proxy, an empty 502) is normal on the
    // failures that matter most. The status alone still classifies it correctly.
    if (body.trim()) message = `Google Drive returned ${status}`;
  }

  const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : null;

  return new DriveApiError({
    status,
    reason,
    message,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
  });
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected in tests so a backoff run costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so jitter is deterministic. */
  random?: () => number;
  /** Called before each retry — used to invalidate a dead access token. */
  onRetry?: (error: DriveApiError, attempt: number) => void | Promise<void>;
}

const DEFAULTS = {
  attempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 32_000,
};

/**
 * Full jitter, not exponential-with-a-small-wobble.
 *
 * When a batch of concurrent transfers all hit the same rate limit in the same second, a
 * tight jitter band retries them all together again and the limit is hit again immediately.
 * Spreading uniformly across the whole window is what actually breaks the convoy.
 */
export function backoffDelayMs(
  attempt: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'> = {},
): number {
  const base = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const cap = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const random = options.random ?? Math.random;

  const window = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.round(random() * window);
}

/**
 * Runs an operation, retrying only the failures that retrying can fix.
 *
 * `Retry-After` wins over the computed backoff when Google sends one: it is the server
 * telling us how long its limiter's window actually is, and guessing shorter just wastes
 * another request.
 */
export async function withDriveRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      const driveError = error instanceof DriveApiError ? error : null;
      const canRetry = driveError ? driveError.retryable || isAuthFailure(driveError.status) : false;

      if (!canRetry || attempt === attempts) throw error;

      await options.onRetry?.(driveError!, attempt);

      // An auth failure is retried immediately once the token has been invalidated: there
      // is nothing to wait for, and a 32-second pause on a clock-skew blip would be pure
      // added latency on an interactive download.
      const delay = isAuthFailure(driveError!.status)
        ? 0
        : driveError!.retryAfterSeconds !== null
          ? driveError!.retryAfterSeconds * 1000
          : backoffDelayMs(attempt, options);

      if (delay > 0) await sleep(delay);
    }
  }

  throw lastError;
}
