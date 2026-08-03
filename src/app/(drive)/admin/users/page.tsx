import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { UsersManager } from '@/components/admin/users-manager';
import { requireActor } from '@/server/http/page-guard';
import { getEnv } from '@/server/config/env';
import * as organizationRepository from '@/server/repositories/organization.repository';

export const metadata: Metadata = { title: 'Employees' };
export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const actor = await requireActor('/admin/users');

  const canManage =
    actor.isSuperAdmin ||
    actor.grants.some(
      (grant) =>
        grant.permissions.includes('user.manage') &&
        (grant.scopeType === 'company' || grant.scopeType === 'department'),
    );

  if (!canManage) redirect('/access-denied?reason=permission');

  const env = getEnv();
  const domains = await organizationRepository.getSignInDomains(env.COMPANY_EMAIL_DOMAINS);

  return <UsersManager companyDomains={domains} />;
}
