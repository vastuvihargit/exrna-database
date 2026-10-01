import { NextResponse } from 'next/server';

import { withRouteHandler } from '@/server/http/route-handler';
import { getEnv } from '@/server/config/env';
import { beginGoogleLogin } from '@/server/auth/google-oauth';
import { isAccessEnforced } from '@/server/auth/access-session';
import { cookieSecure } from '@/server/http/cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OAUTH_STATE_COOKIE = 'bd_oauth_state';
export const OAUTH_VERIFIER_COOKIE = 'bd_oauth_verifier';
export const OAUTH_NONCE_COOKIE = 'bd_oauth_nonce';

/**
 * Starts Google Workspace sign-in.
 *
 * state / PKCE verifier / nonce are stored in short-lived HttpOnly cookies rather than
 * server-side state: they must be bound to *this browser*, and a cookie is exactly that
 * binding. They live for 10 minutes and are cleared by the callback.
 */
export const GET = withRouteHandler(async () => {
  const env = getEnv();
  // Access is the sign-in method when it is configured; this flow would be a second one.
  if (isAccessEnforced()) return NextResponse.redirect(new URL('/api/auth/access', env.APP_URL));
  // A hint for the account picker only; the ID token's `hd` and email domain are what is checked.
  const hint =
    env.AUTH_PROVIDER === 'google_oauth' ? env.GOOGLE_WORKSPACE_DOMAIN : env.COMPANY_EMAIL_DOMAINS[0];
  const start = await beginGoogleLogin(hint);

  const response = NextResponse.redirect(start.authorizationUrl);
  const options = {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 600,
  };

  response.cookies.set(OAUTH_STATE_COOKIE, start.state, options);
  response.cookies.set(OAUTH_VERIFIER_COOKIE, start.codeVerifier, options);
  response.cookies.set(OAUTH_NONCE_COOKIE, start.nonce, options);

  return response;
});
