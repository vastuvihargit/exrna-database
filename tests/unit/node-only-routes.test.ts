/**
 * The Node-only administrative tools answer a Worker with a controlled 501, before any service
 * — and so before any Mongoose model or `node:fs` call — runs.
 *
 * Two halves: the wrapper's behaviour, and a structural check that every route file under the
 * three Node-only trees goes through it. The structural half is what stops a new route in
 * `admin/storage-migration/` from quietly shipping unguarded.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setRuntimeOverride } from '@/server/runtime';
import { NodeOnlyOperationError, nodeOnly } from '@/server/http/node-only';
import { toErrorResponse } from '@/server/http/api-response';
import type { AuthenticatedContext } from '@/server/http/authenticated-route';

afterEach(() => setRuntimeOverride(null));

const request = {} as NextRequest;
const context = {} as AuthenticatedContext<Record<string, string>>;

describe('nodeOnly', () => {
  it('on a Worker, refuses with 501 NODE_ONLY_OPERATION without calling the handler', async () => {
    setRuntimeOverride('workerd');
    const handler = vi.fn(async () => new Response('ran'));
    const guarded = nodeOnly('Import from Google Drive', handler);

    expect(() => guarded(request, context)).toThrow(NodeOnlyOperationError);
    expect(handler).not.toHaveBeenCalled();

    let thrown: unknown;
    try {
      guarded(request, context);
    } catch (error) {
      thrown = error;
    }
    const response = toErrorResponse(thrown, 'req-1');
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NODE_ONLY_OPERATION');
    expect(body.error.message).toContain('Import from Google Drive');
  });

  it('on Node, is transparent', async () => {
    setRuntimeOverride('node');
    const guarded = nodeOnly('Import from Google Drive', async () => new Response('ran'));
    expect(await (await guarded(request, context)).text()).toBe('ran');
  });
});

describe('the Node-only route trees', () => {
  const API = path.resolve(__dirname, '../../src/app/api/admin');
  const trees = ['migrations', 'storage-migration', 'storage/local-copies'];

  const routeFiles = trees.flatMap((tree) => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'route.ts') found.push(full);
      }
    };
    walk(path.join(API, tree));
    return found;
  });

  it('finds the routes it is meant to guard', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(19);
  });

  it.each(routeFiles.map((file) => [path.relative(API, file), file]))(
    '%s exports every handler through withNodeOnlyRoute',
    (_name, file) => {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/withAuthenticatedRoute|withRouteHandler/);
      const handlers = [...source.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE) = (\w+)/gm)];
      expect(handlers.length).toBeGreaterThan(0);
      for (const [, method, wrapper] of handlers) {
        expect(wrapper, `${method} is not guarded`).toBe('withNodeOnlyRoute');
      }
    },
  );
});
