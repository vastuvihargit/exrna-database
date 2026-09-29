import Link from 'next/link';

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EXTERNAL_PASSWORD_RECOVERY_MESSAGE } from '@/server/auth/access-session';

/**
 * Shown on /forgot-password and /reset-password where the application does not own the
 * password (Cloudflare Access, or any Worker). The API refuses the same requests with the same
 * message; this page just says it before anyone fills in a form.
 */
export function ExternalPasswordRecovery() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Password recovery is handled by your company sign-in</CardTitle>
        <CardDescription>{EXTERNAL_PASSWORD_RECOVERY_MESSAGE}</CardDescription>
      </CardHeader>
      <div className="px-6 pb-6 text-sm">
        <Link href="/login" className="underline underline-offset-4">
          Back to sign in
        </Link>
      </div>
    </Card>
  );
}
