import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { withAuthenticatedRoute } from '@/server/http/authenticated-route';
import { created, ok } from '@/server/http/api-response';
import { assertCompanyPermission } from '@/server/permissions/authorize';
import { storageMigrationService } from '@/server/services/storage-migration.service';
import { objectIdSchema } from '@/server/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Storage migration jobs.
 *
 * ⚠ Not `/api/admin/migrations`, which is the *inbound* Drive importer. Distinct path,
 * distinct models, distinct audit prefix — an operator has to be able to tell "we imported
 * from a Drive" from "we moved company files into the Shared Drive".
 *
 * Gated on company-scoped `access.manage` inside the service, a higher bar than the
 * `audit.view` that guards read-only status. Moving the company's research between storage
 * systems is not something a department-scoped administrator does.
 */
const selectionSchema = z
  .object({
    folderIds: z.array(objectIdSchema).max(200).optional(),
    includeDescendants: z.boolean().optional(),
    departmentIds: z.array(objectIdSchema).max(100).optional(),
    projectIds: z.array(objectIdSchema).max(100).optional(),
    extensions: z.array(z.string().max(20)).max(50).optional(),
    uploadedAfter: z.coerce.date().optional(),
    uploadedBefore: z.coerce.date().optional(),
    versionIds: z.array(objectIdSchema).max(1000).optional(),
    currentVersionsOnly: z.boolean().optional(),
  })
  .strict();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  mode: z.enum(['dry_run', 'migrate', 'verify_only', 'rollback']),
  selection: selectionSchema,
});

export const GET = withAuthenticatedRoute(async (_request, { actor }) => {
  assertCompanyPermission(actor, 'access.manage');
  const jobs = await storageMigrationService.listJobs(actor);
  return ok(jobs);
});

export const POST = withAuthenticatedRoute(async (request: NextRequest, { actor, meta }) => {
  assertCompanyPermission(actor, 'access.manage');
  const body: unknown = await request.json().catch(() => ({}));
  const input = createSchema.parse(body);

  const job = await storageMigrationService.createJob(actor, input, meta);
  return created(job);
});
