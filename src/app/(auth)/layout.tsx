import type { ReactNode } from 'react';
import { Dna } from 'lucide-react';

/** Centred, chrome-free layout for the unauthenticated pages. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 p-6">
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
        <Dna className="size-6 text-primary" aria-hidden="true" />
        Biotech Research Drive
      </div>
      <main id="main-content" className="w-full max-w-md">
        {children}
      </main>
      <p className="mt-8 max-w-md text-center text-xs text-muted-foreground">
        Internal system. Access is limited to authorized company employees and all activity is logged.
      </p>
    </div>
  );
}
