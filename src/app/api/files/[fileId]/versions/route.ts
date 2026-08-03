import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toVersionDto } from '@/server/http/dto';
import { fileService } from '@/server/services/file.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Version history. Every version ever uploaded is listed, including superseded ones —
 * that permanence is what makes "which version was approved?" answerable.
 */
export const GET = withAuthenticatedRoute<{ fileId: string }>(
  async (_request, { actor, params }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    const versions = await fileService.listVersions(actor, fileId);
    return ok(versions.map(toVersionDto));
  },
);
