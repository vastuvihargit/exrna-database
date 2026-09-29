/**
 * One scientist's working day with a second person in it, through the real UI.
 *
 * Every step is a browser action against the real server and the real database (D1 by default).
 * Where a step is asserted through the API as well, that is a read of what the UI just did —
 * the API is never used to make a step succeed that the UI could not.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { api, contextFor, mutate } from './helpers';
import { USERS } from './env';

const RUN = Date.now().toString(36);
const FOLDER = `Assay run ${RUN}`;
const TARGET_FOLDER = `Completed runs ${RUN}`;
const FILE = `plate-reader-${RUN}.csv`;
/** A second, never-approved file: an approved file cannot be trashed, so Trash uses this one. */
const DRAFT = `plate-reader-${RUN}-draft.csv`;
const V1 = `well,od600\nA1,0.412\nA2,0.398\n`;
const V2 = `well,od600\nA1,0.415\nA2,0.401\nA3,0.388\n`;
const VERSION_NOTE = `Re-read after recalibration ${RUN}`;
const TAG = `e2e-${RUN}`;

let scientist: { context: BrowserContext; page: Page };
let head: { context: BrowserContext; page: Page };
let fileId = '';
let folderId = '';
let draftId = '';

interface FileDto {
  id: string;
  displayName: string;
  folderId: string;
  tags: string[];
  metadata: Record<string, unknown>;
  versionCount: number;
  approvalStatus?: string;
  status?: string;
  isStarred?: boolean;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  scientist = await contextFor(browser, 'scientist');
  head = await contextFor(browser, 'head');
});

test.afterAll(async () => {
  await scientist?.context.close();
  await head?.context.close();
});

