'use client';

import * as React from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { CheckCircle2, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiRequest } from '@/lib/api-client';

const schema = z.object({ email: z.string().trim().min(3).max(320) });
type FormValues = z.infer<typeof schema>;

export function ForgotPasswordForm() {
  const [submitted, setSubmitted] = React.useState(false);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '' } });

  const request = useMutation({
    mutationFn: (values: FormValues) =>
      apiRequest<{ message: string }>('/api/auth/forgot-password', { method: 'POST', body: values }),
    // Success either way: the confirmation must not reveal whether the address exists.
    onSettled: () => setSubmitted(true),
  });

  if (submitted) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-success" aria-hidden="true" />
            Check your inbox
          </CardTitle>
          <CardDescription>
            If that address belongs to an active account, a reset link has been sent. The link expires
            in 30 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" asChild>
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          Enter your work email address and we will send you a reset link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={form.handleSubmit((values) => request.mutate(values))}
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="email">Work email</Label>
            <Input id="email" type="email" autoComplete="username" {...form.register('email')} />
          </div>

          <Button type="submit" className="w-full" disabled={request.isPending}>
            {request.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Send reset link
          </Button>

          <Button variant="ghost" className="w-full" asChild>
            <Link href="/login">Back to sign in</Link>
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
