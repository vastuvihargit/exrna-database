import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toRelatedFileDto } from '@/server/http/dto';
import { fileService } from '@/server/services/file.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Files connected to this one: identical content elsewhere, the same experiment, the
 * same sample. Filtered to what the caller may open, twice — see `listRelated`.
 */
export const GET = withAuthenticatedRoute<{ fileId: string }>(
  async (_request, { actor, params }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const related = await fileService.listRelated(actor, fileId);
    return ok(related.map(toRelatedFileDto));
  },
);