async function openActions(page: Page, name: string, item: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${name}` }).first().click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function openDetails(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await openActions(page, FILE, 'Details');
  const sheet = page.getByRole('dialog').filter({ hasText: 'Version history' });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function closeDialogs(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('My Drive → create a folder', async () => {
  const { page } = scientist;
  await page.goto('/my-drive');
  await page.getByRole('button', { name: 'New folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder' });
  await dialog.getByLabel('Name').fill(FOLDER);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('button', { name: FOLDER, exact: true })).toBeVisible();

  await page.getByRole('button', { name: FOLDER, exact: true }).click();
  await page.waitForURL(/\/drive\/[^/]+$/);
  folderId = page.url().split('/drive/')[1]!;
  await expect(page.getByText('This folder is empty')).toBeVisible();
});

test('upload a file into it', async () => {
  const { page } = scientist;
  await page.locator('input[type=file]').first().setInputFiles({
    name: FILE,
    mimeType: 'text/csv',
    buffer: Buffer.from(V1),
  });
  const tray = page.getByRole('region', { name: 'Uploads' });
  await expect(tray.getByLabel('Uploaded')).toBeVisible();
  await expect(page.getByRole('button', { name: FILE, exact: true })).toBeVisible();

  const listing = await api<{ files: FileDto[] }>(page.request, `/api/folders/${folderId}/children`);
  const found = listing.files.find((file) => file.displayName === FILE);
  expect(found, 'the uploaded file is in the database').toBeTruthy();
  fileId = found!.id;
});

test('view it, and add research metadata and a tag', async () => {
  const { page } = scientist;
  const sheet = await openDetails(page);
  await expect(sheet.getByText(FILE).first()).toBeVisible();

  await sheet.getByLabel('Study').fill(`Growth curve ${RUN}`);
  await sheet.getByLabel('Tags').fill(TAG);
  await sheet.getByLabel('Tags').press('Enter');
  await sheet.getByRole('button', { name: 'Save metadata' }).click();
  await expect(page.getByText('Research metadata saved')).toBeVisible();
  await closeDialogs(page);

  const saved = await api<FileDto>(page.request, `/api/files/${fileId}`);
  expect(saved.tags).toContain(TAG);
  expect(JSON.stringify(saved.metadata)).toContain(`Growth curve ${RUN}`);
});

test('search finds it by name', async () => {
  const { page } = scientist;
  const box = page.getByRole('searchbox', { name: 'Search the drive' });
  await box.fill(`plate-reader-${RUN}`);
  await box.press('Enter');
  await page.waitForURL(/\/search\?/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`plate-reader-${RUN}`);
  await expect(page.getByRole('button', { name: new RegExp(FILE) }).first()).toBeVisible();
});

test('star it, and find it under Starred and Recent', async () => {
  const { page } = scientist;
  await page.goto(`/drive/${folderId}`);
  await openActions(page, FILE, 'Add star');
  await expect(page.getByText('Added to Starred')).toBeVisible();

  await page.goto('/starred');
  await expect(page.getByRole('heading', { name: 'Starred' })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(FILE) }).first()).toBeVisible();

  await page.goto('/recent');
  await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(FILE) }).first()).toBeVisible();
});

test('the second user cannot see it before it is shared', async () => {
  const response = await head.page.request.get(`/api/files/${fileId}`);
  expect([403, 404]).toContain(response.status());
});

test('share it with the department head — and cannot give away more than it holds', async () => {
  const { page } = scientist;
  await page.goto(`/drive/${folderId}`);
  await openActions(page, FILE, 'Share');
  const dialog = page.getByRole('dialog', { name: new RegExp(`Share .${FILE}.`) });
  await dialog.getByLabel('Add a colleague').fill('maya');
  await dialog.getByRole('button', { name: new RegExp(USERS.head.email) }).click();
  await dialog.getByLabel('Access level').click();
  await page.getByRole('option', { name: 'Approver', exact: true }).click();
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  // A research scientist holds no approval permission, so cannot delegate one.
  await expect(page.getByText(/cannot grant "approver" access/)).toBeVisible();

  await dialog.getByLabel('Access level').click();
  await page.getByRole('option', { name: 'Viewer', exact: true }).click();
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByRole('button', { name: `Remove ${USERS.head.name}` })).toBeVisible();
  await closeDialogs(page);
});

test('Shared with me → the second user sees and opens it', async () => {
  const { page } = head;
  await page.goto('/shared');
  await expect(page.getByRole('heading', { name: 'Shared with me' })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(FILE) }).first()).toBeVisible();
  const seen = await api<FileDto>(page.request, `/api/files/${fileId}`);
  expect(seen.displayName).toBe(FILE);
});

test('upload version 2 with a note', async () => {
  const { page } = scientist;
  await page.goto(`/drive/${folderId}`);
  const chooser = page.waitForEvent('filechooser');
  await openActions(page, FILE, 'Upload new version');
  await (await chooser).setFiles({ name: FILE, mimeType: 'text/csv', buffer: Buffer.from(V2) });

  const dialog = page.getByRole('dialog', { name: new RegExp(`New version of`) });
  await dialog.getByLabel('What changed?').fill(VERSION_NOTE);
  await dialog.getByRole('button', { name: 'Upload version 2' }).click();
  await expect(page.getByRole('region', { name: 'Uploads' }).getByLabel('Uploaded').first()).toBeVisible();

  await expect
    .poll(async () => (await api<FileDto>(page.request, `/api/files/${fileId}`)).versionCount)
    .toBe(2);
});

test('version history shows both versions and the note', async () => {
  const { page } = scientist;
  const sheet = await openDetails(page);
  await expect(sheet.getByText('Version 2', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Version 1', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Current', { exact: true })).toBeVisible();
  await expect(sheet.getByText(VERSION_NOTE)).toBeVisible();
  await closeDialogs(page);
});

test('an administrator, who holds approval, delegates it to the department head', async ({ browser }) => {
  // The owner is a research scientist with no review permission, so could not grant this
  // (asserted above). A viewer share carries no review right either: the server refuses to name
  // a reviewer who cannot review. Someone who *holds* approval has to delegate it.
  const before = await api<FileDto & { capabilities: { canReview: boolean; canApprove: boolean } }>(
    head.page.request,
    `/api/files/${fileId}`,
  );
  expect(before.capabilities).toMatchObject({ canReview: false, canApprove: false });

  const admin = await contextFor(browser, 'admin');
  try {
    const { page } = admin;
    await page.goto(`/drive/${folderId}`);
    await openActions(page, FILE, 'Share');
    const dialog = page.getByRole('dialog', { name: new RegExp(`Share .${FILE}.`) });
    await dialog.getByLabel('Add a colleague').fill('maya');
    await dialog.getByRole('button', { name: new RegExp(USERS.head.email) }).click();
    await dialog.getByLabel('Access level').click();
    await page.getByRole('option', { name: 'Approver', exact: true }).click();
    // The head is already listed from the viewer share, so "Remove Maya" proves nothing here:
    // wait for the share request itself, or closing the context below aborts it in flight.
    const shared = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/api/files/${fileId}/permissions`),
    );
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
    expect((await shared).status()).toBe(200);
    await closeDialogs(page);
  } finally {
    await admin.context.close();
  }

  await expect
    .poll(async () =>
      (await api<{ capabilities: { canReview: boolean; canApprove: boolean } }>(head.page.request, `/api/files/${fileId}`))
        .capabilities,
    )
    .toMatchObject({ canReview: true, canApprove: true });
});

