import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 404 is also what an authorized-but-invisible resource returns, so the copy avoids
 * confirming or denying that anything exists at this address.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md text-center">
        <FileQuestion className="mx-auto size-10 text-muted-foreground" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-semibold">Not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page or item is not available. It may have been moved or deleted, or you may not have
          access to it.
        </p>
        <Button asChild className="mt-6">
          <Link href="/home">Back to home</Link>
        </Button>
      </div>
    </div>
  );
}
