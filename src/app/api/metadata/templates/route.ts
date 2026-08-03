import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { templateForCategory } from '@/server/domain/research-metadata';
import { templateService } from '@/server/services/template.service';
import { FILE_CATEGORIES } from '@/server/domain/file-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  category: z.enum(FILE_CATEGORIES).optional(),
});

/**
 * The metadata form definition.
 *
 * Served rather than duplicated in the client so there is exactly one description of
 * what a field is called, what type it is and which values it accepts. A second copy in
 * the frontend would drift, and the drift would show up as a form that offers an option
 * the server then rejects.
 */
export const GET = withAuthenticatedRoute(async (request: NextRequest, { actor }) => {
  const { category } = querySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  // Read through the template service so an administrator's edits reach the form. The
  // *fields* still come from the code allow-list — a template may rearrange them, never
  // invent one.
  const { fields, templates } = await templateService.getMetadataTemplates(actor.organizationId);
  const suggestedKey = category ? templateForCategory(category).key : null;

  return ok({
    fields,
    templates,
    // A suggestion that no longer exists after an edit would leave the form with no
    // template selected at all.
    suggested:
      suggestedKey && templates.some((template) => template.key === suggestedKey)
        ? suggestedKey
        : (templates[0]?.key ?? null),
  });
});
