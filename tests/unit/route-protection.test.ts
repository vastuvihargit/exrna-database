/**
 * Structural guarantee: every API route is protected unless it is on an explicit
 * public allow-list.
 *
 * This catches the failure mode a permission matrix cannot — a new route handler that
 * simply forgets to authenticate. Adding a public route requires editing the list
 * below, which makes it a deliberate, reviewable decision.
 */
import { describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';

const API_ROOT = path.resolve(process.cwd(), 'src/app/api');

/** Routes that are unauthenticated by necessity. */
const PUBLIC_ROUTES = new Set([
  'health/route.ts',
  'health/ready/route.ts',
  'version/route.ts',
  'auth/providers/route.ts',
  'auth/login/route.ts',
  'auth/forgot-password/route.ts',
  'auth/reset-password/route.ts',
  'auth/google/route.ts',
  'auth/callback/google/route.ts',
  // The Cloudflare Access sign-in bridge: how a session is obtained, so it cannot require one.
  // It verifies the signed Access assertion itself and is 404 when Access is not configured.
  'auth/access/route.ts',
  // Queue delivery from the Worker entrypoint. Not a public route in any useful sense: it
  // demands an in-process token that never leaves the isolate, and is 404 otherwise.
  'internal/queues/route.ts',
  // Development-only. Unauthenticated because the switcher has to work while signed
  // out, which is the moment it is most useful. They are not protected by a session —
  // they are protected by not existing outside development, which the tests below
  // enforce structurally. The `.dev.ts` extension is what excludes them from the
  // production build (see `pageExtensions` in next.config.ts).
  'dev/users/route.dev.ts',
  'dev/switch-user/route.dev.ts',
]);

/** `route.ts` and `route.dev.ts` — the second is a route only in a development build. */
const ROUTE_FILENAMES = new Set(['route.ts', 'route.dev.ts']);

async function findRouteFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return findRouteFiles(full);
      return ROUTE_FILENAMES.has(entry.name) ? [full] : [];
    }),
  );
  return results.flat();
}

