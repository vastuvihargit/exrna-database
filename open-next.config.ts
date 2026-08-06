import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * OpenNext → Cloudflare Workers build configuration.
 *
 * Phase 1 keeps this deliberately minimal. The caching overrides OpenNext offers (R2
 * incremental cache, D1 tag cache, KV queue) are all *additional* Cloudflare products, and
 * this application does not use Next.js ISR or on-demand revalidation at all — every page
 * that matters is `force-dynamic` behind an authenticated session. Wiring up a cache the
 * application never populates would be infrastructure with no reader.
 *
 * The one thing configured here is aliasing: three dependencies cannot exist in a Worker,
 * and each is replaced by a shim that fails loudly rather than silently.
 *
 *   @node-rs/argon2  native Rust addon; no Worker build exists. Password login is replaced
 *                    by Cloudflare Access in Phase 8, at which point the dependency is
 *                    deleted outright. Until then the shim refuses with a clear message.
 *
 *   pino             targets Node streams and, via pino-pretty, worker threads. The shim is
 *                    a structured console logger that Workers Logs ingests directly, and it
 *                    reimplements the redaction list — which is the part that matters.
 *
 *   pino-pretty      development-only formatting; nothing to replace.
 *
 * Mongoose is **not** aliased. It bundles under `nodejs_compat` and fails at connect time
 * with a network error, which is the honest Phase 1 state: the Worker builds and serves
 * every route that does not need the database, and Phase 3 replaces the repositories with
 * D1. Stubbing it would hide that boundary rather than mark it.
 */
export default defineCloudflareConfig({
  // Defaults everywhere. See the note above on why no cache override is configured, and
  // `next.config.ts` for where the three Worker-incompatible dependencies are aliased.
});
