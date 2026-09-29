'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { AlertCircle, Loader2, LogIn } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { apiRequest, ApiError } from '@/lib/api-client';

const formSchema = z.object({
  email: z.string().trim().min(3, 'Enter your work email address').max(320),
  password: z.string().min(1, 'Enter your password').max(128),
});

type FormValues = z.infer<typeof formSchema>;

interface Providers {
  /** Cloudflare Access is in front: it is the only sign-in method. */
  access: boolean;
  password: boolean;
  google: boolean;
  microsoft: boolean;
  companyEmailDomains: string[];
  appName: string;
}

/** Callback failures arrive as a short code; the copy lives here, never upstream text. */
const OAUTH_ERRORS: Record<string, string> = {
  oauth_cancelled: 'Sign-in was cancelled.',
  oauth_state_missing: 'The sign-in attempt expired. Please try again.',
  oauth_state_mismatch: 'The sign-in attempt could not be verified. Please try again.',
  oauth_failed: 'Google sign-in failed. Please try again or use your password.',
  not_provisioned: 'Your account has not been set up yet. Contact your administrator for access.',
};

export function LoginForm() {
  const searchParams = useSearchParams();
  const [formError, setFormError] = React.useState<string | null>(null);

  const oauthError = searchParams.get('error');
  // Only a path is accepted, so `?next=https://evil.example` cannot become a redirect.
  const nextParam = searchParams.get('next');
  const nextPath = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/home';

  const { data: providers } = useQuery({
    queryKey: ['auth', 'providers'],
    queryFn: () => apiRequest<Providers>('/api/auth/providers'),
    staleTime: 5 * 60_000,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: '', password: '' },
  });

  const login = useMutation({
    mutationFn: (values: FormValues) =>
      apiRequest('/api/auth/login', { method: 'POST', body: values }),
    onSuccess: () => {
      // A full navigation, not a client transition: the session cookie must be attached
      // to the next document request for the server-side guard to see it.
      window.location.href = nextPath;
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError) {
        setFormError(
          error.status === 429
            ? 'Too many attempts. Please wait a few minutes and try again.'
            : error.message,
        );
      } else {
        setFormError('Sign-in failed. Please try again.');
      }
    },
  });

  const domains = providers?.companyEmailDomains ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          {domains.length > 0
            ? `Use your company account (${domains.map((domain) => `@${domain}`).join(', ')}).`
            : 'Use your company account.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {oauthError ? (
          <div
            role="alert"
            className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <span>{OAUTH_ERRORS[oauthError] ?? 'Sign-in failed. Please try again.'}</span>
          </div>
        ) : null}

        {providers?.access ? (
          <>
            <Button className="w-full" asChild>
              <a href={`/api/auth/access?next=${encodeURIComponent(nextPath)}`}>
                <LogIn className="size-4" aria-hidden="true" />
                Continue with company sign-in
              </a>
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Sign-in is handled by your company&apos;s single sign-on.
            </p>
          </>
        ) : null}

        {providers?.google ? (
          <>
            <Button variant="outline" className="w-full" asChild>
              <a href="/api/auth/google">Continue with Google Workspace</a>
            </Button>
            <div className="relative">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs uppercase tracking-wide text-muted-foreground">
                or
              </span>
            </div>
          </>
        ) : null}

        {providers?.access ? null : (
        <form
          className="space-y-4"
          onSubmit={form.handleSubmit((values) => {
            setFormError(null);
            login.mutate(values);
          })}
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              placeholder={domains[0] ? `you@${domains[0]}` : 'you@company.com'}
              aria-invalid={Boolean(form.formState.errors.email)}
              {...form.register('email')}
            />
            {form.formState.errors.email ? (
              <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/forgot-password"
                className="text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(form.formState.errors.password)}
              {...form.register('password')}
            />
            {form.formState.errors.password ? (
              <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
            ) : null}
          </div>

          {formError ? (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
              <span>{formError}</span>
            </div>
          ) : null}

          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogIn className="size-4" aria-hidden="true" />
            )}
            Sign in
          </Button>
        </form>
        )}

        <p className="text-center text-xs text-muted-foreground">
          Accounts are created by your administrator. There is no public sign-up.
        </p>
      </CardContent>
    </Card>
  );
}