describe('API route protection', () => {
  it('every route either authenticates or is explicitly public', async () => {
    const files = await findRouteFiles(API_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const unprotected: string[] = [];

    for (const file of files) {
      const relative = path.relative(API_ROOT, file).split(path.sep).join('/');
      const source = await fsp.readFile(file, 'utf8');
      const authenticated = source.includes('withAuthenticatedRoute');

      if (!authenticated && !PUBLIC_ROUTES.has(relative)) unprotected.push(relative);
    }

    expect(
      unprotected,
      `These routes neither authenticate nor appear on the public allow-list: ${unprotected.join(', ')}`,
    ).toEqual([]);
  });

  it('every public route is a real file', async () => {
    for (const relative of PUBLIC_ROUTES) {
      const full = path.join(API_ROOT, relative);
      await expect(fsp.access(full), `${relative} is listed as public but does not exist`).resolves.toBeUndefined();
    }
  });

  it('admin routes additionally assert a company-scope permission', async () => {
    const files = await findRouteFiles(path.join(API_ROOT, 'admin'));
    const missing: string[] = [];

    for (const file of files) {
      const source = await fsp.readFile(file, 'utf8');
      const relative = path.relative(API_ROOT, file).split(path.sep).join('/');

      // Some admin routes delegate their checks to the service layer, which enforces a
      // narrower rule than "company scope" could express:
      //   • user/department routes scope by department, so a department head may
      //     administer their own people and nobody else's;
      //   • template routes are readable by any employee (a folder template is the
      //     folder names everyone already sees) and writable only with company-scoped
      //     access.manage, which `templateService` asserts.
      //   • every migration route — read included — requires company-scoped
      //     access.manage, asserted by `migrationService` before it will even confirm a
      //     job exists.
      // Every other admin route must gate explicitly, here, in the handler.
      const delegatesToService =
        source.includes('userService.') ||
        source.includes('departmentService.') ||
        source.includes('templateService.') ||
        source.includes('migrationService.');
      const asserts = source.includes('assertCompanyPermission');

      if (!delegatesToService && !asserts) missing.push(relative);
    }

    expect(missing, `Admin routes without an explicit permission check: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps every developer-only route out of the production build', async () => {
    // Two independent claims, both of which have to hold for the exclusion to work:
    //
    //   1. every route under /api/dev is named `route.dev.ts`, and
    //   2. next.config.ts only registers the `dev.*` extensions outside production.
    //
    // Renaming one of these files to `route.ts` would silently ship an anonymous
    // session-minting endpoint in the production artifact, and nothing else in the test
    // suite would notice — the runtime gate would still 404, so it would look fine.
    const devDir = path.join(API_ROOT, 'dev');
    const files = await findRouteFiles(devDir).catch(() => []);
    expect(files.length, 'expected at least one route under /api/dev').toBeGreaterThan(0);

    const wrongExtension = files
      .filter((file) => path.basename(file) !== 'route.dev.ts')
      .map((file) => path.relative(API_ROOT, file).split(path.sep).join('/'));

    expect(
      wrongExtension,
      `Developer routes must be named route.dev.ts to be excluded from the production build: ${wrongExtension.join(', ')}`,
    ).toEqual([]);

    const config = await fsp.readFile(path.resolve(process.cwd(), 'next.config.ts'), 'utf8');
    expect(config, 'next.config.ts must configure pageExtensions').toContain('pageExtensions');
    // The conditional is the load-bearing part: `dev.*` must be added only when the
    // build is not a production one.
    expect(config).toMatch(/process\.env\.NODE_ENV === 'production'[\s\S]{0,200}dev\.ts/);
  });

  it('every developer-only route asserts the dev gate before doing anything', async () => {
    // These routes are unauthenticated, so the environment gate is the *only* thing
    // standing between them and the outside world. A dev route that forgets it would be
    // an anonymous session-minting endpoint, which is the worst bug this repository
    // could ship — so it is checked structurally rather than trusted to review.
    const devDir = path.join(API_ROOT, 'dev');
    const files = await findRouteFiles(devDir).catch(() => []);
    expect(files.length, 'expected at least one route under /api/dev').toBeGreaterThan(0);

    const ungated: string[] = [];

    for (const file of files) {
      const source = await fsp.readFile(file, 'utf8');
      const relative = path.relative(API_ROOT, file).split(path.sep).join('/');

      // The assertion must be present, and it must come before any awaited work in the
      // handler — a gate that runs after a database query has already leaked timing and
      // done work on an attacker's behalf.
      const gateIndex = source.indexOf('assertDevToolingEnabled()');
      const firstAwait = source.indexOf('await ');

      if (gateIndex === -1) {
        ungated.push(`${relative} (no assertDevToolingEnabled call)`);
      } else if (firstAwait !== -1 && firstAwait < gateIndex) {
        ungated.push(`${relative} (awaits work before the gate)`);
      }
    }

    expect(ungated, `Ungated developer routes: ${ungated.join(', ')}`).toEqual([]);
  });

  it('no route returns a password hash, token hash or storage key', async () => {
    const files = await findRouteFiles(API_ROOT);
    const leaks: string[] = [];

    for (const file of files) {
      const source = await fsp.readFile(file, 'utf8');
      if (/passwordHash|tokenHash|csrfTokenHash|storageKey|relativeStoragePath/.test(source)) {
        leaks.push(path.relative(API_ROOT, file));
      }
    }

    expect(leaks, `Routes referencing internal fields: ${leaks.join(', ')}`).toEqual([]);
  });

  it('the internal queue route refuses anything without the in-process token', async () => {
    const source = await fsp.readFile(path.join(API_ROOT, 'internal/queues/route.ts'), 'utf8');
    // Constant-time comparison against the isolate's token, before the body is even parsed.
    expect(source).toContain('internalQueueToken()');
    expect(source).toContain('safeCompare(');
    expect(source.indexOf('safeCompare(')).toBeLessThan(source.indexOf('request.json()'));
    expect(source).toContain("throw new NotFoundError('Not found')");
  });

  it('the Access bridge exists only when Access is configured and trusts only the signed assertion', async () => {
    const source = await fsp.readFile(path.join(API_ROOT, 'auth/access/route.ts'), 'utf8');
    expect(source).toContain('if (!config) throw new NotFoundError');
    expect(source).toContain('readAccessToken(request.headers)');
    expect(source.toLowerCase()).not.toContain('cf-access-authenticated-user-email');
  });
});
