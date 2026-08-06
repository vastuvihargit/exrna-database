# Cloudflare Migration — Phase 1: Worker Compatibility

**Status:** complete. Database unchanged (still MongoDB/Mongoose). UI unchanged.
**Predecessor:** [`00-phase-0-analysis.md`](./00-phase-0-analysis.md)

---

## 1. What this phase did

Made the existing Next.js application build, bundle and run as a Cloudflare Worker, without
changing the database, the UI, or the Node deployment that currently serves production.

Two things were deliberately *not* done: no repository was touched (Phase 3), and no file
byte was moved (Phase 1a).

---

## 2. Decisions taken

Confirmed by the project owner, with the recommendations from Phase 0 §11 accepted as-is:

| # | Decision | Effect on this phase |
|---|---|---|
| 1 | Upload path: **direct browser → Drive resumable upload** | Interface seam only; the rewrite lands in Phase 4 |
| 2 | Drive storage cutover: **deferred to Phase 1a**, run separately | The Worker cannot serve file bytes yet — this is expected and visible in `/api/health/ready` |
| 3 | Malware scanning: **disabled in the Worker**, matching today's default | Unchanged in this phase; the ClamAV path is Node-only and stays so |
| 4 | Rate limiting: **Durable Object** | Interface seam only; the DO lands with Phase 3, when the Worker starts serving authenticated traffic |
| 5 | Access policy: **company email domain only** | `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` reserved in the Worker env schema for Phase 8 |

---

## 3. The crypto rewrite — the substantive change

Five modules moved from `node:crypto` to WebCrypto. This is the part of Phase 1 that
touched security-critical code, so it is described in full.

**One implementation, not two.** `crypto.getRandomValues`, `crypto.subtle` and
`crypto.randomUUID` are native in both Node 22 and workerd. Writing a Node version and a
Worker version of a security primitive would create two things that can disagree, and the
dangerous disagreement is the silent one — the implementation that accepts a token it should
have rejected. So there is no branching here at all: the same code runs in both runtimes.

| Module | Was | Now |
|---|---|---|
| `auth/tokens.ts` | `randomBytes`, `createHash`, `timingSafeEqual` | `getRandomValues`, `subtle.digest`, hand-written constant-time compare |
| `auth/secret-box.ts` | `createCipheriv`/`createDecipheriv`, `hkdfSync` | `subtle.deriveKey` (HKDF) + `subtle.encrypt`/`decrypt` (AES-256-GCM) |
| `auth/google-oauth.ts` | `createPublicKey({format:'jwk'})`, `createVerify` | `subtle.importKey('jwk')`, `subtle.verify('RSASSA-PKCS1-v1_5')` |
| `http/route-handler.ts`, `storage/keys.ts`, `services/{migration,upload}.ts` | `randomUUID` from `node:crypto` | global `crypto.randomUUID()` |

### 3.1 What was preserved, and how it is proven

* **The sealed-secret wire format is unchanged.** `v1.iv.tag.ciphertext`, base64url,
  AES-256-GCM, HKDF-SHA256 from `AUTH_SECRET` with empty salt and info string
  `biotech-drive:secret-box:v1`. WebCrypto appends the GCM tag to the ciphertext; the seal
  path splits it back out and the open path re-joins it, so **every value written by the Node
  build opens in the Worker and vice versa**. This is what makes the Phase 7 rollback real:
  a database rolled back to Mongo still has readable Drive-importer refresh tokens.
  Proven by `tests/security/google-drive-migration.test.ts` — round trip plus rejection of a
  bit-flipped ciphertext.

* **Constant-time comparison is still constant-time.** `timingSafeEqual` has no Worker
  equivalent, so it is written out: XOR every byte pair into an accumulator, never return
  early, fold the length difference into the accumulator rather than short-circuiting on it.

