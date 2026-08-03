'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CheckCircle2, Loader2, LogOut, Monitor } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatRelativeTime } from '@/lib/utils';
import { apiRequest, ApiError } from '@/lib/api-client';

interface SessionRow {
  id: string;
  deviceLabel: string;
  ip: string;
  provider: string;
  createdAt: string;
  lastUsedAt: string;
  isCurrent: boolean;
}

interface LoginRow {
  id: string;
  outcome: string;
  provider: string;
  ip: string;
  detail: string | null;
  createdAt: string;
}

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(12, 'Use at least 12 characters').max(128),
    confirm: z.string(),
  })
  .refine((values) => values.newPassword === values.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });

type PasswordValues = z.infer<typeof passwordSchema>;

export function AccountSecurity({ roles }: { roles: Array<{ name: string; scopeType: string }> }) {
  const queryClient = useQueryClient();
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const [passwordDone, setPasswordDone] = React.useState(false);

  const sessions = useQuery({
    queryKey: ['account', 'sessions'],
    queryFn: () => apiRequest<SessionRow[]>('/api/auth/sessions'),
  });

  const loginHistory = useQuery({
    queryKey: ['account', 'login-history'],
    queryFn: () => apiRequest<LoginRow[]>('/api/auth/login-history'),
  });

  const revokeSession = useMutation({
    mutationFn: (sessionId: string) =>
      apiRequest(`/api/auth/sessions/${sessionId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account', 'sessions'] }),
  });

  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });

  const changePassword = useMutation({
    mutationFn: (values: PasswordValues) =>
      apiRequest('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
      }),
    onSuccess: () => {
      setPasswordDone(true);
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ['account', 'sessions'] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        const details = Array.isArray(err.details) ? (err.details as string[]) : null;
        setPasswordError(details?.length ? details.join('. ') : err.message);
      } else {
        setPasswordError('Could not change your password.');
      }
    },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your roles</CardTitle>
          <CardDescription>What you can do is decided by these grants.</CardDescription>
        </CardHeader>
        <CardContent>
          {roles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No roles granted yet. Ask your administrator for access.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {roles.map((role, index) => (
                <li key={`${role.name}-${index}`}>
                  <Badge variant="outline">
                    {role.name} · {role.scopeType}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Change password</CardTitle>
          <CardDescription>Changing it signs you out on every other device.</CardDescription>
        </CardHeader>
        <CardContent>
          {passwordDone ? (
            <p className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
              Password changed. Other devices have been signed out.
            </p>
          ) : (
            <form
              className="space-y-3"
              noValidate
              onSubmit={form.handleSubmit((values) => {
                setPasswordError(null);
                changePassword.mutate(values);
              })}
            >
              <div className="space-y-2">
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  {...form.register('currentPassword')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  {...form.register('newPassword')}
                />
                {form.formState.errors.newPassword ? (
                  <p className="text-xs text-destructive">{form.formState.errors.newPassword.message}</p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  {...form.register('confirm')}
                />
                {form.formState.errors.confirm ? (
                  <p className="text-xs text-destructive">{form.formState.errors.confirm.message}</p>
                ) : null}
              </div>

              {passwordError ? (
                <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
                  {passwordError}
                </p>
              ) : null}

              <Button type="submit" disabled={changePassword.isPending}>
                {changePassword.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                Change password
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Active sessions</CardTitle>
          <CardDescription>
            Devices currently signed in as you. Revoking a session takes effect immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Signed in</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.data?.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>
                      <span className="flex items-center gap-2 text-sm">
                        <Monitor className="size-4 text-muted-foreground" aria-hidden="true" />
                        {session.deviceLabel}
                        {session.isCurrent ? <Badge variant="success">This device</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{session.ip}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelativeTime(session.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelativeTime(session.lastUsedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {session.isCurrent ? null : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={revokeSession.isPending}
                          onClick={() => revokeSession.mutate(session.id)}
                        >
                          <LogOut className="size-4" aria-hidden="true" />
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Recent sign-in activity</CardTitle>
          <CardDescription>
            Failed attempts appear here too — unexpected entries are worth reporting.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loginHistory.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : loginHistory.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sign-in history yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loginHistory.data?.slice(0, 15).map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={entry.outcome === 'success' ? 'success' : 'destructive'}>
                        {entry.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{entry.provider}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{entry.ip}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
