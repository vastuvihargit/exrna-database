/**
 * The single reference to `@node-rs/argon2` in the codebase.
 *
 * This indirection exists for one reason: it gives the Cloudflare build a **local module
 * path** to replace. A `resolve.alias` on the bare specifier `@node-rs/argon2` does not
 * work, because Next.js auto-externalizes packages carrying native bindings — webpack
 * therefore never resolves it, emits a bare `require()`, and OpenNext's esbuild pass picks
 * it up from `node_modules` and fails on the `.node` binary.
 *
 * Replacing this file instead sidesteps externalization entirely: it is ordinary
 * application source, webpack always resolves it, and `NormalModuleReplacementPlugin` in
 * `next.config.ts` swaps it for `src/server/shims/argon2.worker.ts` on the Cloudflare build.
 * The same technique is already used in this repository for the dev switcher.
 *
 * The Node deployment imports this file and gets the real package, unchanged.
 */
export { hash, verify } from '@node-rs/argon2';
