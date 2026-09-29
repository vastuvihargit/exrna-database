import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { ExternalPasswordRecovery } from '@/components/auth/external-password-recovery';
import { isPasswordRecoveryAvailable } from '@/server/auth/access-session';

export const metadata: Metadata = { title: 'Reset your password' };
export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  if (!isPasswordRecoveryAvailable()) return <ExternalPasswordRecovery />;
  return <ForgotPasswordForm />;
}
