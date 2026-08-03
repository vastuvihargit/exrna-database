import { withRouteHandler } from '@/server/http/route-handler';
import { ok } from '@/server/http/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness probe — used by the Docker HEALTHCHECK and the load balancer.
 * Unauthenticated by necessity, so it exposes nothing about the system's internals.
 */
export const GET = withRouteHandler(async () =>
  ok({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }),
);
