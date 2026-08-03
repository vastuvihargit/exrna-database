import type { Metadata } from 'next';

import { ReviewDashboard } from '@/components/review/review-dashboard';

export const metadata: Metadata = { title: 'Reviews' };

export default function ReviewsPage() {
  return <ReviewDashboard />;
}
