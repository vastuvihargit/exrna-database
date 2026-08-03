import { Badge } from '@/components/ui/badge';

const VARIANTS = {
  active: { variant: 'success' as const, label: 'Active' },
  invited: { variant: 'secondary' as const, label: 'Invited' },
  suspended: { variant: 'warning' as const, label: 'Suspended' },
  deactivated: { variant: 'destructive' as const, label: 'Deactivated' },
};

export function UserStatusBadge({ status }: { status: keyof typeof VARIANTS }) {
  const config = VARIANTS[status] ?? VARIANTS.invited;
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
