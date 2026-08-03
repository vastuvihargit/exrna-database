import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { withRouteHandler } from '@/server/http/route-handler';
import { getEnv } from '@/server/config/env';
import { setSessionCookies } from '@/server/http/cookies';
import { completeGoogleLogin } from '@/server/auth/google-oauth';
import { authService } from '@/server/services/auth.service';
import { safeCompare } from '@/server/auth/tokens';
import { getLogger } from '@/server/logging/logger';
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
} from '../../google/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * OAuth callback.
 *
 * Failures redirect to /login with a coarse error code rather than rendering a message
 * from the provider: a verbatim upstream error is both a poor experience and a way to
 * reflect attacker-controlled text into the page.
 */
export const GET = withRouteHandler(async (request: NextRequest, { requestContext }) => {
  const env = getEnv();
  const url = new URL(request.url);
  const loginUrl = new URL('/login', env.APP_URL);

  const fail = (reason: string) => {
    loginUrl.searchParams.set('error', reason);
    const response = NextResponse.redirect(loginUrl);
    clearOAuthCookies(response, env.isProduction);
    return response;
  };

  if (url.searchParams.get('error')) return fail('oauth_cancelled');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const codeVerifier = request.cookies.get(OAUTH_VERIFIER_COOKIE)?.value;
  const expectedNonce = request.cookies.get(OAUTH_NONCE_COOKIE)?.value;

  if (!code || !state || !expectedState || !codeVerifier || !expectedNonce) {
    return fail('oauth_state_missing');
  }
  // Constant-time: state is a secret for the duration of the flow.
  if (!safeCompare(state, expectedState)) return fail('oauth_state_mismatch');

  try {
    const identity = await completeGoogleLogin({ code, codeVerifier, expectedNonce });

    const session = await authService.completeOAuthLogin(
      {
        email: identity.email,
        ...(identity.name ? { name: identity.name } : {}),
        providerAccountId: identity.subject,
        provider: 'google',
      },
      {
        requestId: requestContext.requestId,
        ip: requestContext.ip,
        userAgent: requestContext.userAgent,
      },
    );

    const response = NextResponse.redirect(new URL('/home', env.APP_URL));
    setSessionCookies(response, {
      token: session.token,
      csrfToken: session.csrfToken,
      expiresAt: session.absoluteExpiresAt,
    });
    clearOAuthCookies(response, env.isProduction);
    return response;
  } catch (error) {
    getLogger().warn({ err: error, requestId: requestContext.requestId }, 'Google sign-in failed');
    // "Not provisioned" is the one case worth distinguishing — it tells a legitimate
    // employee to contact an administrator instead of retrying forever.
    const reason =
      error instanceof Error && error.message.toLowerCase().includes('not been set up')
        ? 'not_provisioned'
        : 'oauth_failed';
    return fail(reason);
  }
});

function clearOAuthCookies(response: NextResponse, secure: boolean): void {
  for (const name of [OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, OAUTH_NONCE_COOKIE]) {
    response.cookies.set(name, '', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 0 });
  }
}
