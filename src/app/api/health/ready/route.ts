import { withRouteHandler } from '@/server/http/route-handler';
import { ok } from '@/server/http/api-response';
import { getHealthReport } from '@/server/health/health-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Readiness probe: reports whether MongoDB is reachable and the private storage
 * volume is genuinely writable (verified by a write/read/delete round trip).
 *
 * Returns 503 when unhealthy so an orchestrator stops routing traffic; the body still
 * carries the full report so the admin UI can explain what is wrong.
 */
export const GET = withRouteHandler(async () => {
  const report = await getHealthReport();
  return ok(report, { status: report.status === 'error' ? 503 : 200 });
});
