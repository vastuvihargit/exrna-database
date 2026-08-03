'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, Building2, FlaskConical, Link2Off, Loader2, ShieldAlert, Trash2, User as UserIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, apiRequest } from '@/lib/api-client';
import {
  useRevokeShare,
  useSetInheritance,
  useShare,
  useShareState,
  type AccessLevel,
  type ShareTargetType,
} from '@/hooks/use-sharing';

const ACCESS_LEVELS: Array<{ value: AccessLevel; label: string; description: string }> = [
  { value: 'viewer', label: 'Viewer', description: 'Open, preview and download' },
  { value: 'commenter', label: 'Commenter', description: 'Viewer, plus leave comments' },
  { value: 'editor', label: 'Editor', description: 'Commenter, plus upload versions and edit metadata' },
  { value: 'reviewer', label: 'Reviewer', description: 'Commenter, plus perform reviews' },
  { value: 'approver', label: 'Approver', description: 'Reviewer, plus approve or reject' },
  { value: 'manager', label: 'Manager', description: 'Everything, including sharing and deletion' },
];

interface DirectoryEntry {
  id: string;
  email: string;
  name: string;
  jobTitle: string | null;
  departmentId: string | null;
}

/**
 * Internal sharing only.
 *
 * There is no "anyone with the link" and no public toggle — not omitted, but impossible:
 * every grant names a principal that exists in this organization, and the API has no
 * principal type that means "everyone".
 */
