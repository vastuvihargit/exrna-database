'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
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
import { ApiError } from '@/lib/api-client';
import { useDepartments } from '@/hooks/use-admin';
import {
  useCreateInventoryItem,
  useUpdateInventoryItem,
  type InventoryCategory,
  type InventoryItemDto,
  type InventoryItemStatus,
  type InventoryUnit,
} from '@/hooks/use-inventory';

const CATEGORIES: Array<{ value: InventoryCategory; label: string }> = [
  { value: 'chemical', label: 'Chemicals' },
  { value: 'reagent', label: 'Reagents' },
  { value: 'consumable', label: 'Consumables' },
  { value: 'glassware', label: 'Glassware' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'other', label: 'Other' },
];

const UNITS: InventoryUnit[] = [
  'mg',
  'g',
  'kg',
  'µL',
  'mL',
  'L',
  'units',
  'vials',
  'tubes',
  'plates',
  'boxes',
  'packs',
  'rolls',
  'other',
];

const STATUSES: Array<{ value: InventoryItemStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'discontinued', label: 'Discontinued' },
];

const CENTRAL_STORE = 'central';

/**
 * Marks the two fields with no sensible default.
 *
 * Decoration only — the inputs carry `required`, which is what a screen reader announces.
 */
function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-destructive">
      *
    </span>
  );
}

interface FormState {
  name: string;
  code: string;
  category: InventoryCategory;
  unit: InventoryUnit;
  departmentId: string;
  minimumStock: string;
  storageLocation: string;
  supplier: string;
  description: string;
  status: InventoryItemStatus;
}

const EMPTY: FormState = {
  name: '',
  code: '',
  category: 'reagent',
  unit: 'mL',
  departmentId: CENTRAL_STORE,
  minimumStock: '0',
  storageLocation: '',
  supplier: '',
  description: '',
  status: 'active',
};

/**
 * Create or edit an inventory item.
 *
 * There is no quantity field, and that is the point. An item comes into existence empty and
 * is filled by a receipt, which records the batch, the supplier and who took delivery. A
 * box here saying "available quantity" would be a way to put stock on a shelf with no record
 * of where it came from — exactly what the history is for.
 *
 * The code is fixed once created: it is printed on the shelf label and copied into every
 * transaction row that has already been written.
 *
 * Ten fields at once reads as ten decisions, when only two of them have to be made. What is
 * always shown is what defines the item and what makes it reorder; the shelf, the supplier
 * and the notes sit behind "More details" — open already when an existing item has any of
 * them, so editing never hides what is there.
 */
