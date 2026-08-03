'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * TanStack Query is the only place the UI talks to the API.
 *
 * The client is created inside state so each browser session gets its own cache and
 * server-rendered requests never share one across users.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Never retry an authorization or validation failure — the answer will not change.
              const status = (error as { status?: number } | null)?.status;
              if (status && status >= 400 && status < 500) return false;
              return failureCount < 2;
            },
          },
          mutations: { retry: false },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
