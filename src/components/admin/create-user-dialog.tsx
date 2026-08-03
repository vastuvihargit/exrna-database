'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError } from '@/lib/api-client';
import { useCreateUser, useDepartments, useRoles } from '@/hooks/use-admin';

const schema = z.object({
  email: z.string().trim().min(3).max(320),
  name: z.string().trim().min(2, 'Enter the full name').max(200),
  jobTitle: z.string().trim().max(200).optional(),
  departmentId: z.string().optional(),
  roleKey: z.string().optional(),
  status: z.enum(['invited', 'active']),
  temporaryPassword: z.string().max(128).optional(),
});

type FormValues = z.infer<typeof schema>;

export function CreateUserDialog({ companyDomains }: { companyDomains: string[] }) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const { data: departments } = useDepartments();
  const { data: roles } = useRoles();
  const createUser = useCreateUser();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', name: '', jobTitle: '', status: 'invited', temporaryPassword: '' },
  });

  const submit = form.handleSubmit((values) => {
    setError(null);
    createUser.mutate(
      {
        email: values.email,
        name: values.name,
        ...(values.jobTitle ? { jobTitle: values.jobTitle } : {}),
        ...(values.departmentId && values.departmentId !== 'none' ? { departmentId: values.departmentId } : {}),
        ...(values.roleKey && values.roleKey !== 'none' ? { roleKey: values.roleKey } : {}),
        status: values.status,
        ...(values.temporaryPassword ? { temporaryPassword: values.temporaryPassword } : {}),
      },
      {
        onSuccess: () => {
          form.reset();
          setOpen(false);
        },
        onError: (err: unknown) => {
          if (err instanceof ApiError) {
            const details = Array.isArray(err.details) ? (err.details as string[]) : null;
            setError(details?.length ? details.join('. ') : err.message);
          } else {
            setError('Could not create the account.');
          }
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="size-4" aria-hidden="true" />
          Add employee
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add employee</DialogTitle>
          <DialogDescription>
            The address must be on an approved company domain
            {companyDomains.length ? ` (${companyDomains.map((d) => `@${d}`).join(', ')})` : ''}.
            Employees cannot sign themselves up.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="space-y-2">
            <Label htmlFor="new-email">Work email</Label>
            <Input id="new-email" type="email" {...form.register('email')} />
            {form.formState.errors.email ? (
              <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-name">Full name</Label>
            <Input id="new-name" {...form.register('name')} />
            {form.formState.errors.name ? (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-title">Job title</Label>
            <Input id="new-title" placeholder="Research Scientist" {...form.register('jobTitle')} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="new-department">Department</Label>
              <Select
                onValueChange={(value) => form.setValue('departmentId', value)}
                defaultValue="none"
              >
                <SelectTrigger id="new-department">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No department</SelectItem>
                  {departments?.map((department) => (
                    <SelectItem key={department.id} value={department.id}>
                      {department.code} — {department.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-role">Initial role</Label>
              <Select onValueChange={(value) => form.setValue('roleKey', value)} defaultValue="none">
                <SelectTrigger id="new-role">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No role yet</SelectItem>
                  {roles?.map((role) => (
                    <SelectItem key={role.key} value={role.key}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-status">Status</Label>
            <Select
              onValueChange={(value) => form.setValue('status', value as 'invited' | 'active')}
              defaultValue="invited"
            >
              <SelectTrigger id="new-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="invited">Invited — cannot sign in yet</SelectItem>
                <SelectItem value="active">Active — can sign in immediately</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-password">Temporary password (optional)</Label>
            <Input
              id="new-password"
              type="text"
              autoComplete="off"
              placeholder="Leave blank for Google Workspace sign-in"
              {...form.register('temporaryPassword')}
            />
            <p className="text-xs text-muted-foreground">
              Minimum 12 characters. Leave blank if the employee will use Google Workspace.
            </p>
          </div>

          {error ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createUser.isPending}>
              {createUser.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
