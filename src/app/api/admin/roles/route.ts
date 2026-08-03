import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { userService } from '@/server/services/user.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Roles available to grant. Requires company-scope `user.manage`. */
export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  const roles = await userService.listRoles(actor);
  return ok(
    roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      rank: role.rank,
      scopeTypes: role.scopeTypes,
      permissions: role.permissions,
      maxConfidentiality: role.maxConfidentiality,
      isSystem: role.isSystem,
    })),
  );
});
