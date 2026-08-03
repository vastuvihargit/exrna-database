'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { useCompleteConnect } from '@/hooks/use-migrations';

/**
 * Where Google returns after Drive consent.
 *
 * The `state` this page received must match the one stored when the flow started — the
 * standard CSRF binding, so a link someone was sent cannot attach a Drive credential to a
 * migration on their behalf. It is a *binding* check only: the API re-checks the actor's
 * permission on the job regardless of what state says.
 */
export function MigrationCallback() {
  const params = useSearchParams();
  const router = useRouter();
  const complete = useCompleteConnect();

  const [error, setError] = React.useState<string | null>(null);
  const attempted = React.useRef(false);

  React.useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const code = params.get('code');
    const state = params.get('state');
    const denied = params.get('error');

    if (denied) {
      setError('Google did not grant access. Nothing was connected.');
      return;
    }
    if (!code || !state) {
      setError('That callback is missing its authorization code.');
      return;
    }

    const expected = window.sessionStorage.getItem('migration-connect-state');
    if (!expected || expected !== state) {
      setError(
        'This authorization did not start from this browser session. Start the connection again from the migration page.',
      );
      return;
    }
    window.sessionStorage.removeItem('migration-connect-state');

    const jobId = state.split(':')[0] ?? '';
    if (!jobId) {
      setError('That callback does not name a migration.');
      return;
    }

    complete
      .mutateAsync({ jobId, code, state })
      .then(() => router.replace(`/admin/migrations/${jobId}`))
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiError ? cause.message : 'Could not complete the Google connection.',
        );
      });
    // Runs exactly once; `attempted` guards React's double-invoke in development.
  }, [params, router, complete]);

  if (error) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <AlertTriangle className="mx-auto size-8 text-destructive" aria-hidden="true" />
        <p className="font-medium">Connection not completed</p>
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" onClick={() => router.replace('/admin/migrations')}>
          Back to migrations
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      Completing the Google Drive connection…
    </div>
  );
}
