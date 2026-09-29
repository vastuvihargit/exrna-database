'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, apiRequest } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';
import { useDepartments } from '@/hooks/use-admin';
import { useProjects } from '@/hooks/use-drive';
import { useExperiments } from '@/hooks/use-research';
import {
  useMoveStock,
  type InventoryItemDto,
  type StockIssueTarget,
  type StockMovement,
} from '@/hooks/use-inventory';
import { formatQuantity } from './stock-badges';

export type StockDialogMode = 'add' | 'issue' | 'adjust';

const TITLES: Record<StockDialogMode, { title: string; description: string }> = {
  add: {
    title: 'Receive stock',
    description:
      'Record a delivery. The batch number is the one printed on the container — receiving into an existing batch tops it up rather than creating a second entry with the same label.',
  },
  issue: {
    title: 'Issue stock',
    description:
      'Hand material out. It is drawn from the batch closest to expiring first, and never from a batch that has already expired.',
  },
  adjust: {
    title: 'Adjust stock',
    description:
      'Correct the count after a spill, a breakage or a stock take. This is the only movement with no physical event behind it, so the reason is recorded and kept.',
  },
};

/**
 * The one dialog behind all three stock movements.
 *
 * They share the item, the layout and the outcome, and a store manager thinks of them as one
 * form with a mode rather than three pages. The three differ in exactly the fields below, and
 * in which permission the server checks — which it does against the item's custodian
 * department, not against anything this component sends.
 */
