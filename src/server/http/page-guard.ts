import 'server-only';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { resolveRequestSession, signInPath } from '@/server/auth/access-session';
import type { Actor } from '@/server/permissions/actor';
import { SESSION_COOKIE } from './cookies';

/**
 * Server-side page guard.
 *
 * This — not the edge middleware — is what actually protects a page: it resolves the
 * session against the database, which re-checks that the account still exists and is
 * still active on every single render.
 */
export async function requireActor(nextPath?: string): Promise<Actor> {
  const store = await cookies();
  const resolved = await resolveRequestSession(store.get(SESSION_COOKIE)?.value, await headers());

  // With Cloudflare Access in front this is the Access sign-in bridge, not the password page.
  if (!resolved) redirect(signInPath(nextPath));

  return resolved.actor;
}

/** For pages that render differently when signed in but do not require it. */
export async function getOptionalActor(): Promise<Actor | null> {
  const store = await cookies();
  const resolved = await resolveRequestSession(store.get(SESSION_COOKIE)?.value, await headers());
  return resolved?.actor ?? null;
}

/** Page-level equivalent of assertCompanyPermission — sends the user to a denial page. */
export async function requireCompanyPermission(
  actor: Actor,
  permission: Parameters<Actor['permissions']['has']>[0],
): Promise<void> {
  if (actor.isSuperAdmin) return;
  const allowed = actor.grants.some(
    (grant) => grant.scopeType === 'company' && grant.permissions.includes(permission),
  );
  if (!allowed) redirect('/access-denied?reason=permission');
}
