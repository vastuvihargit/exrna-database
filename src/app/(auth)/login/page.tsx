import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LoginForm } from '@/components/auth/login-form';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-lg" />}>
      <LoginForm />
    </Suspense>
  );
}