* **SHA-256 output is pinned to the standard, not to the new implementation.** A new test
  asserts the published empty-string and `"abc"` vectors. Without it, a rewrite that was
  wrong but self-consistent would have passed every existing test — `hashToken(x) ===
  hashToken(x)` is true of any hash function, including a broken one.

* **`alg` is still pinned before the key is looked up** in the ID-token verifier, which is
  what refuses `alg: none` and the "verify RS256 as HMAC using the public key" forgery.

### 3.2 The API change this forced

`hashToken`, `sealSecret`, `openSecret` and `beginGoogleLogin` are now `async` —
`crypto.subtle` is promise-based and there is no synchronous digest in a Worker. Nine call
sites were updated, all already inside `async` functions. `safeCompare` stays synchronous.

---

## 4. The three dependencies that cannot exist in a Worker

Each is replaced at build time, for the Cloudflare build only. The Node deployment resolves
the real packages, untouched.

### 4.1 Why aliasing did not work, and what does

The obvious approach — `resolve.alias` on the bare specifier `@node-rs/argon2` — **fails
silently and then loudly**. Next.js auto-externalizes packages carrying native bindings, and
an externalized module is one webpack never resolves: it emits a bare `require()`, and
OpenNext's esbuild pass resolves it from `node_modules` afterwards. The build then dies with:

```
No loader is configured for ".node" files:
node_modules/@node-rs/argon2-win32-x64-msvc/argon2.win32-x64-msvc.node
```

The fix is to give webpack a **local module** to replace instead. `src/server/auth/argon2-binding.ts`
and `src/server/logging/pino-binding.ts` are one-line re-exports — ordinary application
source, always resolved — and `NormalModuleReplacementPlugin` swaps them on the Cloudflare
build. This is the same technique the repository already uses for the dev switcher, for the
same class of reason.

One further subtlety: the plugin matches the **request string**, not the resolved path. An
import written `./argon2-binding` never matches a pattern containing directory separators, so
both bindings are imported through the `@/` alias (`@/server/auth/argon2-binding`).

### 4.2 The shims

| Replaced | Shim | Behaviour |
|---|---|---|
| `@node-rs/argon2` | `src/server/shims/argon2.worker.ts` | **Refuses.** Argon2id has no WebCrypto equivalent, so existing `passwordHash` values cannot be verified in a Worker by any means — PBKDF2 would reject every correct password. The error names the cause rather than returning "invalid credentials", which would look like a password problem to every employee and to support. Phase 8 replaces password login with Access; Phase 9 deletes the dependency, the column and this shim. |
| `pino` | `src/server/shims/pino.worker.ts` | Structured JSON to `console`, which Workers Logs ingests. **Reimplements the redaction list**, including `*.`-prefixed wildcard paths. This is why the shim is 180 lines and not 3: `logger.ts` relies on pino's `redact.paths` to keep `storageKey`, `relativeStoragePath`, `absolutePath`, `tokenHash`, `cookie` and `authorization` out of the logs, and a leaked storage path is a security finding in this codebase. Dropping to plain `console.log` would have removed that protection in exactly the environment where logs are most widely readable. |
| `pino-pretty` | — | Development formatting only; nothing to replace. |

**Mongoose is deliberately not shimmed.** See §6.

---

## 5. Configuration added

| File | Purpose |
|---|---|
| `wrangler.jsonc` | Worker config; `development` / `staging` / `production` environments; `DB`, `SYNC_QUEUE`, `NOTIFICATION_QUEUE` bindings; observability |
| `open-next.config.ts` | OpenNext adapter config, deliberately minimal |
| `.dev.vars.example` | Local secret template; `.dev.vars` is git-ignored |
| `src/server/config/env.worker.ts` | Worker environment contract |
| `src/server/runtime/index.ts` | Runtime detection and the named capability gaps |

### 5.1 `MIGRATION_WORKFLOW` is not declared yet — and why

