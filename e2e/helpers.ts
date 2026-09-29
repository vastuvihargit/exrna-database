import { expect, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Page } from '@playwright/test';
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

/**
 * A fresh browser context with its own client address, like a separate laptop.
 *
 * The dev server has no proxy in front of it, so every context would otherwise share one address
 * and the suite's sign-ins would add up against the real per-IP sign-in limit, which is left at
 * its production value. The addresses are from TEST-NET-3 (RFC 5737), never routable.
 */
export async function newMachine(browser: Browser): Promise<BrowserContext> {
  const host = 1 + Math.floor(Math.random() * 254);
  return browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${host}` } });
}

/** A fresh browser context signed in as `who` — one per persona, like separate laptops. */
export async function contextFor(browser: Browser, who: Persona): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newMachine(browser);
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

/**
 * A mutating request exactly as the application's own client makes it: the session cookie, the
 * Origin, and the double-submit CSRF token echoed from the readable `bd_csrf` cookie. Without
 * the token every mutation is refused with 401 before it reaches the route, so a test asserting
 * a *refusal* would pass for the wrong reason.
 */
export async function mutate(
  page: Page,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<APIResponse> {
  const origin = new URL(page.url()).origin;
  const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === 'bd_csrf');
  return page.request.fetch(path, {
    method,
    data,
    headers: { origin, ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf.value) } : {}) },
  });
}

/** CSRF-aware JSON call through the page's session, for steps with no UI yet. */
export async function send<T = unknown>(
  page: Page,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await mutate(page, method, path, data);
  const text = await response.text();
  expect(response.ok(), `${method} ${path} → ${response.status()} ${text}`).toBeTruthy();
  const body = text ? (JSON.parse(text) as { data?: T } & T) : ({} as T & { data?: T });
  return (body.data ?? body) as T;
}
