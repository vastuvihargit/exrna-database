'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary.
 *
 * `digest` is the only server detail shown: the underlying message may contain
 * internal information and is deliberately not surfaced.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Application error', { digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md text-center">
        <AlertTriangle className="mx-auto size-10 text-destructive" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The page could not be displayed. Try again, and if it keeps happening quote the reference
          below when contacting your administrator.
        </p>
        {error.digest ? (
          <p className="mt-3 font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>
        ) : null}
        <div className="mt-6 flex justify-center gap-3">
          <Button onClick={reset}>Try again</Button>
          <Button variant="outline" asChild>
            <a href="/home">Back to home</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
