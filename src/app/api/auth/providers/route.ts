import { withRouteHandler } from '@/server/http/route-handler';
import { ok } from '@/server/http/api-response';
import { getEnv } from '@/server/config/env';
import { isGoogleConfigured } from '@/server/auth/google-oauth';
import * as organizationRepository from '@/server/repositories/organization.repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which sign-in methods the login page should offer, plus the company domains to show
 * in the "use your work address" hint. Unauthenticated by necessity; it reveals nothing
 * beyond what the login page already displays.
 */
export const GET = withRouteHandler(async () => {
  const env = getEnv();
  const domains = await organizationRepository.getSignInDomains(env.COMPANY_EMAIL_DOMAINS);

  return ok({
    password: true,
    google: isGoogleConfigured(),
    microsoft: false,
    companyEmailDomains: domains,
    appName: env.APP_NAME,
  });
});
