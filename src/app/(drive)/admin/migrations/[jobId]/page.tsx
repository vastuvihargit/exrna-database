import type { Metadata } from 'next';

import { requireActor } from '@/server/http/page-guard';
import { MigrationDetail } from '@/components/admin/migration-detail';
import { NodeOnlyNotice } from '@/components/admin/node-only-notice';
import { NODE_ONLY_FEATURES } from '@/server/http/node-only';
import { isWorkerRuntime } from '@/server/runtime';

export const metadata: Metadata = { title: 'Migration' };
export const dynamic = 'force-dynamic';

export default async function AdminMigrationPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  await requireActor('/admin/migrations');
  if (isWorkerRuntime()) return <NodeOnlyNotice feature={NODE_ONLY_FEATURES.driveImport} />;
  const { jobId } = await params;
  return <MigrationDetail jobId={jobId} />;
}
