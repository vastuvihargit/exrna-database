import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { driveService } from '@/server/services/drive.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Drive navigation: My Drive plus every department and project drive the actor may open. */
export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  return ok(await driveService.listDrives(actor));
});
