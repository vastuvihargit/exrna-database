/**
 * Developer user switching — **development builds only**.
 *
 * The problem this solves: testing a permission system means being eight different
 * people, and the honest way to do that is eight real sessions. Logging in and out
 * through the password form works but is slow enough that people stop doing it, and a
 * permission bug found in week three is one nobody was checking for in week one.
 *
 * So this issues a **real session** through the same `issueSession` the password login
 * uses. Everything downstream — permission checks, audit records, the immediate
 * deactivation guarantee — behaves exactly as it would for a genuine sign-in, because
 * as far as the rest of the system is concerned it *is* one. A switcher that faked an
 * Actor in React state would prove nothing about the thing it exists to test.
 *
 * Three properties keep that from being a back door:
 *
 *   1. **Every entry point calls `assertDevToolingEnabled()` first**, which is false in
 *      production unconditionally, and the process refuses to boot if a production
 *      configuration even asks for it.
 *   2. **The target must be in the list this service itself publishes.** The API cannot
 *      mint a session for an arbitrary id — "switch to any user you can name" and
 *      "switch to one of the seeded development accounts" are very different features,
 *      and only the second one is wanted.
 *   3. **No credential ever moves.** Passwords are not read, not compared and not
 *      returned; the session token reaches the browser only as the same HttpOnly cookie
 *      a real login sets, and never appears in a response body.
 */
import { assertDevToolingEnabled } from '@/server/config/dev-mode';
import { NotFoundError, ValidationError } from '@/server/errors/app-error';
import { issueSession, revokeSession, type IssuedSession } from '@/server/auth/session.service';
import { auditService } from '@/server/audit/audit.service';
import * as userRepository from '@/server/repositories/user.repository';
import * as roleRepository from '@/server/repositories/role.repository';
import * as departmentRepository from '@/server/repositories/department.repository';
import { getLogger } from '@/server/logging/logger';
import type { RequestMeta } from '@/server/http/request-meta';

/** Nobody seeds hundreds of development accounts, and an unbounded list is a foot-gun. */
const MAX_CANDIDATES = 50;

export interface DevUserSummary {
  id: string;
  name: string;
  email: string;
  departmentName: string | null;
  isSuperAdmin: boolean;
  /** Highest-ranked role, which is what the switcher shows as "the" role. */
  primaryRole: { key: string; name: string; rank: number } | null;
  allRoles: Array<{ key: string; name: string; scopeType: string }>;
}

/**
 * Every account a developer may switch into.
 *
 * Active users only: switching into a deactivated account would produce a session that
 * `resolveSession` kills on the very next request, which looks like a bug in the
 * switcher rather than the correct behaviour it actually is.
 */
export async function listSwitchableUsers(): Promise<DevUserSummary[]> {
  assertDevToolingEnabled();

  const { items } = await userRepository.list({
    filter: {},
    status: 'active',
    page: 1,
    pageSize: MAX_CANDIDATES,
  });

  const departments = new Map<string, string>();
  for (const department of await departmentRepository.list({}).catch(() => [])) {
    departments.set(department.id, department.name);
  }

  const summaries = await Promise.all(
    items.map(async (user): Promise<DevUserSummary> => {
      // `listGrantsForUser` already excludes revoked grants.
      const active = await roleRepository.listGrantsForUser(user.id).catch(() => []);

      // Highest rank wins. A person who is both a Reviewer and a Department Head is,
      // for the purpose of a one-line label, a Department Head.
      const primary = active.reduce<(typeof active)[number] | null>(
        (best, grant) => (best === null || grant.rank > best.rank ? grant : best),
        null,
      );

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        departmentName: user.departmentId ? (departments.get(user.departmentId) ?? null) : null,
        isSuperAdmin: user.isSuperAdmin,
        primaryRole: primary
          ? { key: primary.roleKey, name: primary.roleName, rank: primary.rank }
          : null,
        allRoles: active.map((grant) => ({
          key: grant.roleKey,
          name: grant.roleName,
          scopeType: grant.scopeType,
        })),
      };
    }),
  );

  // Most privileged first: it is the order somebody debugging a permission problem
  // wants, and it puts the super admin where they can find it.
  return summaries.sort((a, b) => {
    if (a.isSuperAdmin !== b.isSuperAdmin) return a.isSuperAdmin ? -1 : 1;
    return (b.primaryRole?.rank ?? 0) - (a.primaryRole?.rank ?? 0);
  });
}

export interface SwitchResult {
  session: IssuedSession;
  user: DevUserSummary;
}

/**
 * Issues a real session for one of the switchable users.
 *
 * `currentSessionId` is revoked rather than abandoned, so switching does not leave a
 * trail of live sessions behind — which would quietly undermine the "sign out
 * everywhere" feature the sessions page offers.
 */
export async function switchToUser(input: {
  targetUserId: string;
  currentSessionId?: string | null;
  meta: RequestMeta;
}): Promise<SwitchResult> {
  assertDevToolingEnabled();

  if (typeof input.targetUserId !== 'string' || !/^[a-f0-9]{24}$/i.test(input.targetUserId)) {
    throw new ValidationError('A user id is required');
  }

  // The allow-list check, and the reason this is not arbitrary impersonation: the target
  // must be one of the accounts `listSwitchableUsers` publishes. Resolving the id
  // directly against the database instead would accept any ObjectId in the collection.
  const candidates = await listSwitchableUsers();
  const target = candidates.find((candidate) => candidate.id === input.targetUserId);
  if (!target) {
    throw new NotFoundError('That user is not available for development switching');
  }

  const user = await userRepository.findById(target.id);
  if (!user) throw new NotFoundError('That user is not available for development switching');

  if (input.currentSessionId) {
    await revokeSession(input.currentSessionId, 'logout').catch(() => undefined);
  }

  const session = await issueSession({
    userId: user.id,
    organizationId: user.organizationId,
    provider: 'dev-switcher',
    meta: input.meta,
  });

  // Audited as a login, because that is what it is. The provider field is what makes it
  // greppable afterwards: a session that appeared without a password is worth being able
  // to find, even in a development database.
  await auditService.recordAnonymous(input.meta, {
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    entityLabel: user.email,
    organizationId: user.organizationId,
    actorEmail: user.email,
    severity: 'notice',
    newValue: { provider: 'dev-switcher' },
  });

  getLogger().warn(
    { targetUserId: user.id, targetEmail: user.email },
    'DEV SWITCHER: issued a session without authentication (development build only)',
  );

  return { session, user: target };
}

export const devSwitcherService = { listSwitchableUsers, switchToUser };
