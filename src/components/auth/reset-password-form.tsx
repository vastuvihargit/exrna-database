'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiRequest, ApiError } from '@/lib/api-client';

const schema = z
  .object({
    password: z.string().min(12, 'Use at least 12 characters').max(128),
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });

type FormValues = z.infer<typeof schema>;

export function ResetPasswordForm() {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  });

  const reset = useMutation({
    mutationFn: (values: FormValues) =>
      apiRequest<{ message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: { token, password: values.password },
      }),
    onSuccess: () => setDone(true),
    onError: (err: unknown) => {
      // The server returns the policy failures in `details`; show them all at once.
      if (err instanceof ApiError) {
        const details = Array.isArray(err.details) ? (err.details as string[]) : null;
        setError(details?.length ? details.join('. ') : err.message);
      } else {
        setError('Could not reset your password. Please request a new link.');
      }
    },
  });

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invalid reset link</CardTitle>
          <CardDescription>This link is missing its token. Request a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" asChild>
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-success" aria-hidden="true" />
            Password changed
          </CardTitle>
          <CardDescription>
            All other devices have been signed out. Sign in with your new password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" asChild>
            <Link href="/login">Go to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          At least 12 characters, mixing upper and lower case, digits or symbols. It must not contain
          your name or email address.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={form.handleSubmit((values) => {
            setError(null);
            reset.mutate(values);
          })}
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
            {form.formState.errors.password ? (
              <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm new password</Label>
            <Input id="confirm" type="password" autoComplete="new-password" {...form.register('confirm')} />
            {form.formState.errors.confirm ? (
              <p className="text-xs text-destructive">{form.formState.errors.confirm.message}</p>
            ) : null}
          </div>

          {error ? (
            <div role="alert" className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          <Button type="submit" className="w-full" disabled={reset.isPending}>
            {reset.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Set new password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
