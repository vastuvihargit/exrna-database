/**
 * Stands in for `@node-rs/argon2` in the Cloudflare Worker build.
 *
 * `@node-rs/argon2` is a native Rust N-API addon. There is no Worker build of it and there
 * cannot be one — workerd loads no native code. Argon2id also has no WebCrypto equivalent,
 * so the existing `passwordHash` values in the database **cannot be verified in a Worker by
 * any means**. Substituting PBKDF2 would not "degrade gracefully"; it would reject every
 * correct password, because the stored hashes are Argon2id.
 *
 * This is therefore a refusal, not a fallback. Phase 8 replaces password login with
 * Cloudflare Access, after which the dependency, the `passwordHash` column and this shim are
 * all deleted together (Phase 9). Until then the Node deployment carries password login and
 * the Worker does not.
 *
 * The error is deliberately explicit about *why*, because the alternative — a Worker that
 * simply returns "invalid credentials" — would look like a password problem to every
 * employee and to whoever is on support.
 */

const UNAVAILABLE =
  'Password verification is not available on this deployment. This application signs in ' +
  'through the company Google Workspace account via Cloudflare Access. If you are seeing ' +
  'this message, the deployment is misconfigured — password login is served only by the ' +
  'Node deployment.';

export async function hash(): Promise<string> {
  throw new Error(UNAVAILABLE);
}

export async function verify(): Promise<boolean> {
  throw new Error(UNAVAILABLE);
}

export const Algorithm = { Argon2d: 0, Argon2i: 1, Argon2id: 2 } as const;