test('request a review from the department head', async () => {
  const { page } = scientist;
  const sheet = await openDetails(page);
  await sheet.getByRole('button', { name: 'Submit for review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit for review' });
  // Exact: "Note for the reviewers" also contains the word.
  await dialog.getByLabel('Reviewers', { exact: true }).fill('maya');
  await dialog.getByRole('button', { name: new RegExp(USERS.head.email) }).click();
  await dialog.getByLabel('Note for the reviewers').fill(`Please approve run ${RUN}`);
  await dialog.getByRole('button', { name: 'Send for review' }).click();
  await expect(page.getByText('Sent for review')).toBeVisible();
  await closeDialogs(page);
});

test('the department head approves version 2', async () => {
  const { page } = head;
  await page.goto('/reviews');
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
  const card = page.locator('div').filter({ hasText: FILE }).filter({
    has: page.getByRole('button', { name: 'Approve version 2' }),
  }).last();
  await card.getByRole('button', { name: 'Approve version 2' }).click();
  await expect(page.getByText('Approved version 2')).toBeVisible();

  await expect
    .poll(async () => (await api<FileDto>(scientist.page.request, `/api/files/${fileId}`)).approvalStatus)
    .toBe('approved');
});

test('move the folder into another folder', async () => {
  const { page } = scientist;
  await page.goto('/my-drive');
  await page.getByRole('button', { name: 'New folder' }).click();
  const create = page.getByRole('dialog', { name: 'New folder' });
  await create.getByLabel('Name').fill(TARGET_FOLDER);
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('button', { name: TARGET_FOLDER, exact: true })).toBeVisible();

  await openActions(page, FOLDER, 'Move to…');
  const picker = page.getByRole('dialog', { name: `Move "${FOLDER}"` });
  await picker.getByRole('button', { name: TARGET_FOLDER }).click();
  await picker.getByRole('button', { name: 'Move here' }).click();
  await expect(page.getByText(`Moved "${FOLDER}"`)).toBeVisible();
  await expect(page.getByRole('button', { name: FOLDER, exact: true })).toHaveCount(0);

  const moved = await api<{ folder: { parentFolderId: string | null }; breadcrumbs: { name: string }[] }>(
    page.request,
    `/api/folders/${folderId}`,
  );
  const found = await api<{ folders: { id: string; name: string }[] }>(
    page.request,
    `/api/search?q=${encodeURIComponent(TARGET_FOLDER)}`,
  );
  const target = found.folders.find((folder) => folder.name === TARGET_FOLDER);
  expect(target, 'the target folder is searchable').toBeTruthy();
  expect(moved.folder.parentFolderId).toBe(target!.id);
  expect(moved.breadcrumbs.map((crumb) => crumb.name)).toContain(TARGET_FOLDER);
});

