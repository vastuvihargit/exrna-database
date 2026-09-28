/**
 * Administration through the real UI: a department, an employee in it, a role granted at a
 * department scope, project membership — and each checked from the *employee's* side, through
 * what their own session can actually reach. Deactivation ends it.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { api, contextFor, send, signInAs } from './helpers';
import { E2E_PASSWORD } from './env';

const RUN = Date.now().toString(36);
const DEPARTMENT = `Proteomics ${RUN}`;
const DEPARTMENT_CODE = `PRT${RUN}`.toUpperCase().slice(0, 12);
const EMPLOYEE = { name: `Noor Haddad ${RUN}`, email: `noor.${RUN}@company.com` };
const PROJECT = { name: `Biomarker panel ${RUN}`, code: `BMK-${RUN}`.toUpperCase() };

interface Drive {
  id: string;
  name: string;
  code?: string;
}
interface Drives {
  departments: Drive[];
  projects: Drive[];
}

let admin: { context: BrowserContext; page: Page };
let employee: { context: BrowserContext; page: Page };
let employeeId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  admin = await contextFor(browser, 'admin');
});

test.afterAll(async () => {
  await admin?.context.close();
  await employee?.context.close();
});

async function drivesOf(page: Page): Promise<Drives> {
  return api<Drives>(page.request, '/api/drives');
}

async function pick(page: Page, dialog: ReturnType<Page['getByRole']>, label: string, option: string | RegExp) {
  await dialog.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option }).click();
}

test('create a department', async () => {
  const { page } = admin;
  await page.goto('/admin/departments');
  await page.getByRole('button', { name: 'New department' }).click();
  const dialog = page.getByRole('dialog', { name: 'New department' });
  await dialog.getByLabel('Name').fill(DEPARTMENT);
  await dialog.getByLabel('Code').fill(DEPARTMENT_CODE);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(DEPARTMENT).first()).toBeVisible();
});

test('add an employee to it as a Research Scientist', async () => {
  const { page } = admin;
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Add employee' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add employee' });
  await dialog.getByLabel('Work email').fill(EMPLOYEE.email);
  await dialog.getByLabel('Full name').fill(EMPLOYEE.name);
  await pick(page, dialog, 'Department', new RegExp(DEPARTMENT_CODE));
  await pick(page, dialog, 'Initial role', 'Research Scientist');
  await pick(page, dialog, 'Status', /^Active/);
  await dialog.getByLabel('Temporary password (optional)').fill(E2E_PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByLabel('Search employees').fill(EMPLOYEE.email);
  await expect(page.getByRole('button', { name: `Actions for ${EMPLOYEE.name}` })).toBeVisible();

  const users = await api<{ id: string; email: string }[]>(
    page.request,
    `/api/admin/users?search=${encodeURIComponent(EMPLOYEE.email)}`,
  );
  employeeId = users.find((user) => user.email === EMPLOYEE.email)!.id;
  expect(employeeId).toBeTruthy();
});

test('the employee signs in and reaches only their own department', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAs(page, EMPLOYEE.email, E2E_PASSWORD);
  employee = { context, page };

  const drives = await drivesOf(page);
  const codes = drives.departments.map((drive) => drive.code);
  expect(codes).toContain(DEPARTMENT_CODE);
  expect(codes, 'no grant yet on Molecular Biology').not.toContain('MOLBIO');
});

test('grant a department-scoped role — and the employee is signed out by it', async () => {
  const { page } = admin;
  await page.goto('/admin/users');
  await page.getByLabel('Search employees').fill(EMPLOYEE.email);
  await page.getByRole('button', { name: `Actions for ${EMPLOYEE.name}` }).click();
  await page.getByRole('menuitem', { name: 'Manage roles' }).click();

  const dialog = page.getByRole('dialog', { name: `Roles — ${EMPLOYEE.name}` });
  await pick(page, dialog, 'Role', 'Lab Technician');
  await pick(page, dialog, 'Scope', 'department');
  await pick(page, dialog, 'Department', /^MOLBIO/);
  await dialog.getByRole('button', { name: 'Grant role' }).click();
  await expect(dialog.getByRole('button', { name: 'Revoke Lab Technician' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Changing roles revokes the employee's sessions so the new permissions apply at once.
  expect((await employee.page.request.get('/api/drives')).status()).toBe(401);
});

test('after signing in again, the new department is reachable', async () => {
  await signInAs(employee.page, EMPLOYEE.email, E2E_PASSWORD);
  const codes = (await drivesOf(employee.page)).departments.map((drive) => drive.code);
  expect(codes).toContain('MOLBIO');
  expect(codes).toContain(DEPARTMENT_CODE);
});

test('project access follows membership', async () => {
  // No project-creation screen exists yet, so the administrator uses the API the UI would.
  const departments = await api<{ id: string; code: string }[]>(admin.page.request, '/api/departments');
  const molbio = departments.find((department) => department.code === 'MOLBIO')!;
  const project = await send<{ id: string }>(admin.page, 'POST', '/api/projects', {
    name: PROJECT.name,
    code: PROJECT.code,
    departmentId: molbio.id,
    confidentiality: 'confidential',
  });
  expect((await drivesOf(employee.page)).projects.map((drive) => drive.name)).not.toContain(PROJECT.name);
  expect((await employee.page.request.get(`/api/projects/${project.id}`)).status()).toBe(404);

  await send(admin.page, 'PATCH', `/api/projects/${project.id}`, { memberUserIds: [employeeId] });

  // What the employee's own browser shows, not only the API.
  await employee.page.goto('/projects');
  await expect(employee.page.getByText(PROJECT.name).first()).toBeVisible();
  expect((await employee.page.request.get(`/api/projects/${project.id}`)).status()).toBe(200);
});

test('a deactivated employee is refused, session and sign-in alike', async () => {
  const { page } = admin;
  await page.goto('/admin/users');
  await page.getByLabel('Search employees').fill(EMPLOYEE.email);
  await page.getByRole('button', { name: `Actions for ${EMPLOYEE.name}` }).click();
  await page.getByRole('menuitem', { name: 'Deactivate' }).click();
  const dialog = page.getByRole('dialog', { name: `Deactivate ${EMPLOYEE.name}?` });
  await dialog.getByLabel('Reason (recorded in the audit log)').fill(`E2E run ${RUN}`);
  await dialog.getByRole('button', { name: 'Deactivate' }).click();
  await expect(dialog).toHaveCount(0);

  expect((await employee.page.request.get('/api/drives')).status()).toBe(401);

  await employee.page.goto('/login');
  await employee.page.getByLabel('Work email').fill(EMPLOYEE.email);
  await employee.page.getByLabel('Password').fill(E2E_PASSWORD);
  await employee.page.getByRole('button', { name: 'Sign in' }).click();
  await expect(employee.page).toHaveURL(/\/login/);
  expect((await employee.page.request.get('/api/drives')).status()).toBe(401);
});
