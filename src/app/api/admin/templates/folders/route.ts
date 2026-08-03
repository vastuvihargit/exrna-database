import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { templateService } from '@/server/services/template.service';
import { saveFolderTemplatesSchema } from '@/server/validation/template.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Reading the folder template is not privileged — it is the folder names every employee
 * already sees in every project drive. Writing it is, and the service gates that on
 * company-scoped `access.manage`.
 */
export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  return ok(await templateService.getFolderTemplates(actor.organizationId));
});

export const PUT = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = saveFolderTemplatesSchema.parse(body);
  return ok(await templateService.saveFolderTemplates(actor, input, meta));
});