export function StockDialog({
  item,
  mode,
  open,
  onOpenChange,
}: {
  item: InventoryItemDto;
  mode: StockDialogMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const move = useMoveStock(item.id);

  const [quantity, setQuantity] = React.useState('');
  const [batchNumber, setBatchNumber] = React.useState('');
  const [expiryDate, setExpiryDate] = React.useState('');
  const [supplier, setSupplier] = React.useState('');
  const [storageLocation, setStorageLocation] = React.useState('');
  const [issuedToType, setIssuedToType] = React.useState<StockIssueTarget>('employee');
  const [targetId, setTargetId] = React.useState('');
  const [userSearch, setUserSearch] = React.useState('');
  const [purpose, setPurpose] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [direction, setDirection] = React.useState<'remove' | 'add'>('remove');
  const [notes, setNotes] = React.useState('');

  // Reset when the dialog opens rather than when it closes: leaving the values in place while
  // it fades out avoids the fields visibly emptying under the user's cursor.
  React.useEffect(() => {
    if (!open) return;
    setQuantity('');
    setBatchNumber(mode === 'add' ? '' : (item.batchNumber ?? ''));
    setExpiryDate('');
    setSupplier(item.supplier ?? '');
    setStorageLocation(item.storageLocation ?? '');
    setIssuedToType('employee');
    setTargetId('');
    setUserSearch('');
    setPurpose('');
    setReason('');
    setDirection('remove');
    setNotes('');
  }, [open, mode, item.batchNumber, item.supplier, item.storageLocation]);

  /**
   * The four things stock can be issued to, each from the endpoint that already lists it.
   *
   * Only the selected kind is fetched, and only while the dialog is open on the issue mode.
   * Loading all four every time the dialog opened would be three wasted requests on a form
   * where most issues go to a person.
   */
  const issuing = open && mode === 'issue';
  const departments = useDepartments();
  const projects = useProjects();
  const experiments = useExperiments();
  const users = useQuery({
    queryKey: ['inventory-issue-directory', userSearch],
    queryFn: () =>
      apiRequest<Array<{ id: string; name: string; email: string }>>(
        `/api/users?search=${encodeURIComponent(userSearch)}&pageSize=20`,
      ),
    enabled: issuing && issuedToType === 'employee',
  });

  const targetOptions: Array<{ id: string; label: string }> =
    issuedToType === 'employee'
      ? (users.data ?? []).map((user) => ({ id: user.id, label: `${user.name} — ${user.email}` }))
      : issuedToType === 'department'
        ? (departments.data ?? []).map((department) => ({
            id: department.id,
            label: department.name,
          }))
        : issuedToType === 'project'
          ? (projects.data ?? []).map((project) => ({
              id: project.id,
              label: `${project.code} — ${project.name}`,
            }))
          : (experiments.data ?? []).map((experiment) => ({
              id: experiment.id,
              label: `${experiment.code} — ${experiment.title}`,
            }));

  /**
   * Batches that can actually be drawn from, for the adjust and issue selectors.
   *
   * An expired batch is offered for *adjustment* — writing it off is the point — but the
   * server refuses to issue from one, so offering it there would be a dead end.
   */
  const batchOptions = item.batches.filter((batch) => batch.quantity > 0);

  const amount = Number(quantity);
  const amountValid = Number.isFinite(amount) && amount > 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!amountValid) {
      toast.error('Enter a quantity greater than zero');
      return;
    }
    if (mode === 'issue' && !targetId) {
      toast.error(`Choose the ${issuedToType} the stock is being issued to`);
      return;
    }

    const movement: StockMovement =
      mode === 'add'
        ? {
            action: 'add',
            payload: {
              quantity: amount,
              batchNumber: batchNumber.trim(),
              ...(expiryDate ? { expiryDate: new Date(expiryDate).toISOString() } : {}),
              ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
              ...(storageLocation.trim() ? { storageLocation: storageLocation.trim() } : {}),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
            },
          }
        : mode === 'issue'
          ? {
              action: 'issue',
              payload: {
                quantity: amount,
                issuedToType,
                // The key the id goes under is what makes the linkage queryable. The server
                // refuses an `issuedToType` whose id is missing rather than writing a row that
                // claims to be project consumption and appears in no project's report.
                ...(issuedToType === 'employee' ? { issuedToUserId: targetId } : {}),
                ...(issuedToType === 'department' ? { issuedToDepartmentId: targetId } : {}),
                ...(issuedToType === 'project' ? { projectId: targetId } : {}),
                ...(issuedToType === 'experiment' ? { experimentId: targetId } : {}),
                ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
                ...(notes.trim() ? { notes: notes.trim() } : {}),
              },
            }
          : {
              action: 'adjust',
              payload: {
                batchNumber: batchNumber.trim(),
                // The sign is a radio rather than a typed minus: a user who omits the minus
                // would silently double the stock they meant to write off.
                delta: direction === 'remove' ? -amount : amount,
                reason: reason.trim(),
                ...(notes.trim() ? { notes: notes.trim() } : {}),
              },
            };

    try {
      const result = await move.mutateAsync(movement);
      toast.success(
        `${item.code} now holds ${formatQuantity(result.item.availableQuantity, item.unit)}`,
      );
      onOpenChange(false);
    } catch (error) {
      // The server's message is shown verbatim. It is the one that knows whether this was a
      // shortfall, expired stock or somebody else getting there first, and each has a
      // different remedy.
      toast.error(error instanceof ApiError ? error.message : 'Could not record the movement');
    }
  }

  const { title, description } = TITLES[mode];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <p className="text-sm text-muted-foreground">
              {item.code} · {item.name} ·{' '}
              <span className="tabular-nums">
                {formatQuantity(item.availableQuantity, item.unit)} in stock
              </span>
            </p>

            {mode === 'adjust' ? (
              <div className="grid gap-2">
                <Label htmlFor="stock-direction">Direction</Label>
                <Select
                  value={direction}
                  onValueChange={(value) => setDirection(value as 'remove' | 'add')}
                >
                  <SelectTrigger id="stock-direction">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="remove">Write off — there is less than recorded</SelectItem>
                    <SelectItem value="add">Add — a recount found more than recorded</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label htmlFor="stock-quantity">Quantity ({item.unit})</Label>
              <Input
                id="stock-quantity"
                type="number"
                min="0"
                step="0.001"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
                autoFocus
              />
            </div>

            {mode === 'add' ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="stock-batch">Batch number</Label>
                  <Input
                    id="stock-batch"
                    value={batchNumber}
                    onChange={(event) => setBatchNumber(event.target.value)}
                    placeholder="As printed on the container"
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="stock-expiry">Expiry date</Label>
                  <Input
                    id="stock-expiry"
                    type="date"
                    value={expiryDate}
                    onChange={(event) => setExpiryDate(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave empty if the material does not expire. A batch that has already
                    expired cannot be received as usable stock.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="stock-supplier">Supplier</Label>
                    <Input
                      id="stock-supplier"
                      value={supplier}
                      onChange={(event) => setSupplier(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="stock-location">Location</Label>
                    <Input
                      id="stock-location"
                      value={storageLocation}
                      onChange={(event) => setStorageLocation(event.target.value)}
                    />
                  </div>
                </div>
              </>
            ) : null}

            {mode === 'adjust' ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="stock-adjust-batch">Batch</Label>
                  {direction === 'remove' && batchOptions.length > 0 ? (
                    <Select value={batchNumber} onValueChange={setBatchNumber}>
                      <SelectTrigger id="stock-adjust-batch">
                        <SelectValue placeholder="Choose a batch" />
                      </SelectTrigger>
                      <SelectContent>
                        {batchOptions.map((batch) => (
                          <SelectItem key={batch.batchNumber} value={batch.batchNumber}>
                            {batch.batchNumber} — {formatQuantity(batch.quantity, item.unit)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id="stock-adjust-batch"
                      value={batchNumber}
                      onChange={(event) => setBatchNumber(event.target.value)}
                      placeholder="As printed on the container"
                      required
                    />
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="stock-reason">Reason</Label>
                  <Input
                    id="stock-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Spilled during transfer, breakage, stock take…"
                    required
                    minLength={3}
                  />
                </div>
              </>
            ) : null}

            {mode === 'issue' ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="stock-target">Issued to</Label>
                  <Select
                    value={issuedToType}
                    onValueChange={(value) => {
                      setIssuedToType(value as StockIssueTarget);
                      // The id belongs to the previous kind. Carrying it over would submit a
                      // department id under `projectId` and be refused as "not found".
                      setTargetId('');
                    }}
                  >
                    <SelectTrigger id="stock-target">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="employee">An employee</SelectItem>
                      <SelectItem value="department">A department</SelectItem>
                      <SelectItem value="project">A project</SelectItem>
                      <SelectItem value="experiment">An experiment</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {issuedToType === 'employee' ? (
                  <div className="grid gap-2">
                    <Label htmlFor="stock-user-search">Find an employee</Label>
                    <Input
                      id="stock-user-search"
                      value={userSearch}
                      onChange={(event) => setUserSearch(event.target.value)}
                      placeholder="Name or email"
                    />
                  </div>
                ) : null}

                <div className="grid gap-2">
                  <Label htmlFor="stock-target-id">
                    {issuedToType === 'employee'
                      ? 'Employee'
                      : issuedToType === 'department'
                        ? 'Department'
                        : issuedToType === 'project'
                          ? 'Project'
                          : 'Experiment'}
                  </Label>
                  <Select value={targetId} onValueChange={setTargetId}>
                    <SelectTrigger id="stock-target-id">
                      <SelectValue placeholder="Choose one" />
                    </SelectTrigger>
                    <SelectContent>
                      {targetOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="stock-purpose">What for</Label>
                  <Input
                    id="stock-purpose"
                    value={purpose}
                    onChange={(event) => setPurpose(event.target.value)}
                    placeholder="Assay run 12"
                  />
                </div>
              </>
            ) : null}

            <div className="grid gap-2">
              <Label htmlFor="stock-notes">Notes</Label>
              <Input
                id="stock-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={move.isPending}>
              {move.isPending ? 'Recording…' : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
