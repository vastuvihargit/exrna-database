import { Suspense } from 'react';
import type { Metadata } from 'next';

import { Skeleton } from '@/components/ui/skeleton';
import { SearchView } from '@/components/search/search-view';

export const metadata: Metadata = { title: 'Search' };

/**
 * `useSearchParams` opts the subtree into client-side rendering, so the Suspense
 * boundary is required — without it Next refuses to build this page.
 */
export default function SearchPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <SearchView />
    </Suspense>
  );
}
