import { Skeleton } from '@/components/ui/skeleton';

export default function HomeLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading home">
      <div className="space-y-2">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-56 w-full rounded-lg" />
      <Skeleton className="h-44 w-full rounded-lg" />
    </div>
  );
}
