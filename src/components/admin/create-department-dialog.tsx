'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Plus } from 'lucide-react';

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
import { ApiError } from '@/lib/api-client';
import { useCreateDepartment } from '@/hooks/use-admin';

const schema = z.object({
  name: z.string().trim().min(2, 'Enter a department name').max(200),
  code: z
    .string()
    .trim()
    .min(2, 'Enter a short code')
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and hyphens only'),
  description: z.string().trim().max(1000).optional(),
  // An empty number input submits '', which `z.coerce.number()` turns into 0 — below the
  // minimum — so the optional field made the whole form unsubmittable. Empty means "no quota".
  storageQuotaGb: z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    z.coerce.number().int('Whole gigabytes only').min(1, 'At least 1 GB').max(1_000_000).optional(),
  ),
});

type FormInput = z.input<typeof schema>;
type FormValues = z.output<typeof schema>;

export function CreateDepartmentDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const createDepartment = useCreateDepartment();

  const form = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', code: '', description: '' },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" aria-hidden="true" />
          New department
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>New department</DialogTitle>
          <DialogDescription>
            The code is used in folder names and project identifiers, so keep it short and stable.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          noValidate
          onSubmit={form.handleSubmit((values) => {
            setError(null);
            createDepartment.mutate(
              {
                name: values.name,
                code: values.code,
                ...(values.description ? { description: values.description } : {}),
                ...(values.storageQuotaGb ? { storageQuotaGb: values.storageQuotaGb } : {}),
              },
              {
                onSuccess: () => {
                  form.reset();
                  setOpen(false);
                  // The page is a server component, so refresh to pick up the new row.
                  router.refresh();
                },
                onError: (err: unknown) =>
                  setError(err instanceof ApiError ? err.message : 'Could not create the department.'),
              },
            );
          })}
        >
          <div className="space-y-2">
            <Label htmlFor="dept-name">Name</Label>
            <Input id="dept-name" placeholder="Molecular Biology" {...form.register('name')} />
            {form.formState.errors.name ? (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="dept-code">Code</Label>
            <Input id="dept-code" placeholder="MOLBIO" className="font-mono" {...form.register('code')} />
            {form.formState.errors.code ? (
              <p className="text-xs text-destructive">{form.formState.errors.code.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="dept-description">Description</Label>
            <Input id="dept-description" {...form.register('description')} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="dept-quota">Storage quota (GB)</Label>
            <Input id="dept-quota" type="number" min={1} placeholder="500" {...form.register('storageQuotaGb')} />
            {form.formState.errors.storageQuotaGb ? (
              <p className="text-xs text-destructive">{form.formState.errors.storageQuotaGb.message}</p>
            ) : null}
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
            <Button type="submit" disabled={createDepartment.isPending}>
              {createDepartment.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
