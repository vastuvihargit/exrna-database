import { cn } from '@/lib/utils';

/**
 * Loading placeholder. Skeletons (not spinners) are the house style for data-driven
 * screens — they preserve layout and communicate what is about to appear.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      aria-hidden="true"
      {...props}
    />
  );
}

export { Skeleton };