The brief asks for four bindings. Three are declared. `MIGRATION_WORKFLOW` is commented out
in `wrangler.jsonc` with the reason inline: a `workflows` binding requires the Worker
entrypoint to **export the workflow class**, and the OpenNext-generated entrypoint exports
only the Next.js handler. Declaring it now makes `wrangler dev` and every deploy fail with a
missing-export error. Phase 5 adds the class and the binding together.

This is a deviation from the brief's Phase 1 scope. It is recorded here rather than worked
around, because the available workarounds — a fake class, or a binding pointing at nothing —
would both produce a Worker that boots and then fails at the first job.

### 5.2 Why the Worker env schema is a separate file

`env.worker.ts` is not a copy of `env.ts` with fields removed. It differs in three ways that
follow from the runtime:

1. **No storage roots.** The six `*_ROOT` variables describe directories. A Worker has no
   disk, and `assertRootsArePrivate()` — which exists to stop file storage landing inside the
   publicly served directory — would be validating six paths that can never be opened.
2. **Google Drive is mandatory, not flag-gated.** On Node, Drive is optional and `local` is
   the default. In a Worker there is no second option: without Drive, no file can be read.
   So the checks `env.ts` applies conditionally are unconditional here.
3. **Bindings are validated.** A missing `DB` binding fails at boot with a sentence
   explaining it, not as `undefined is not a function` three requests later.

