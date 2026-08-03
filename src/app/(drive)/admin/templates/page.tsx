import type { Metadata } from 'next';

import { requireActor } from '@/server/http/page-guard';
import { TemplatesManager } from '@/components/admin/templates-manager';

export const metadata: Metadata = { title: 'Templates' };
export const dynamic = 'force-dynamic';

export default async function AdminTemplatesPage() {
  // The admin layout already guards the section; this keeps the page itself honest if it
  // is ever reached another way. Write permission is enforced again in the service.
  await requireActor('/admin/templates');
  return <TemplatesManager />;
}
