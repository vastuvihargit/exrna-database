import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { ok } from '@/server/http/api-response';
import { toFileDto } from '@/server/http/dto';
import { fileService } from '@/server/services/file.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuthenticatedRoute<{ fileId: string }>(
  async (_request, { actor, params, meta }) => {
    const fileId = objectIdSchema.parse(params.fileId);
    return ok(toFileDto(await fileService.restoreFile(actor, fileId, meta)));
  },
);