export function ItemDialog({
  item,
  open,
  onOpenChange,
}: {
  item: InventoryItemDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = React.useState<FormState>(EMPTY);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const create = useCreateInventoryItem();
  const update = useUpdateInventoryItem();
  const { data: departments } = useDepartments();

  React.useEffect(() => {
    if (!open) return;
    setDetailsOpen(
      Boolean(
        item &&
          (item.storageLocation || item.supplier || item.description || item.status !== 'active'),
      ),
    );
    setForm(
      item
        ? {
            name: item.name,
            code: item.code,
            category: item.category,
            unit: item.unit,
            departmentId: item.departmentId ?? CENTRAL_STORE,
            minimumStock: String(item.minimumStock),
            storageLocation: item.storageLocation,
            supplier: item.supplier,
            description: item.description,
            status: item.status,
          }
        : EMPTY,
    );
  }, [open, item]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const pending = create.isPending || update.isPending;
  const minimumStock = Number(form.minimumStock);
  const minimumStockValid = Number.isFinite(minimumStock) && minimumStock >= 0;

  // Changing the unit under existing stock would silently reinterpret it — the server
  // refuses, and saying so here means the refusal is not a surprise at the end of a form.
  const unitLocked = Boolean(item && item.availableQuantity > 0);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!minimumStockValid) return;

    const payload = {
      name: form.name.trim(),
      category: form.category,
      unit: form.unit,
      departmentId: form.departmentId === CENTRAL_STORE ? null : form.departmentId,
      description: form.description.trim(),
      minimumStock,
      storageLocation: form.storageLocation.trim(),
      supplier: form.supplier.trim(),
      status: form.status,
    };

    try {
      if (item) {
        // The unit is only sent when it can legitimately change; otherwise an unchanged
        // value would still trip the server's "stock remains" guard.
        const { unit, ...rest } = payload;
        await update.mutateAsync({
          itemId: item.id,
          ...rest,
          ...(unitLocked ? {} : { unit }),
        });
        toast.success(`${item.code} updated`);
      } else {
        const result = await create.mutateAsync({ ...payload, code: form.code.trim() });
        toast.success(`${result.code} added`, {
          description: 'It starts empty — record a receipt to put stock against it.',
        });
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not save the item');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{item ? `Edit ${item.code}` : 'New inventory item'}</DialogTitle>
            <DialogDescription>
              {item
                ? 'Changes the definition. Quantities move through receipts, issues and corrections.'
                : 'Defines what the material is and when to reorder it. It starts empty — stock arrives through a receipt.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 pt-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="item-name">
                Item name <RequiredMark />
              </Label>
              <Input
                id="item-name"
                value={form.name}
                onChange={(event) => set('name', event.target.value)}
                placeholder="TRIzol Reagent"
                maxLength={200}
                required
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="item-code">Item code {item ? null : <RequiredMark />}</Label>
              <Input
                id="item-code"
                value={form.code}
                onChange={(event) => set('code', event.target.value)}
                placeholder="CHM-0042"
                maxLength={60}
                disabled={Boolean(item)}
                required
              />
              {item ? (
                <p className="text-[11px] text-muted-foreground">
                  Codes cannot change — the shelf label and every past transaction use this one.
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="item-category">Category</Label>
              <Select
                value={form.category}
                onValueChange={(value) => set('category', value as InventoryCategory)}
              >
                <SelectTrigger id="item-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((category) => (
                    <SelectItem key={category.value} value={category.value}>
                      {category.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="item-unit">Unit</Label>
              <Select
                value={form.unit}
                onValueChange={(value) => set('unit', value as InventoryUnit)}
                disabled={unitLocked}
              >
                <SelectTrigger id="item-unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNITS.map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {unitLocked ? (
                <p className="text-[11px] text-muted-foreground">
                  Fixed while stock remains — changing it would reinterpret the quantity on the
                  shelf.
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="item-minimum">Minimum stock</Label>
              <Input
                id="item-minimum"
                type="number"
                min={0}
                step="0.001"
                value={form.minimumStock}
                onChange={(event) => set('minimumStock', event.target.value)}
                aria-invalid={!minimumStockValid}
              />
              <p className="text-[11px] text-muted-foreground">
                The level at which this item is flagged as low. Zero means never.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="item-department">Held by</Label>
              <Select
                value={form.departmentId}
                onValueChange={(value) => set('departmentId', value)}
              >
                <SelectTrigger id="item-department">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CENTRAL_STORE}>Central store</SelectItem>
                  {(departments ?? []).map((department) => (
                    <SelectItem key={department.id} value={department.id}>
                      {department.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Who may receive and issue it. Central store items need company-wide access.
              </p>
            </div>

          </div>

          <div className="space-y-3 pb-4 pt-3">
            <button
              type="button"
              onClick={() => setDetailsOpen((current) => !current)}
              aria-expanded={detailsOpen}
              aria-controls="item-more-details"
              className="flex w-full items-center gap-2 border-t pt-3 text-sm font-medium transition-colors hover:text-foreground"
            >
              <ChevronDown
                className={cn('size-4 transition-transform', detailsOpen && 'rotate-180')}
                aria-hidden="true"
              />
              More details
              <span className="font-normal text-muted-foreground">
                — status, shelf, supplier, notes
              </span>
            </button>

            {/* Collapsed rather than unmounted-and-forgotten: the values live in `form`, so
                closing this never discards anything the user typed. */}
            {detailsOpen ? (
              <div id="item-more-details" className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="item-status">Status</Label>
                  <Select
                    value={form.status}
                    onValueChange={(value) => set('status', value as InventoryItemStatus)}
                  >
                    <SelectTrigger id="item-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((status) => (
                        <SelectItem key={status.value} value={status.value}>
                          {status.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Inactive and discontinued items keep their stock and their history — they
                    are only shown dimmed in the list.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="item-location">Storage location</Label>
                  <Input
                    id="item-location"
                    value={form.storageLocation}
                    onChange={(event) => set('storageLocation', event.target.value)}
                    placeholder="Cold room A — shelf 3"
                    maxLength={120}
                  />
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="item-supplier">Supplier</Label>
                  <Input
                    id="item-supplier"
                    value={form.supplier}
                    onChange={(event) => set('supplier', event.target.value)}
                    placeholder="Thermo Fisher"
                    maxLength={200}
                  />
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="item-description">Description</Label>
                  <textarea
                    id="item-description"
                    value={form.description}
                    onChange={(event) => set('description', event.target.value)}
                    rows={2}
                    maxLength={4000}
                    placeholder="Handling notes, hazard information, catalogue number"
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !form.name.trim() ||
                !minimumStockValid ||
                (!item && !form.code.trim())
              }
            >
              {pending ? 'Saving…' : item ? 'Save changes' : 'Add item'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
