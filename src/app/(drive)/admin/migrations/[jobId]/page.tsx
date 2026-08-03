import type { Metadata } from 'next';

import { requireActor } from '@/server/http/page-guard';
import { MigrationDetail } from '@/components/admin/migration-detail';

export const metadata: Metadata = { title: 'Migration' };
export const dynamic = 'force-dynamic';

export default async function AdminMigrationPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  await requireActor('/admin/migrations');
  const { jobId } = await params;
  return <MigrationDetail jobId={jobId} />;
}
