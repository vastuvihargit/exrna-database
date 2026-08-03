import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toSessionDto } from '@/server/http/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The current actor. Returns 401 when there is no live session — the UI treats that as "signed out". */
export const GET = withAuthenticatedRoute(async (_request, { actor }) => ok(toSessionDto(actor)));
