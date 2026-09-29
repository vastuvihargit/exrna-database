'use client';

import * as React from 'react';
import { Loader2, ShieldCheck, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';
import { useDepartments, useGrantRole, useRevokeRole, useRoles, type AdminUser } from '@/hooks/use-admin';

/**
 * Role assignment.
 *
 * Escalation rules are enforced by the server (rank check + "cannot grant what you do
 * not hold"). This dialog simply surfaces the resulting error rather than trying to
 * predict it — the server is the authority.
 */
export function UserRolesDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: roles } = useRoles();
  const { data: departments } = useDepartments();
  const grant = useGrantRole();
  const revoke = useRevokeRole();

  const [roleKey, setRoleKey] = React.useState<string>('');
  const [scopeType, setScopeType] = React.useState<string>('company');
  const [scopeId, setScopeId] = React.useState<string>('');
  const [error, setError] = React.useState<string | null>(null);

  const selectedRole = roles?.find((role) => role.key === roleKey);
  const availableScopes = selectedRole?.scopeTypes ?? ['company'];

  React.useEffect(() => {
    // Keep the scope selector consistent when the chosen role changes.
    if (selectedRole && !selectedRole.scopeTypes.includes(scopeType)) {
      setScopeType(selectedRole.scopeTypes[0] ?? 'company');
    }
  }, [selectedRole, scopeType]);

  if (!user) return null;

  const needsScopeId = scopeType !== 'company';
  const canSubmit = Boolean(roleKey) && (!needsScopeId || Boolean(scopeId));

  const handleGrant = () => {
    setError(null);
    grant.mutate(
      { userId: user.id, roleKey, scopeType, scopeId: needsScopeId ? scopeId : null },
      {
        onError: (err: unknown) =>
          setError(err instanceof ApiError ? err.message : 'Could not grant the role.'),
        onSuccess: () => {
          setRoleKey('');
          setScopeId('');
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Roles — {user.name}</DialogTitle>
          <DialogDescription>
            Roles decide what this employee can do, and at what scope. Changing them signs the
            employee out so the new permissions apply immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">Current roles</p>
            {user.roles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No roles granted — this employee can sign in but cannot access any content.
              </p>
            ) : (
              <ul className="space-y-2">
                {user.roles.map((role) => (
                  <li
                    key={role.grantId}
                    className="flex items-center justify-between gap-2 rounded-md border p-2"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
                      {role.roleName}
                      <Badge variant="outline">{role.scopeType}</Badge>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Revoke ${role.roleName}`}
                      disabled={revoke.isPending}
                      onClick={() => {
                        setError(null);
                        revoke.mutate(
                          { userId: user.id, grantId: role.grantId },
                          {
                            onError: (err: unknown) =>
                              setError(err instanceof ApiError ? err.message : 'Could not revoke the role.'),
                          },
                        );
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm font-medium">Grant a role</p>

            <div className="space-y-2">
              <Label htmlFor="grant-role">Role</Label>
              <Select value={roleKey} onValueChange={setRoleKey}>
                <SelectTrigger id="grant-role">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {roles?.map((role) => (
                    <SelectItem key={role.key} value={role.key}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedRole ? (
                <p className="text-xs text-muted-foreground">{selectedRole.description}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="grant-scope">Scope</Label>
              <Select value={scopeType} onValueChange={setScopeType}>
                <SelectTrigger id="grant-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableScopes.map((scope) => (
                    <SelectItem key={scope} value={scope}>
                      {scope}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {scopeType === 'department' ? (
              <div className="space-y-2">
                <Label htmlFor="grant-scope-id">Department</Label>
                <Select value={scopeId} onValueChange={setScopeId}>
                  <SelectTrigger id="grant-scope-id">
                    <SelectValue placeholder="Select a department" />
                  </SelectTrigger>
                  <SelectContent>
                    {departments?.map((department) => (
                      <SelectItem key={department.id} value={department.id}>
                        {department.code} — {department.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {/*
              Says what the administrator can do about it, rather than naming an internal build
              phase. The previous text ended "(Phase 3)", which meant something to the team and
              nothing to the person reading the dialog — who wants to know whether they are
              blocked or have misconfigured something.
            */}
            {needsScopeId && scopeType !== 'department' ? (
              <p className="text-xs text-muted-foreground">
                No {scopeType}s have been created yet, so there is nothing to scope this role to.
                Create one first, then grant the role.
              </p>
            ) : null}

            {error ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
                {error}
              </p>
            ) : null}

            <Button onClick={handleGrant} disabled={!canSubmit || grant.isPending} className="w-full">
              {grant.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Grant role
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
