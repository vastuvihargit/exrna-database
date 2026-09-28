/**
 * Cloudflare Access, applied to every request — not just to sign-in.
 *
 * ── The architecture ────────────────────────────────────────────────────────────────────
 *
 *   Cloudflare Access          verifies the Google Workspace identity, at the edge
 *        ↓
 *   /api/auth/access           verifies the Access JWT server-side, resolves the employee,
 *                              enforces domain / provisioning / active status, issues a session
 *        ↓
 *   every request              session resolved as before (status re-read, roles re-loaded)
 *                              AND the Access JWT re-verified and matched to the session's user
 *        ↓
 *   roles + ACL                unchanged — Access never grants a permission
 *
 * ── Why the JWT is checked on every request, not only at sign-in ────────────────────────
 *
 * A session cookie outlives the Access session that produced it. Without the per-request check:
 *
 *   • revoking someone in Access (or in Google Workspace) would leave their application session
 *     working until its idle timeout — hours, by default;
 *   • a request that reached the Worker by its `*.workers.dev` hostname, bypassing Access, would
 *     be served on the strength of a stolen cookie alone.
 *
 * With it, the session and a live, signed Access assertion for the *same person* are both
 * required. A mismatch (the browser is now signed in to Access as somebody else) is treated as
 * "no session", and the next page load signs the new person in properly.
 *
 * ── What is never trusted ───────────────────────────────────────────────────────────────
 *
 * `Cf-Access-Authenticated-User-Email`, any e-mail or user id from the browser, and any header
 * other than the signed assertion. `cloudflare-access.ts` has the reasoning.
 *
 * ── When Access is not configured ───────────────────────────────────────────────────────
 *
 * Local development and the existing Node deployment: `accessConfig()` is null and every
 * function here is a pass-through. A production *Worker* cannot be in that state —
 * `loadWorkerEnv` refuses to boot without Access, because Argon2id passwords cannot be verified
 * there. There is therefore no production fallback to a weaker check.
 */
import { getEnv } from '@/server/config/env';
import {
  accessConfigFrom,
  readAccessToken,
  verifyAccessJwt,
  type AccessConfig,
} from './cloudflare-access';
import { resolveSession, type ResolvedSession } from './session.service';
import { getLogger } from '@/server/logging/logger';
import { isWorkerRuntime } from '@/server/runtime';

export function accessConfig(): AccessConfig | null {
  return accessConfigFrom(getEnv());
}

export function isAccessEnforced(): boolean {
  return accessConfig() !== null;
}

/**
 * What a user is told when the application does not own their password.
 *
 * With Cloudflare Access in front, identity — and so password recovery — belongs to the company
 * identity provider (Google Workspace). Shared by the API refusal and the two recovery pages.
 */
export const EXTERNAL_PASSWORD_RECOVERY_MESSAGE =
  'Sign-in is handled by your company single sign-on, so this application does not hold your ' +
  'password. To recover access, use your identity provider’s account recovery (for Google ' +
  'Workspace, “Forgot password?” on the Google sign-in page) or ask your Workspace administrator.';

/**
 * Whether the application's own password reset exists on this deployment.
 *
 * No when Access is enforced (identity is external), and no on a Worker at all: the reset-token
 * store is a MongoDB collection with deliberately no D1 counterpart — a production Worker always
 * runs behind Access, so building one would serve nobody — and the argon2 hash a reset writes
 * cannot be computed there. The legacy Node deployment keeps the flow unchanged.
 */
export function isPasswordRecoveryAvailable(): boolean {
  return !isAccessEnforced() && !isWorkerRuntime();
}

/**
 * Where the browser goes after signing out.
 *
 * With Access in front, clearing the application session alone would sign the person straight
 * back in on the next page load, because their Access session is still valid. So sign-out ends
 * the Access session too, through the application hostname's own Access logout endpoint.
 */
export function signOutRedirect(): string {
  return isAccessEnforced() ? '/cdn-cgi/access/logout' : '/login';
}

/** Where an unauthenticated browser is sent: the Access sign-in bridge, or the login page. */
export function signInPath(nextPath?: string): string {
  const safeNext = nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : null;
  const base = isAccessEnforced() ? '/api/auth/access' : '/login';
  return safeNext ? `${base}?next=${encodeURIComponent(safeNext)}` : base;
}

/**
 * The session for this request, with the Access identity checked when Access is in front.
 *
 * Every authenticated entry point — API routes, pages, "optional actor" lookups — goes through
 * this, so there is exactly one place the rule lives.
 */
export async function resolveRequestSession(
  sessionToken: string | undefined,
  headers: { get(name: string): string | null },
): Promise<ResolvedSession | null> {
  const resolved = await resolveSession(sessionToken);
  const config = accessConfig();
  if (!config || !resolved) return resolved;

  const assertion = readAccessToken(headers);
  if (!assertion) return null;

  try {
    const identity = await verifyAccessJwt(assertion, config);
    if (identity.email !== resolved.actor.email.trim().toLowerCase()) {
      getLogger().warn(
        { sessionId: resolved.sessionId, userId: resolved.actor.userId },
        'Access identity does not match the session user; treating the request as signed out',
      );
      return null;
    }
    return resolved;
  } catch {
    // Expired, forged, for another application or unverifiable: no session.
    return null;
  }
}
