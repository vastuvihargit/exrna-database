import type { Metadata } from 'next';

import { AccountSecurity } from '@/components/account/account-security';
import { requireActor } from '@/server/http/page-guard';

export const metadata: Metadata = { title: 'Account & security' };
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const actor = await requireActor('/account');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account &amp; security</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {actor.name} · {actor.email}
        </p>
      </div>

      <AccountSecurity
        roles={actor.grants.map((grant) => ({ name: grant.roleName, scopeType: grant.scopeType }))}
      />
    </div>
  );
}
