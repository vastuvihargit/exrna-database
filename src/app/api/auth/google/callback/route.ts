/**
 * The Google OAuth redirect URI in `AUTH_PROVIDER=google_oauth` mode:
 * `${APP_URL}/api/auth/google/callback` (see `auth/auth-provider.ts`).
 *
 * The same handler as `/api/auth/callback/google`, which stays for deployments whose Google
 * client is already registered with that path. One implementation, two addresses.
 */
export { GET } from '../../callback/google/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
