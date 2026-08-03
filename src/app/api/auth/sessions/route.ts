import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { listSessions } from '@/server/auth/session.service';
import { toSessionListDto } from '@/server/http/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Device list for the current user — their own sessions only, never anyone else's. */
export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  const sessions = await listSessions(actor.userId);
  return ok(sessions.map((session) => toSessionListDto(session, actor.sessionId)));
});
