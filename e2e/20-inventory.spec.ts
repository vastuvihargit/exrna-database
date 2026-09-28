/**
 * Inventory through the real UI: an item comes into existence empty, stock arrives by receipt,
 * leaves by issue, and every movement leaves a ledger row that nothing can rewrite.
 *
 * Driven by the administrator, who holds the full inventory permission set.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { api, contextFor } from './helpers';

const RUN = Date.now().toString(36);
const NAME = `TRIzol Reagent ${RUN}`;
const CODE = `CHM-${RUN}`.toUpperCase();
const BATCH = `LOT-${RUN}`.toUpperCase();

interface ItemDto {
  id: string;
  code: string;
  availableQuantity: number;
}

interface StockRow {
  id: string;
  action: string;
  quantityDelta: number;
  previousQuantity: number;
  newQuantity: number;
  batchNumber: string | null;
}

let admin: { context: BrowserContext; page: Page };
let itemId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  admin = await contextFor(browser, 'admin');
});

test.afterAll(async () => {
  await admin?.context.close();
});

async function history(page: Page): Promise<StockRow[]> {
  return api<StockRow[]>(page.request, `/api/inventory/items/${itemId}/stock?page=1&pageSize=100`);
}

type Dialog = ReturnType<Page['getByRole']>;

/** Opens Receive or Issue, fills it, submits, and returns the dialog (open if refused). */
async function submitMovement(page: Page, button: 'Receive' | 'Issue', fill: (dialog: Dialog) => Promise<void>): Promise<Dialog> {
  await page.getByRole('button', { name: button, exact: true }).click();
  const title = button === 'Receive' ? 'Receive stock' : 'Issue stock';
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await fill(dialog);
  await dialog.getByRole('button', { name: title }).click();
  return dialog;
}

async function record(page: Page, button: 'Receive' | 'Issue', fill: (dialog: Dialog) => Promise<void>): Promise<void> {
  await expect(await submitMovement(page, button, fill)).toHaveCount(0);
}

function issueToMolbio(page: Page, quantity: string) {
  return async (dialog: Dialog) => {
    await dialog.getByLabel('Quantity (mL)').fill(quantity);
    await dialog.getByLabel('Issued to').click();
    await page.getByRole('option', { name: 'A department' }).click();
    await dialog.getByLabel('Department', { exact: true }).click();
    await page.getByRole('option', { name: 'Molecular Biology' }).click();
    await dialog.getByLabel('What for').fill(`Extraction ${RUN}`);
  };
}

test('create an item — it starts empty', async () => {
  const { page } = admin;
  await page.goto('/inventory/items');
  await page.getByRole('button', { name: 'New item' }).click();
  const dialog = page.getByRole('dialog', { name: 'New inventory item' });
  await dialog.getByLabel('Item name').fill(NAME);
  await dialog.getByLabel('Item code').fill(CODE);
  await dialog.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByText(`${CODE} added`)).toBeVisible();

  await page.getByRole('link', { name: NAME }).click();
  await page.waitForURL(/\/inventory\/items\/[^/]+$/);
  itemId = page.url().split('/inventory/items/')[1]!;

  const item = await api<ItemDto>(page.request, `/api/inventory/items/${itemId}`);
  expect(item.code).toBe(CODE);
  expect(item.availableQuantity).toBe(0);
  // Nothing to issue from an empty item.
  await expect(page.getByRole('button', { name: 'Issue', exact: true })).toBeDisabled();
});

test('receive 10 mL against a batch', async () => {
  const { page } = admin;
  await record(page, 'Receive', async (dialog) => {
    await dialog.getByLabel('Quantity (mL)').fill('10');
    await dialog.getByLabel('Batch number').fill(BATCH);
  });
  await expect(page.getByText(`${CODE} now holds 10`)).toBeVisible();
  expect((await api<ItemDto>(page.request, `/api/inventory/items/${itemId}`)).availableQuantity).toBe(10);
});

test('issue 3 mL to a department', async () => {
  const { page } = admin;
  await record(page, 'Issue', issueToMolbio(page, '3'));
  await expect(page.getByText(`${CODE} now holds 7`)).toBeVisible();
});

test('the quantity is 7, and cannot be overdrawn', async () => {
  const { page } = admin;
  expect((await api<ItemDto>(page.request, `/api/inventory/items/${itemId}`)).availableQuantity).toBe(7);

  // Asking for more than the shelf holds is refused by the server, with its own message, and
  // the dialog stays open so the user can correct it.
  const dialog = await submitMovement(page, 'Issue', issueToMolbio(page, '50'));
  await expect(page.getByText(/Only 7 mL remain/).first()).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect((await api<ItemDto>(page.request, `/api/inventory/items/${itemId}`)).availableQuantity).toBe(7);
});

test('the stock history is complete and immutable', async () => {
  const { page } = admin;
  const before = await history(page);
  expect(before.map((row) => `${row.action} ${row.previousQuantity}→${row.newQuantity}`).sort()).toEqual([
    'added 0→10',
    'issued 10→7',
  ]);

  // The UI shows the same ledger.
  await page.reload();
  const table = page.getByRole('table').last();
  await expect(table.getByText('0 → 10')).toBeVisible();
  await expect(table.getByText('10 → 7')).toBeVisible();

  // There is no write path to a ledger row: the stock endpoint takes POST (a new movement) only.
  for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
    const response = await page.request.fetch(`/api/inventory/items/${itemId}/stock`, {
      method,
      data: { quantityDelta: 1000 },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(response.status(), `${method} on the ledger`).toBe(405);
  }

  // A further movement appends; the rows already written are unchanged field for field.
  await record(page, 'Issue', issueToMolbio(page, '2'));
  const after = await history(page);
  expect(after).toHaveLength(3);
  for (const row of before) expect(after).toContainEqual(row);
  expect((await api<ItemDto>(page.request, `/api/inventory/items/${itemId}`)).availableQuantity).toBe(5);
});
