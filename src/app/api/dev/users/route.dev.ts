import { withRouteHandler } from '@/server/http/route-handler';
import { ok } from '@/server/http/api-response';
import { assertDevToolingEnabled } from '@/server/config/dev-mode';
import { devSwitcherService } from '@/server/services/dev-switcher.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Accounts the 🛠 DEV switcher may switch into. **Development builds only.**
 *
 * Unauthenticated on purpose: you need the list while signed out, which is the moment
 * the switcher is most useful. That is only acceptable because `assertDevToolingEnabled`
 * makes the whole route a 404 in production — the gate is the environment, not the
 * session.
 *
 * What it returns is names, addresses, departments and role labels for seeded
 * development accounts. No password hashes, no session tokens, no reset tokens — the
 * repository's `toUserRecord` does not carry them and the base `toJSON` transform strips
 * them regardless.
 */
export const GET = withRouteHandler(async () => {
  assertDevToolingEnabled();

  const users = await devSwitcherService.listSwitchableUsers();
  return ok({ users });
});
