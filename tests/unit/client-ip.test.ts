/**
 * Which address the per-IP limits count against.
 *
 * Cloudflare and the Node deployment's nginx both *append* to X-Forwarded-For, so its first
 * entry is whatever the client wrote. Keyed on that, the sign-in limit could be reset by sending
 * a new header with every attempt. CF-Connecting-IP (Cloudflare) and X-Real-IP (nginx,
 * `$remote_addr`) are overwritten by the proxy and so cannot be chosen by the client.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { buildRequestContext } from '@/server/http/route-handler';

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest('https://drive.example.com/api/auth/login', { method: 'POST', headers });
}

describe('buildRequestContext — client address', () => {
  it('on Cloudflare, uses CF-Connecting-IP, not a client-written X-Forwarded-For', () => {
    const context = buildRequestContext(
      request({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 203.0.113.7' }),
    );
    expect(context.ip).toBe('203.0.113.7');
  });

  it('behind nginx, uses X-Real-IP, not a client-written X-Forwarded-For', () => {
    const context = buildRequestContext(
      request({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }),
    );
    expect(context.ip).toBe('203.0.113.9');
  });

  it('with no proxy, falls back to X-Forwarded-For, then to "unknown"', () => {
    expect(buildRequestContext(request({ 'x-forwarded-for': '198.51.100.1, 10.0.0.2' })).ip).toBe('198.51.100.1');
    expect(buildRequestContext(request({})).ip).toBe('unknown');
  });
});
