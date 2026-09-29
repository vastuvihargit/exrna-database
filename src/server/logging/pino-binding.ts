/**
 * The single reference to `pino` in the codebase.
 *
 * Same reasoning as `src/server/auth/argon2-binding.ts`: Next.js auto-externalizes pino, so
 * a `resolve.alias` on the bare specifier is never consulted. Replacing this local module is
 * what actually keeps pino out of the Worker bundle.
 *
 * `next.config.ts` swaps it for `src/server/shims/pino.worker.ts` on the Cloudflare build.
 * That shim reimplements the redaction list, which is the part of pino's configuration this
 * application depends on for security rather than for formatting.
 */
export { default } from 'pino';
export type { Logger } from 'pino';
