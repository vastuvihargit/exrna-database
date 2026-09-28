import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { ExternalPasswordRecovery } from '@/components/auth/external-password-recovery';
import { Skeleton } from '@/components/ui/skeleton';
import { isPasswordRecoveryAvailable } from '@/server/auth/access-session';

export const metadata: Metadata = { title: 'Choose a new password' };
export const dynamic = 'force-dynamic';

export default function ResetPasswordPage() {
  if (!isPasswordRecoveryAvailable()) return <ExternalPasswordRecovery />;
  return (
    <Suspense fallback={<Skeleton className="h-80 w-full rounded-lg" />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
