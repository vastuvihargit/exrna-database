/**
 * Maintenance and write-freeze modes, for the cutover window.
 *
 *   MAINTENANCE_MODE=off          normal operation (the default)
 *   MAINTENANCE_MODE=read_only    browsing and downloads work; every state-changing request —
 *                                 uploads, edits, moves, reviews, sign-in — is refused with 503.
 *                                 Queue deliveries are refused too, so they wait and retry.
 *   MAINTENANCE_MODE=maintenance  everything except the health endpoints answers 503.
 *
 * `read_only` is the write freeze the migration's bulk load runs under. `maintenance` is for the
 * final delta pass and the flag switch: a *read* can still write (a download appends an audit
 * record and an activity row), and anything written after the final delta pass would exist only
 * in the database being retired.
 *
 * Read per request, like the data-source flags, so entering and leaving either mode is a
 * variable change with no redeploy.
 */
import { getEnv } from '@/server/config/env';
import { ServiceUnavailableError } from '@/server/errors/app-error';

export type MaintenanceMode = 'off' | 'read_only' | 'maintenance';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Always reachable, so monitoring can tell "in maintenance" from "down". */
const ALWAYS_ALLOWED = ['/api/health', '/api/version'];

/** Sign-out is allowed in read-only mode: refusing it would keep a session alive against the user's wishes. */
const READ_ONLY_ALLOWED_WRITES = new Set(['/api/auth/logout', '/api/auth/logout-all']);

export function maintenanceMode(): MaintenanceMode {
  return getEnv().MAINTENANCE_MODE;
}

export function assertRequestAllowed(method: string, path: string): void {
  const mode = maintenanceMode();
  if (mode === 'off') return;
  if (ALWAYS_ALLOWED.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return;

  if (mode === 'maintenance') {
    throw new ServiceUnavailableError(
      'The research drive is down for scheduled maintenance. Please try again shortly.',
    );
  }

  // read_only. The Access sign-in bridge is a GET that issues a session, which is a write.
  const writes = !SAFE_METHODS.has(method.toUpperCase()) || path === '/api/auth/access';
  if (writes && !READ_ONLY_ALLOWED_WRITES.has(path)) {
    throw new ServiceUnavailableError(
      'The research drive is read-only during scheduled maintenance. You can browse and download, ' +
        'but changes are paused. Please try again shortly.',
    );
  }
}
