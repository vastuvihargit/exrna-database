import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  Building2,
  CheckCircle2,
  Clock,
  FlaskConical,
  FolderClosed,
  Home,
  Package,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export interface NavSection {
  id: string;
  label?: string;
  items: NavItem[];
  /**
   * Hides the section from people who cannot use it.
   *
   * A rendering hint, never a control: the page guard and every API route re-derive the
   * same permission server-side. Hiding the entry only avoids offering a dead end.
   */
  requiresPermission?: string;
}

/**
 * Labels match the heading of the page they open.
 *
 * Somebody who clicks "Department drives" and lands on a page headed "Department drives"
 * knows they arrived; a label that paraphrases its destination makes people wonder
 * whether they clicked the right thing.
 */
export const navSections: NavSection[] = [
  {
    id: 'primary',
    items: [
      { label: 'Home', href: '/home', icon: Home },
      { label: 'My Drive', href: '/my-drive', icon: FolderClosed },
      { label: 'Department drives', href: '/departments', icon: Building2 },
      { label: 'Project drives', href: '/projects', icon: FlaskConical },
    ],
  },
  {
    id: 'discovery',
    label: 'Find',
    items: [
      { label: 'Search', href: '/search', icon: Search },
      { label: 'Shared with me', href: '/shared', icon: Share2 },
      { label: 'Recent', href: '/recent', icon: Clock },
      { label: 'Starred', href: '/starred', icon: Star },
    ],
  },
  {
    id: 'governance',
    label: 'Review',
    items: [
      { label: 'Pending reviews', href: '/reviews', icon: ShieldCheck },
      { label: 'Approved files', href: '/approved', icon: CheckCircle2 },
    ],
  },
  {
    id: 'inventory',
    label: 'Laboratory',
    requiresPermission: 'inventory.view',
    items: [{ label: 'Inventory', href: '/inventory', icon: Package }],
  },
  {
    id: 'lifecycle',
    items: [
      { label: 'Archive', href: '/archive', icon: Archive },
      { label: 'Trash', href: '/trash', icon: Trash2 },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [{ label: 'Admin', href: '/admin', icon: Settings }],
  },
];
