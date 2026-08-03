import type { Metadata } from 'next';
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Access denied' };
export const dynamic = 'force-dynamic';

const REASONS: Record<string, string> = {
  permission: 'Your account does not have permission to view this area.',
  deactivated: 'Your account is not active. Contact your administrator.',
  not_provisioned: 'Your account has not been set up yet. Contact your administrator for access.',
};

export default async function AccessDeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-5 text-warning" aria-hidden="true" />
          Access denied
        </CardTitle>
        <CardDescription>
          {(reason && REASONS[reason]) ?? 'You do not have access to this area.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Deliberately vague about what exists here — see the threat model on 403/404 oracles. */}
        <p className="text-sm text-muted-foreground">
          If you believe this is a mistake, ask your department head or a company administrator to
          review your access.
        </p>
        <Button variant="outline" className="w-full" asChild>
          <Link href="/home">Back to home</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
