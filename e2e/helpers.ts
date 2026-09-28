import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { E2E_PASSWORD, USERS } from './env';

export type Persona = keyof typeof USERS;

/** Signs in through the real login form and waits for the authenticated shell. */
export async function signIn(page: Page, who: Persona): Promise<void> {
  await signInAs(page, USERS[who].email, E2E_PASSWORD);
}

/** The same form, for an account the suite created itself. */
export async function signInAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** A fresh browser context signed in as `who` — one per persona, like separate laptops. */
export async function contextFor(browser: Browser, who: Persona): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, who);
  return { context, page };
}

/**
 * Reads the real API with the page's own session cookie. Used to *assert* backend state after
 * a UI action — never to stand in for a response.
 */
export async function api<T = unknown>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), `${path} → ${response.status()} ${await response.text().catch(() => '')}`).toBe(200);
  const body = (await response.json()) as { data?: T } & T;
  return (body.data ?? body) as T;
}

/** CSRF-aware JSON call through the page's session, for steps with no UI yet. */
export async function send<T = unknown>(
  page: Page,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await page.request.fetch(path, {
    method,
    data,
    headers: { origin: new URL(page.url()).origin },
  });
  const text = await response.text();
  expect(response.ok(), `${method} ${path} → ${response.status()} ${text}`).toBeTruthy();
  const body = text ? (JSON.parse(text) as { data?: T } & T) : ({} as T & { data?: T });
  return (body.data ?? body) as T;
}