It accepts both `GOOGLE_SERVICE_ACCOUNT_*` (the brief's names) and `GOOGLE_DRIVE_SERVICE_ACCOUNT_*`
(the existing ones) so one secret store can feed both runtimes while they run side by side.

---

## 6. Correction to Phase 0, Finding 2 — MongoDB connected from the Worker

Phase 0 stated that a Worker "can compile but cannot serve a data-backed page" because
Mongoose needs raw TCP.

**That is not what happened.** Under `wrangler dev --local` with `nodejs_compat`, the Worker
connected to MongoDB successfully:

```json
"database": { "status": "ok", "latencyMs": 394, "database": "biotech_drive_dev" }
```

workerd's `nodejs_compat` now backs `node:net` with real outbound TCP, and the MongoDB driver
worked over it.

**Do not over-read this.** What is proven is that the driver functions under workerd
*locally*, where the runtime is a process on this machine reaching `127.0.0.1`. A deployed
Worker additionally needs: a MongoDB endpoint reachable from Cloudflare's network, TLS through
workerd's socket implementation, and `mongodb+srv://` SRV resolution — none of which is
tested here. The Phase 0 conclusion that Mongoose must not be the deployed data path stands,
and Phase 3 replaces it with D1 regardless.

Mongoose is therefore left unshimmed on purpose. Stubbing it would have hidden this boundary;
leaving it real is what surfaced the correction.

---

## 7. What the Worker preview actually served

`npx wrangler dev --env development --port 8787 --local`:

| Route | Result |
|---|---|
| `GET /api/version` | `200`, JSON body, **every security header intact** — CSP, HSTS, `X-Frame-Options: DENY`, COOP, CORP, `Permissions-Policy`, `X-Content-Type-Options` |
| `GET /` | `307` → `/login` (middleware working) |
| `GET /login` | `200`, 16,432 bytes of HTML |
| `GET /api/auth/session` (no cookie) | `401` `UNAUTHENTICATED` with a request id, no stack trace |
| `GET /api/files/<guessed id>` (no cookie) | `401`, identical shape — no information disclosure |
| `GET /api/health/ready` | `200` `degraded` — see below |

`crypto.randomUUID()` is confirmed working: every response carried a well-formed
`x-request-id`.

### 7.1 The readiness probe is telling the truth

```json
"storage": { "status": "degraded", "provider": "local", "writable": true,
             "totalBytes": 0, "freeBytes": 0, "belowFreeSpaceFloor": true }
```

This is Phase 0 Finding 1 showing up at runtime. `statfs` against a filesystem that does not
exist returns zero, and the health check correctly reports the deployment as degraded. It is
the right behaviour and it stays visible until Phase 1a moves the bytes into the Shared Drive.

---

## 8. Files

### 8.1 Added (12)

```
wrangler.jsonc
open-next.config.ts
.dev.vars.example
src/server/runtime/index.ts
src/server/config/env.worker.ts
src/server/auth/argon2-binding.ts
src/server/logging/pino-binding.ts
src/server/shims/argon2.worker.ts
src/server/shims/pino.worker.ts
docs/cloudflare-migration/00-phase-0-analysis.md
docs/cloudflare-migration/01-phase-1-worker.md
(.dev.vars — local only, git-ignored, placeholder values)
```

### 8.2 Modified (16)

| File | Change |
|---|---|
| `package.json` | `@opennextjs/cloudflare`, `wrangler`, `cross-env`, `@cloudflare/workers-types`; `cf:build`/`cf:preview`/`cf:deploy`/`cf:typegen` scripts |
| `next.config.ts` | `output: 'standalone'` made conditional; module replacement for the Cloudflare build |
| `.gitignore` | `.dev.vars`, `.open-next/`, `.wrangler/`, `worker-configuration.d.ts` |
| `src/server/auth/tokens.ts` | WebCrypto; `hashToken` async |
| `src/server/auth/secret-box.ts` | WebCrypto; `sealSecret`/`openSecret` async; format preserved |
| `src/server/auth/google-oauth.ts` | WebCrypto JWKS verification; `beginGoogleLogin` async |
| `src/server/auth/password.ts` | Imports the argon2 binding module |
| `src/server/auth/session.service.ts` | Awaits `hashToken`; `assertCsrf` async |
| `src/server/logging/logger.ts` | Imports the pino binding module |
| `src/server/http/route-handler.ts` | Global `crypto.randomUUID` |
| `src/server/http/authenticated-route.ts` | Awaits `assertCsrf` |
| `src/server/services/auth.service.ts` | Awaits `hashToken` (2 sites) |
| `src/server/services/migration.service.ts` | Awaits `sealSecret`/`openSecret`; global `randomUUID` |
| `src/server/services/upload.service.ts` | Global `randomUUID` |
| `src/server/storage/keys.ts` | Global `randomUUID` |
| `src/app/api/auth/google/route.ts` | Awaits `beginGoogleLogin` |

### 8.3 Tests modified (4)

| File | Change |
|---|---|
| `tests/unit/tokens.test.ts` | `await`; **added SHA-256 standard vectors** |
| `tests/security/authentication.test.ts` | `await hashToken` |
| `tests/security/google-drive-migration.test.ts` | `await` on seal/open |
| `tests/security/drive-storage-credentials.test.ts` | `env.worker.ts` added to the credential-reader allowlist, with the justification inline — see §10 |

### 8.4 Not modified

**All 86 components, 36 pages, 14 hooks, 117 of 118 API routes, 26 repositories, 32 models,
36 of 37 services, all of `domain/`, all of `validation/`, `http/dto.ts`.**

`git diff --stat` over `src/components`, `src/app/(drive)`, `src/app/(auth)` and `src/hooks`
returns only the five files that were already modified before this phase began
(`item-dialog`, `app-shell`, `header`, `shortcuts-dialog`, `sidebar` — pre-existing
uncommitted work, untouched here).

---

## 9. Schema changes

**None.** No MongoDB model, index or document shape was altered. D1 schema is Phase 2.

---

## 10. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 1 pre-existing warning (unused `projectService` in a test), unchanged from baseline |
| `npm test` | ✅ **680/680** (46 files) |
| `npm run build` (Node) | ✅ succeeds; `.next/standalone` present |
| `npm run cf:build` | ✅ succeeds; `.open-next/worker.js` produced |
| `npx wrangler dev --local` | ✅ boots and serves — see §7 |
| Bundle audit | ✅ no `argon2-win32-x64-msvc` anywhere; `@node-rs/argon2`, `pino`, `pino-pretty` absent from the copied `node_modules`; shim refusal message and full redaction list both present |

### 10.1 The one test that failed, and why that was the right outcome

`tests/security/drive-storage-credentials.test.ts` → *"is read in exactly one module"* failed
on first run. It asserts that `GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY` appears in exactly
two files, and `env.worker.ts` made three.

This is the guard working. It was resolved by adding `env.worker.ts` to the allowlist **with
the justification written into the test**: it is a *declaration* of the same kind as `env.ts`
— it names the variable so the value can be validated at boot and accepts the alternate
spelling — and it does not read the value, pass it on, or log it. The comment states that the
list must not grow again without the same scrutiny.

The alternative — loosening the assertion to a substring match or a count — would have kept
the test green and stopped it protecting anything.

---

## 11. Acceptance criteria

From Phase 0 §10. Phase 1-A only; 1-B needs Phase 3.

- [x] `npm run build` succeeds
- [x] `npx opennextjs-cloudflare build` succeeds
- [x] `wrangler dev` boots; `/api/version` and `/api/health` respond; the login shell renders
- [x] `npm run typecheck` clean
- [x] `npm run lint` clean (baseline warning only)
- [x] `npm test` — 680/680 across all 46 files
- [x] `tests/unit/architecture-boundaries.test.ts` still passes
- [x] No UI file modified
- [x] `wrangler.jsonc` declares `DB`, `SYNC_QUEUE`, `NOTIFICATION_QUEUE` for all three
      environments — **`MIGRATION_WORKFLOW` deferred to Phase 5, see §5.1**
- [x] No secret committed; `.dev.vars` git-ignored (verified with `git check-ignore`)
- [x] Node production deployment still builds and runs unchanged

**Deviation:** one binding of four deferred, with the reason recorded.

---

## 12. Rollback

Phase 1 changes no data and no production runtime. The Node deployment is byte-for-byte
behaviourally identical.

**Full rollback:**

```bash
git checkout -- next.config.ts package.json package-lock.json .gitignore \
  src/server src/app/api/auth/google/route.ts tests
rm -rf .open-next .wrangler wrangler.jsonc open-next.config.ts .dev.vars .dev.vars.example
rm -rf src/server/runtime src/server/shims
rm -f src/server/config/env.worker.ts src/server/auth/argon2-binding.ts \
      src/server/logging/pino-binding.ts
npm ci
npm run build
```

**Partial rollback — keep the Worker config, revert the crypto rewrite:** revert
`src/server/auth/{tokens,secret-box,google-oauth}.ts`, `session.service.ts`,
`authenticated-route.ts`, `auth.service.ts`, `migration.service.ts`, `http/route-handler.ts`,
`storage/keys.ts` and the four test files. The Cloudflare build will then fail, which is the
correct signal that the two are coupled.

**Docker/production impact:** none. `output: 'standalone'` is still emitted for every build
that is not `BUILD_TARGET=cloudflare`, and `.next/standalone` was verified present.

---

## 13. Carried into later phases

| Item | Phase | Note |
|---|---|---|
| `MIGRATION_WORKFLOW` binding | 5 | §5.1 |
| Durable Object rate limiter | 3 | `rate-limit.ts` is still the in-memory Node one; per-isolate limits are wrong in a Worker but nothing authenticated is served from it yet |
| Web Streams in the storage interfaces | 4 | `ObjectStore` still speaks `NodeJS.ReadableStream` |
| Direct browser → Drive upload | 4 | Decision 1 |
| Drive storage cutover | 1a | The blocker for Phase 7 |
| `officeparser` removal | 9 | Declared, unused, never imported |

---

## 14. Next

**Phase 1a** (Drive storage cutover) and **Phase 2** (D1 schema) are independent and can run
concurrently. Phase 3 needs both. Phase 1a is the long pole and gates Phase 7.
