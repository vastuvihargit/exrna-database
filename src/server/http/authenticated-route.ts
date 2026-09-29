/**
 * Authenticated route wrapper.
 *
 * Every protected API route is built with this. It performs, in order:
 *   1. session resolution (which re-checks user status on every request) and, when Cloudflare
 *      Access is in front, verification that the request's Access assertion is for the same user
 *   2. CSRF validation for state-changing methods
 *   3. a per-actor rate limit
 *
 * A route that forgets any of these cannot exist, because the handler signature
 * requires an Actor that only this wrapper can produce.
 */
import type { NextRequest } from 'next/server';
import { UnauthenticatedError } from '@/server/errors/app-error';
import { enforce, RATE_LIMITS } from '@/server/auth/rate-limit';
import { assertCsrf } from '@/server/auth/session.service';
import { resolveRequestSession } from '@/server/auth/access-session';
import type { Actor } from '@/server/permissions/actor';
import { withRouteHandler, type RequestContext } from './route-handler';
import { CSRF_HEADER, SESSION_COOKIE } from './cookies';
import type { RequestMeta } from './request-meta';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthenticatedContext<TParams> {
  params: TParams;
  requestContext: RequestContext;
  actor: Actor;
  meta: RequestMeta;
}

type AuthenticatedHandler<TParams> = (
  request: NextRequest,
  context: AuthenticatedContext<TParams>,
) => Promise<Response> | Response;

export function withAuthenticatedRoute<TParams = Record<string, string>>(
  handler: AuthenticatedHandler<TParams>,
) {
  return withRouteHandler<TParams>(async (request, { params, requestContext }) => {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const resolved = await resolveRequestSession(token, request.headers);

    if (!resolved) throw new UnauthenticatedError();

    if (!SAFE_METHODS.has(request.method)) {
      // Origin check first: a same-site check is cheap and catches the common case
      // before the token comparison.
      assertSameOrigin(request);
      await assertCsrf(resolved.csrfTokenHash, request.headers.get(CSRF_HEADER) ?? undefined);
    }

    await enforce(`api:user:${resolved.actor.userId}`, RATE_LIMITS.authenticated);

    const meta: RequestMeta = {
      requestId: requestContext.requestId,
      ip: requestContext.ip,
      userAgent: requestContext.userAgent,
      origin: request.headers.get('origin'),
    };

    return handler(request, { params, requestContext, actor: resolved.actor, meta });
  });
}

/**
 * Rejects a state-changing request whose Origin is not this application.
 * `Sec-Fetch-Site` is honoured where the browser sends it; Origin is the fallback.
 */
function assertSameOrigin(request: NextRequest): void {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new UnauthenticatedError('Cross-site request rejected');
  }

  const origin = request.headers.get('origin');
  if (!origin) return; // Same-origin form posts may omit it; the CSRF token still applies.

  const requestUrl = new URL(request.url);
  const originUrl = (() => {
    try {
      return new URL(origin);
    } catch {
      return null;
    }
  })();

  if (!originUrl || originUrl.host !== requestUrl.host) {
    throw new UnauthenticatedError('Cross-site request rejected');
  }
}

/** For routes that must know the actor if present but do not require one. */
export async function optionalActor(request: NextRequest): Promise<Actor | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const resolved = await resolveRequestSession(token, request.headers);
  return resolved?.actor ?? null;
}
