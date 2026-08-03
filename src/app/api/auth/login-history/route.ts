import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import * as loginHistory from '@/server/repositories/login-history.repository';
import { toLoginHistoryDto } from '@/server/http/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The signed-in user's own login history. Company-wide history lives under /api/admin. */
export const GET = withAuthenticatedRoute(async (_request: NextRequest, { actor }) => {
  const entries = await loginHistory.listForUser(actor.userId, 50);
  return ok(entries.map(toLoginHistoryDto));
});