export function ShareDialog({
  targetType,
  targetId,
  targetName,
  open,
  onOpenChange,
}: {
  targetType: ShareTargetType;
  targetId: string | null;
  targetName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const state = useShareState(targetType, open ? targetId : null);
  const share = useShare();
  const revoke = useRevokeShare();
  const setInheritance = useSetInheritance();

  const [search, setSearch] = React.useState('');
  const [level, setLevel] = React.useState<AccessLevel>('viewer');
  const [selected, setSelected] = React.useState<DirectoryEntry | null>(null);

  const directory = useQuery({
    queryKey: ['directory', search] as const,
    queryFn: () =>
      apiRequest<DirectoryEntry[]>(`/api/users?search=${encodeURIComponent(search)}&pageSize=8`),
    enabled: open && search.trim().length >= 2,
  });

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setSelected(null);
      setLevel('viewer');
    }
  }, [open]);

  const direct = state.data?.entries.filter((entry) => !entry.inherited) ?? [];
  const inherited = state.data?.entries.filter((entry) => entry.inherited) ?? [];

  const grant = async (principalId: string, deny = false) => {
    if (!targetId) return;
    try {
      await share.mutateAsync({
        targetType,
        targetId,
        principalType: 'user',
        principalId,
        accessLevel: level,
        deny,
      });
      toast.success(deny ? 'Access blocked' : 'Shared');
      setSelected(null);
      setSearch('');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change sharing');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share “{targetName}”</DialogTitle>
          <DialogDescription>
            Only people in this organization can be given access. There are no public links.
          </DialogDescription>
        </DialogHeader>

        {state.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading who has access…</p>
        ) : state.error ? (
          <p className="text-sm text-destructive">
            {state.error instanceof ApiError
              ? state.error.message
              : 'Could not load the sharing settings.'}
          </p>
        ) : state.data ? (
          <div className="space-y-5">
            {state.data.confidentiality === 'restricted' ? (
              <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                This item is <strong>restricted</strong>. Role scope alone never reaches it — the
                entries below are the only way in.
              </p>
            ) : null}

            {state.data.capabilities.canShare ? (
              <div className="space-y-2">
                <Label htmlFor="share-search">Add a colleague</Label>
                <Input
                  id="share-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by name or company email"
                  autoComplete="off"
                />

                {search.trim().length >= 2 && directory.data ? (
                  <ul className="max-h-40 overflow-y-auto rounded-md border">
                    {directory.data.length === 0 ? (
                      <li className="px-3 py-2 text-xs text-muted-foreground">
                        Nobody in the directory matches that.
                      </li>
                    ) : (
                      directory.data.map((person) => (
                        <li key={person.id}>
                          <button
                            type="button"
                            onClick={() => setSelected(person)}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                              selected?.id === person.id ? 'bg-accent' : ''
                            }`}
                          >
                            <UserIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate">
                              {person.name}
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                {person.email}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}

                {selected ? (
                  <div className="space-y-2 rounded-md border p-3">
                    <p className="text-sm font-medium">{selected.name}</p>
                    <div className="space-y-1.5">
                      <Label htmlFor="share-level" className="text-xs">
                        Access level
                      </Label>
                      <Select value={level} onValueChange={(value) => setLevel(value as AccessLevel)}>
                        <SelectTrigger id="share-level">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ACCESS_LEVELS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">
                        {ACCESS_LEVELS.find((option) => option.value === level)?.description}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={share.isPending} onClick={() => grant(selected.id)}>
                        {share.isPending ? (
                          <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden="true" />
                        ) : null}
                        Share
                      </Button>
                      {state.data.capabilities.canManageAccess ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={share.isPending}
                          onClick={() => grant(selected.id, true)}
                          title="Blocks this person even if they would otherwise inherit access"
                        >
                          <Ban className="mr-2 size-3.5" aria-hidden="true" />
                          Block instead
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                You can see who has access, but not change it.
              </p>
            )}

            <Separator />

            <section>
              <h3 className="mb-2 text-sm font-medium">Shared directly</h3>
              {direct.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nobody has been given access to this item specifically.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {direct.map((entry) => (
                    <li
                      key={`${entry.principalType}:${entry.principalId}`}
                      className="flex items-center gap-2 rounded-md border p-2 text-sm"
                    >
                      <PrincipalIcon type={entry.principalType} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{entry.principalName}</span>
                        {entry.principalEmail ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {entry.principalEmail}
                          </span>
                        ) : null}
                      </span>
                      {entry.deny ? (
                        <Badge variant="destructive">Blocked</Badge>
                      ) : (
                        <Badge variant="secondary">{entry.accessLevel}</Badge>
                      )}
                      {state.data!.capabilities.canShare ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Remove ${entry.principalName}`}
                          disabled={revoke.isPending}
                          onClick={async () => {
                            try {
                              await revoke.mutateAsync({
                                targetType,
                                targetId: targetId!,
                                principalType: entry.principalType,
                                principalId: entry.principalId,
                              });
                              toast.success(`Removed ${entry.principalName}`);
                            } catch (error) {
                              toast.error(
                                error instanceof ApiError ? error.message : 'Could not remove that',
                              );
                            }
                          }}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-medium">Inherited from folders</h3>
                {state.data.capabilities.canManageAccess ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={setInheritance.isPending}
                    onClick={async () => {
                      const next = !state.data!.inheritPermissions;
                      try {
                        await setInheritance.mutateAsync({
                          targetType,
                          targetId: targetId!,
                          inherit: next,
                        });
                        toast.success(
                          next ? 'Now inheriting folder access' : 'No longer inheriting folder access',
                          {
                            description: next
                              ? undefined
                              : 'The people who had access through the folder were copied down, so nobody lost access unexpectedly. Remove them individually from here.',
                          },
                        );
                      } catch (error) {
                        toast.error(
                          error instanceof ApiError ? error.message : 'Could not change inheritance',
                        );
                      }
                    }}
                  >
                    <Link2Off className="mr-1.5 size-3.5" aria-hidden="true" />
                    {state.data.inheritPermissions ? 'Stop inheriting' : 'Resume inheriting'}
                  </Button>
                ) : null}
              </div>

              {!state.data.inheritPermissions ? (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
                  Inheritance is switched off. Only the entries above, the owner, and
                  administrators can reach this item.
                </p>
              ) : inherited.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No folder above this one grants access to anybody specific.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {inherited.map((entry, index) => (
                    <li
                      key={`${entry.principalType}:${entry.principalId}:${index}`}
                      className="flex items-center gap-2 rounded-md border border-dashed p-2 text-sm"
                    >
                      <PrincipalIcon type={entry.principalType} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{entry.principalName}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          via {entry.inheritedFromFolderName}
                        </span>
                      </span>
                      {entry.deny ? (
                        <Badge variant="destructive">Blocked</Badge>
                      ) : (
                        <Badge variant="outline">{entry.accessLevel}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PrincipalIcon({ type }: { type: string }) {
  const Icon = type === 'department' ? Building2 : type === 'project' ? FlaskConical : UserIcon;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}
