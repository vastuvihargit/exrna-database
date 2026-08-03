import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { userService } from '@/server/services/user.service';
import { parseQuery } from '@/server/validation/common';
import { listUsersQuerySchema } from '@/server/validation/user.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Employee directory — identity and department only.
 *
 * Deliberately separate from /api/admin/users: status, quota and login timestamps are
 * administrative data and are not part of this shape at all.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const query = parseQuery(listUsersQuerySchema, request.url);

  const { items, total } = await userService.listDirectory(actor, {
    ...(query.search ? { search: query.search } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    page: query.page,
    pageSize: query.pageSize,
  });

  return ok(items, { meta: { page: query.page, pageSize: query.pageSize, total } });
});
