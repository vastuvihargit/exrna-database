/**
 * Which front door a deployment uses to establish identity.
 *
 *   cloudflare_access  Cloudflare Access at the edge; every request carries a signed Access
 *                      assertion that is re-verified against the session (`access-session.ts`).
 *   google_oauth       The application's own Google Workspace sign-in (`google-oauth.ts`):
 *                      authorization-code flow with PKCE, state and nonce, the ID token verified
 *                      server-side. No Access dependency: `CF_ACCESS_*` must be unset.
 *
 * Unset keeps the behaviour that predates the switch: Access when `CF_ACCESS_*` are both set,
 * otherwise password / optional Google sign-in on the Node deployment.
 *
 * Either way, the identity provider only answers "who is this". Whether they have an account,
 * whether it is active and what they may do stay with the application — `completeOAuthLogin`,
 * `resolveSession`, roles and ACLs are the same code on both paths.
 *
 * Pure on purpose: both `env.ts` (the shared schema) and `env.worker.ts` (the Worker's boot
 * gate) apply these rules, and neither may import the other.
 */
export const AUTH_PROVIDERS = ['cloudflare_access', 'google_oauth'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

/** The redirect URI registered in Google Cloud Console for `google_oauth` mode. */
export const GOOGLE_OAUTH_CALLBACK_PATH = '/api/auth/google/callback';

export function googleOAuthRedirectUri(appUrl: string): string {
  return new URL(GOOGLE_OAUTH_CALLBACK_PATH, appUrl).toString();
}

export interface SignInConfig {
  NODE_ENV: string;
  APP_URL: string;
  AUTH_PROVIDER?: AuthProvider | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GOOGLE_WORKSPACE_DOMAIN?: string | undefined;
  GOOGLE_REDIRECT_URI?: string | undefined;
  COMPANY_EMAIL_DOMAINS?: readonly string[] | undefined;
  CF_ACCESS_TEAM_DOMAIN?: string | undefined;
  CF_ACCESS_AUD?: string | undefined;
}

export interface SignInConfigIssue {
  path: string;
  message: string;
}

const present = (value: string | undefined) => Boolean(value?.trim());

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Every reason this sign-in configuration cannot be used. Empty when it can. */
export function signInConfigIssues(v: SignInConfig): SignInConfigIssue[] {
  const issues: SignInConfigIssue[] = [];

  if (v.AUTH_PROVIDER === 'google_oauth') {
    if (!present(v.GOOGLE_CLIENT_ID)) {
      issues.push({ path: 'GOOGLE_OAUTH_CLIENT_ID', message: 'is required when AUTH_PROVIDER is "google_oauth"' });
    }
    if (!present(v.GOOGLE_CLIENT_SECRET)) {
      issues.push({ path: 'GOOGLE_OAUTH_CLIENT_SECRET', message: 'is required when AUTH_PROVIDER is "google_oauth"' });
    }
    // The `hd` claim is checked against it: an address on the company domain that is not a
    // Workspace account (a consumer Google account registered with a company address) must
    // not be able to sign in.
    if (!present(v.GOOGLE_WORKSPACE_DOMAIN)) {
      issues.push({ path: 'GOOGLE_WORKSPACE_DOMAIN', message: 'is required when AUTH_PROVIDER is "google_oauth"' });
    } else if (
      v.COMPANY_EMAIL_DOMAINS &&
      !v.COMPANY_EMAIL_DOMAINS.some(
        (domain) => domain.trim().toLowerCase() === v.GOOGLE_WORKSPACE_DOMAIN!.trim().toLowerCase(),
      )
    ) {
      // Sign-in requires the address to be on the Workspace domain *and* on the allow-list;
      // with the two disjoint, nobody could sign in and the deployment would look healthy.
      issues.push({
        path: 'COMPANY_EMAIL_DOMAINS',
        message: 'must include GOOGLE_WORKSPACE_DOMAIN when AUTH_PROVIDER is "google_oauth"',
      });
    }
    // The state, verifier and nonce cookies are set on APP_URL's host; a callback on any other
    // origin would arrive without them and every sign-in would fail as "expired".
    if (present(v.GOOGLE_REDIRECT_URI) && !sameOrigin(v.GOOGLE_REDIRECT_URI!, v.APP_URL)) {
      issues.push({
        path: 'GOOGLE_REDIRECT_URI',
        message: 'must be on the same origin as APP_URL when AUTH_PROVIDER is "google_oauth"',
      });
    }
    // Refused rather than ignored: with both configured, which one is actually protecting the
    // deployment would depend on reading this code.
    if (present(v.CF_ACCESS_TEAM_DOMAIN) || present(v.CF_ACCESS_AUD)) {
      issues.push({
        path: 'CF_ACCESS_TEAM_DOMAIN',
        message: 'must be unset (with CF_ACCESS_AUD) when AUTH_PROVIDER is "google_oauth"',
      });
    }
    // Session and OAuth cookies are only marked Secure over https.
    if (v.NODE_ENV !== 'development' && v.NODE_ENV !== 'test' && !v.APP_URL.startsWith('https://')) {
      issues.push({ path: 'APP_URL', message: 'must use https:// when AUTH_PROVIDER is "google_oauth"' });
    }
  }

  if (v.AUTH_PROVIDER === 'cloudflare_access' && !(present(v.CF_ACCESS_TEAM_DOMAIN) && present(v.CF_ACCESS_AUD))) {
    issues.push({
      path: 'CF_ACCESS_AUD',
      message: 'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required when AUTH_PROVIDER is "cloudflare_access"',
    });
  }

  return issues;
}