test('an approved file cannot be trashed', async () => {
  const { page } = scientist;
  await page.goto(`/drive/${folderId}`);
  await page.getByRole('button', { name: `Actions for ${FILE}` }).first().click();
  // An approved version is read-only; replacing it means uploading a new version.
  await expect(page.getByRole('menuitem', { name: 'Move to trash', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  // The server refuses it too, not only the menu — and for this reason, not a missing token.
  const response = await mutate(page, 'DELETE', `/api/files/${fileId}`);
  expect(response.status()).toBe(403);
  expect(await response.text()).toContain('This file is approved and cannot be deleted');
  expect((await api<FileDto>(page.request, `/api/files/${fileId}`)).status).toBe('active');
});

test('trash a draft file, then restore it from Trash', async () => {
  const { page } = scientist;
  await page.goto(`/drive/${folderId}`);
  // The listing has rendered, so the page is hydrated and the upload input is wired up.
  await expect(page.getByRole('button', { name: `Actions for ${FILE}` })).toBeVisible();
  await page.locator('input[type=file]').first().setInputFiles({
    name: DRAFT,
    mimeType: 'text/csv',
    buffer: Buffer.from(V1),
  });
  await expect(page.getByRole('region', { name: 'Uploads' }).getByLabel('Uploaded').first()).toBeVisible();
  await expect(page.getByRole('button', { name: `Actions for ${DRAFT}` })).toBeVisible();
  const listing = await api<{ files: FileDto[] }>(page.request, `/api/folders/${folderId}/children`);
  draftId = listing.files.find((file) => file.displayName === DRAFT)!.id;

  await openActions(page, DRAFT, 'Move to trash');
  await expect(page.getByText(`Moved "${DRAFT}" to trash`)).toBeVisible();
  expect((await page.request.get(`/api/files/${draftId}`)).status()).not.toBe(200);

  await page.goto('/trash');
  await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
  const row = page.locator('li, tr, div').filter({ hasText: DRAFT }).filter({
    has: page.getByRole('button', { name: 'Restore' }),
  }).last();
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText(`Restored "${DRAFT}"`)).toBeVisible();

  const restored = await api<FileDto>(page.request, `/api/files/${draftId}`);
  expect(restored.folderId).toBe(folderId);
});

test('preview and download return the current bytes; version 1 is still retrievable', async () => {
  const { page } = scientist;
  const download = await page.request.get(`/api/files/${fileId}/download`);
  expect(download.status()).toBe(200);
  expect(await download.text()).toBe(V2);

  const preview = await page.request.get(`/api/files/${fileId}/preview`);
  expect(preview.status()).toBe(200);
  expect(await preview.text()).toContain('A3,0.388');

  const versions = await api<{ id: string; versionNumber: number }[] | { items: { id: string; versionNumber: number }[] }>(
    page.request,
    `/api/files/${fileId}/versions`,
  );
  const list = Array.isArray(versions) ? versions : versions.items;
  const v1 = list.find((version) => version.versionNumber === 1)!;
  const old = await page.request.get(`/api/files/${fileId}/download?versionId=${v1.id}`);
  expect(await old.text()).toBe(V1);

  // And through the browser: the UI's Download item produces a real download.
  await page.goto(`/drive/${folderId}`);
  const event = page.waitForEvent('download');
  await openActions(page, FILE, 'Download');
  expect((await event).suggestedFilename()).toBe(FILE);
});

test('the audit log recorded the day', async ({ browser }) => {
  const admin = await contextFor(browser, 'admin');
  try {
    await admin.page.goto('/admin/audit-logs');
    await expect(admin.page.getByText('Audit log').first()).toBeVisible();
    await expect(admin.page.getByRole('table')).toBeVisible();

    const logs = await api<{ action: string; outcome: string }[]>(
      admin.page.request,
      `/api/admin/audit-logs?entityId=${fileId}&page=1&pageSize=100`,
    );
    const actions = new Set(logs.map((entry) => entry.action));
    const draftLogs = await api<{ action: string }[]>(
      admin.page.request,
      `/api/admin/audit-logs?entityId=${draftId}&page=1&pageSize=100`,
    );
    for (const expected of ['resource.delete', 'resource.restore']) {
      expect(draftLogs.map((entry) => entry.action), `${expected} missing for the draft`).toContain(expected);
    }
    for (const expected of [
      'file.upload',
      'file.metadata_updated',
      'file.share',
      'file.version_upload',
      'file.review_requested',
      'file.approve',
      'file.download',
      'file.preview',
    ]) {
      expect(actions, `${expected} missing from [${[...actions].join(', ')}]`).toContain(expected);
    }
  } finally {
    await admin.context.close();
  }
});
