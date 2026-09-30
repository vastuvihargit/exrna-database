/**
 * The header configuration, asserted as configuration.
 *
 * Next applies the headers from `next.config.ts` *after* a route handler has built its
 * response, so a configured header silently wins over the same header set in code. That
 * bit the inline-preview route once: the application CSP replaced the sandbox policy the
 * preview response set for itself, and its `frame-ancestors 'none'` also stopped the
 * preview being embedded in our own viewer. Nothing failed loudly — the preview simply
 * carried the wrong policy.
 *
 * These tests describe the split that fixes it, so the same silent regression cannot
 * come back.
 */
import { describe, expect, it } from 'vitest';

import config from '../../next.config';
import type { NextConfig } from 'next';

const PREVIEW_PATH = '/api/files/6a6ae152e89e7c6f88ce6b1b/preview';

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

async function headerRules(): Promise<HeaderRule[]> {
  const headers = (config as NextConfig).headers;
  if (!headers) throw new Error('next.config.ts defines no headers()');
  return (await headers()) as HeaderRule[];
}

/** Mirrors how Next matches a `source` pattern, closely enough for these assertions. */
function matches(source: string, pathname: string): boolean {
  const pattern = source
    // `/:param*` and `/:param` become path segments.
    .replace(/\/:[A-Za-z0-9_]+\*/g, '(?:/.*)?')
    .replace(/\/:[A-Za-z0-9_]+/g, '/[^/]+');
  return new RegExp(`^${pattern}$`).test(pathname);
}

function headersFor(rules: HeaderRule[], pathname: string): Map<string, string> {
  const applied = new Map<string, string>();
  for (const rule of rules) {
    if (!matches(rule.source, pathname)) continue;
    for (const header of rule.headers) applied.set(header.key.toLowerCase(), header.value);
  }
  return applied;
}

describe('application security headers', () => {
  it('sends framing and referrer policy on ordinary routes', async () => {
    const applied = headersFor(await headerRules(), '/home');

    expect(applied.get('x-frame-options')).toBe('DENY');
    expect(applied.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(applied.get('x-content-type-options')).toBe('nosniff');
  });

  /**
   * Pages get their CSP from the middleware, with a per-request nonce. A static policy here
   * would be a second CSP header; browsers enforce both, so its `script-src` without the nonce
   * would still block the App Router's inline bootstrap scripts — the blank /login on staging.
   */
  it('configures no static CSP on page routes, which the nonce policy covers', async () => {
    for (const page of ['/', '/login', '/home', '/drive/6a6ae145e89e7c6f88ce6af9', '/admin/users']) {
      expect(headersFor(await headerRules(), page).has('content-security-policy'), page).toBe(false);
    }
  });

  it('keeps a static CSP, without inline script, on API routes', async () => {
    const csp = headersFor(await headerRules(), '/api/auth/session').get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp.split(';').find((d) => d.trim().startsWith('script-src'))).not.toContain('unsafe-inline');
  });

  it('does not configure a CSP for the inline preview route', async () => {
    const applied = headersFor(await headerRules(), PREVIEW_PATH);

    // The route sets its own sandbox policy; a configured one would replace it.
    expect(applied.has('content-security-policy')).toBe(false);
    // Likewise the framing and referrer headers the sandbox policy supersedes.
    expect(applied.has('x-frame-options')).toBe(false);
    expect(applied.has('referrer-policy')).toBe(false);
    // Everything that does not conflict is still applied.
    expect(applied.get('x-content-type-options')).toBe('nosniff');
    expect(applied.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('still configures a CSP for the download route, which is never rendered', async () => {
    const applied = headersFor(
      await headerRules(),
      '/api/files/6a6ae152e89e7c6f88ce6b1b/download',
    );
    expect(applied.get('content-security-policy')).toContain("default-src 'self'");
  });
});

describe('inline preview response policy', () => {
  it('sandboxes the previewed document and permits same-origin framing only', async () => {
    const { streamFile } = await import('@/server/http/file-response');
    const { Readable } = await import('stream');

    const response = streamFile(
      {
        body: Readable.from(Buffer.from('sample,reading\n')),
        contentLength: 15,
        totalSize: 15,
        contentType: 'text/csv',
        contentDisposition: 'inline; filename="a.csv"',
        displayName: 'a.csv',
        etag: '"abc"',
        fileId: 'f',
        versionId: 'v',
        versionNumber: 1,
      },
      'GET',
      { sandbox: true },
    );

    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox');
    expect(csp).toContain("default-src 'none'");
    // Framed by our own viewer, by nobody else.
    expect(csp).toContain("frame-ancestors 'self'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('does not sandbox a download, and never announces a renderable type', async () => {
    const { streamFile } = await import('@/server/http/file-response');
    const { Readable } = await import('stream');

    const response = streamFile(
      {
        body: Readable.from(Buffer.from('bytes')),
        contentLength: 5,
        totalSize: 5,
        contentType: 'application/octet-stream',
        contentDisposition: 'attachment; filename="a.csv"',
        displayName: 'a.csv',
        etag: '"abc"',
        fileId: 'f',
        versionId: 'v',
        versionNumber: 1,
      },
      'GET',
    );

    expect(response.headers.has('content-security-policy')).toBe(false);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
  });
});
