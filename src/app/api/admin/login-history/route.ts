import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import * as loginHistory from '@/server/repositories/login-history.repository';
import { loginHistoryQuerySchema } from '@/server/validation/user.schemas';
import { parseQuery } from '@/server/validation/common';
import { toLoginHistoryDto } from '@/server/http/dto';
import type { LoginOutcome } from '@/server/db/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Company-wide authentication attempts — the view that makes credential stuffing visible. */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  assertCompanyPermission(actor, 'audit.view');

  const query = parseQuery(loginHistoryQuerySchema, request.url);
  const { items, total } = await loginHistory.query({
    ...(query.email ? { email: query.email } : {}),
    ...(query.outcome ? { outcome: query.outcome as LoginOutcome } : {}),
    page: query.page,
    pageSize: query.pageSize,
  });

  return ok(items.map(toLoginHistoryDto), {
    meta: { page: query.page, pageSize: query.pageSize, total },
  });
});
