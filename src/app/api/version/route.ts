import { withRouteHandler } from '@/server/http/route-handler';
import { ok } from '@/server/http/api-response';
import { getEnv } from '@/server/config/env';
import { CURRENT_PHASE } from '@/lib/build-info';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRouteHandler(async () => {
  const env = getEnv();
  return ok({
    name: env.APP_NAME,
    environment: env.NODE_ENV,
    // Injected at build time by the Docker build (ARG GIT_SHA).
    commit: process.env.GIT_SHA ?? 'dev',
    phase: CURRENT_PHASE,
  });
});
