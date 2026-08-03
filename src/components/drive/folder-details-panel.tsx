'use client';

import { Building2, FlaskConical, HardDrive, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { formatRelativeTime } from '@/lib/utils';
import { useFolderActivity, type FolderDto } from '@/hooks/use-drive';

const CONFIDENTIALITY_LABEL: Record<string, string> = {
  public_internal: 'Public (internal)',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

const ACTION_LABEL: Record<string, string> = {
  'folder.create': 'created',
  'folder.rename': 'renamed',
  'folder.move': 'moved',
  'folder.copy': 'copied',
  'resource.delete': 'moved to trash',
  'resource.restore': 'restored',
  'resource.archive': 'archived',
  'file.metadata_updated': 'updated details for',
};

export function FolderDetailsPanel({
  folder,
  onOpenChange,
}: {
  folder: FolderDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const activity = useFolderActivity(folder?.id ?? null);

  return (
    <Sheet open={folder !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {folder ? (
          <>
            <div className="space-y-1.5 pr-8">
              <SheetTitle className="truncate">{folder.name}</SheetTitle>
              <SheetDescription>{folder.description || 'No description.'}</SheetDescription>
            </div>

            <div className="mt-6 space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <DriveBadge driveType={folder.driveType} />
                <Badge variant={folder.confidentiality === 'restricted' ? 'destructive' : 'secondary'}>
                  {CONFIDENTIALITY_LABEL[folder.confidentiality] ?? folder.confidentiality}
                </Badge>
                {folder.status !== 'active' ? <Badge variant="outline">{folder.status}</Badge> : null}
                {folder.isSystem ? <Badge variant="outline">System folder</Badge> : null}
              </div>

              {!folder.inheritPermissions ? (
                <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  This folder does not inherit access from its parent. Only people granted access
                  here — or on the folder itself — can open it.
                </p>
              ) : null}

              <Separator />

              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Detail label="Subfolders" value={String(folder.childFolderCount)} />
                <Detail label="Files" value={String(folder.fileCount)} />
                <Detail label="Created" value={formatRelativeTime(folder.createdAt)} />
                <Detail label="Modified" value={formatRelativeTime(folder.updatedAt)} />
              </dl>

              <Separator />

              <div>
                <h3 className="mb-2 text-sm font-medium">Activity</h3>
                {activity.isLoading ? (
                  <p className="text-xs text-muted-foreground">Loading activity…</p>
                ) : activity.data && activity.data.length > 0 ? (
                  <ol className="space-y-3">
                    {activity.data.map((entry) => (
                      <li key={entry.id} className="text-xs">
                        <p>
                          <span className="font-medium">{entry.actorName}</span>{' '}
                          {ACTION_LABEL[entry.action] ?? entry.action}{' '}
                          <span className="font-medium">{entry.entityLabel}</span>
                        </p>
                        <p className="text-muted-foreground">{formatRelativeTime(entry.createdAt)}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-xs text-muted-foreground">Nothing has happened here yet.</p>
                )}
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function DriveBadge({ driveType }: { driveType: string }) {
  const Icon = driveType === 'department' ? Building2 : driveType === 'project' ? FlaskConical : HardDrive;
  const label = driveType === 'department' ? 'Department drive' : driveType === 'project' ? 'Project drive' : 'My Drive';
  return (
    <Badge variant="secondary" className="gap-1">
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}
