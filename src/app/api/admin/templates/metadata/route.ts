import type { NextRequest } from 'next/server';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { templateService } from '@/server/services/template.service';
import { saveMetadataTemplatesSchema } from '@/server/validation/template.schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  return ok(await templateService.getMetadataTemplates(actor.organizationId));
});

/**
 * A template may only arrange fields the codebase declares. The service rejects an
 * unknown key rather than storing it — a stored key would become a MongoDB dotted path
 * under `File.metadata` the first time somebody filled the form in.
 */
export const PUT = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  const body: unknown = await request.json().catch(() => ({}));
  const input = saveMetadataTemplatesSchema.parse(body);
  return ok(await templateService.saveMetadataTemplates(actor, input, meta));
});
