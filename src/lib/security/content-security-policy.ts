/**
 * The application Content-Security-Policy, built in one place.
 *
 * ── Why a nonce ─────────────────────────────────────────────────────────────────────────
 *
 * The App Router streams the React Server Components payload as **inline** scripts
 * (`self.__next_f.push(…)`) and bootstraps hydration from them. A static `script-src 'self'`
 * blocks every one of those, so the server-rendered HTML arrives, nothing hydrates, and the
 * page stays blank — which is what staging showed on /login.
 *
 * `'unsafe-inline'` would let them run, and would equally let any injected script run, which is
 * what the policy exists to stop. Instead `src/middleware.ts` mints a fresh nonce per request,
 * sends it in this policy, and forwards the same policy on the *request*: Next.js reads the
 * nonce from the request's `Content-Security-Policy` header and stamps it on every script it
 * emits for that response (framework chunks, RSC payload, `next/script`). The root layout reads
 * it from `x-nonce` for the one third-party inline script, `next-themes`.
 *
 * `'strict-dynamic'` lets those nonced scripts load the chunks they import on navigation
 * without listing hosts; `'self'` stays for browsers that predate CSP level 3.
 *
 * ── Why this file does not import anything ─────────────────────────────────────────────
 *
 * It runs in the middleware (edge bundle, on the Worker) and in `next.config.ts` (Node, at
 * build time). Pure string building and Web Crypto work in both.
 */

export interface PolicyOptions {
  /** The per-request nonce, for documents. `null` for responses that never render HTML. */
  nonce: string | null;
  /** React's development refresh needs `eval`; production never does. */
  development: boolean;
}

export function buildContentSecurityPolicy({ nonce, development }: PolicyOptions): string {
  const scriptSources = ["'self'"];
  if (nonce) scriptSources.push(`'nonce-${nonce}'`, "'strict-dynamic'");
  if (development) scriptSources.push("'unsafe-eval'");

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    // Unchanged: component libraries (sonner, Radix) set inline `style` attributes, which a
    // nonce cannot cover. Style injection cannot execute script under this policy.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    // `'self'`, not `'none'`: the preview dialog embeds same-origin PDFs with <object>.
    "object-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** 128 bits from the platform CSPRNG, base64 — the shape the CSP grammar accepts. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The request header the root layout reads the nonce from. */
export const NONCE_HEADER = 'x-nonce';
