# Phase 3, module 13 — sessions, organizations, notifications, and the flag matrix

**Status: complete.** Sessions, organizations and notifications have D1 implementations behind
contracts. Cloudflare Access token verification is implemented and tested. The `DATA_SOURCE_*`
matrix now fails closed on a split that would put a foreign key across two databases. §6 records
the verification. Nothing here is enabled in production.

---

## 1. Why these three, together

The previous twelve modules were chosen by the phase plan. These three were chosen by a
constraint the plan did not state: **a Worker cannot serve a single authenticated request until
they are all on D1.**

* `sessions` — `resolveSession()` reads it on every request.
* `organizations` — every other table's `organization_id` is a foreign key to it, so no D1
  write of any kind succeeds until the tenant row is there.
* `notifications` — not strictly on the auth path, but it is the last module with a Queue
  consumer waiting on it, and Phase 6 cannot start without it.

`00-phase-0-analysis.md` §4 records why a Worker cannot reach MongoDB at all: no raw TCP socket,
so Mongoose cannot connect. That makes "which modules must move" a different question from
"which modules the plan lists" — the answer is all of them, and these were the ones still
missing from the identity path.

## 2. Sessions

### 2.1 Liveness is in the query

`findLiveByTokenHash` returns a row only if it is unrevoked and inside **both** expiries:

```sql
WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?
```

Three predicates, in the WHERE clause rather than in a check the caller performs. A caller that
forgets the check is an authentication bypass; a query that forgets it is a test failure. The
suite defeats each predicate **individually**, because an implementation missing exactly one of
them passes a combined test.

### 2.2 `touch` caps in SQL

MongoDB used `$min: [idleExpiresAt, '$absoluteExpiresAt']` so sliding the idle window could never
push a session past its absolute deadline. Reading the row, comparing in JavaScript and writing
back would reintroduce a race the pipeline did not have — two concurrent requests both read, both
decide, the later write wins with a stale value. D1 uses `MIN()` over the column, keeping the
decision inside one statement.

### 2.3 ISO-8601 TEXT comparison is load-bearing

Every timestamp is `toISOString()` output: fixed width, UTC, millisecond precision.
Lexicographic comparison of two such strings is chronological comparison, which is what makes
`expires_at > ?` a valid liveness test in SQLite.

It is *only* valid because the format never varies. A local-time string, a second-precision
string or a Unix integer in one of these columns produces a comparison that silently returns the
wrong answer — and the wrong answer here is either "expired session accepted" or "everyone
logged out". `session.repository.d1.ts` has exactly one date-formatting function and nothing else
in the file formats a date.

### 2.4 The expiry sweep, and the two foreign keys nobody expects

MongoDB expired sessions with a TTL index. SQLite has none, so the sweep is explicit —
`deleteExpiredBefore`, new on both engines so they agree.

A bare `DELETE` fails. Two columns reference `sessions.id` and neither cascades:

| Column | Why it exists |
|---|---|
| `login_history.session_id` | links an authentication attempt to the session it produced |
| `sessions.rotated_from_id` | chains a rotated session to its predecessor |

For `login_history` that means *every session that was ever logged into* blocks its own deletion.
The sweep therefore detaches both references and deletes, all three statements in one `batch()`.

Detaching is right rather than cascading: a login-history row is a security record that must
outlive the session it describes. It keeps its user, its IP and its outcome, and loses only a
pointer to a row that no longer exists.

> Found by a test, not by review. The first implementation deleted directly and the suite failed
> with a foreign-key error. A sweep that crashes leaves expired sessions in the table for ever,
> and the only symptom is a growing table nobody is watching.

## 3. Organizations

Two methods. The interesting part is failure handling on the login path.

`email_domains` and `settings` are JSON columns, and `getPrimary()` is called by
`getSignInDomains` on every sign-in. Throwing on malformed JSON would take authentication down
for everyone over one bad character, so `parseJson` falls back to `{}` and `normalizeSettings`
supplies defaults.

That is only safe because of an asymmetry worth stating: **every default is the restrictive
one** — no auto-provisioning, no self-approval, empty allow-lists, and `trashRetentionDays: 30`
rather than `0`, because a missing retention must not read as "purge immediately". A parse
failure degrades a setting; it cannot widen access.

`normalizeSettings` lives on the contract and is shared by both engines. Duplicating it per
engine is how the two databases come to disagree about whether self-approval is allowed, which is
an authorization difference dressed as a config default.

## 4. Notifications, and idempotency under retry

Cloudflare Queues deliver at least once. A consumer interrupted between writing a notification
and acknowledging the message sees that message again, and the naive result is a duplicate row in
somebody's bell menu — for every transient error, with no upper bound.

Migration 0004 adds `notifications.dedupe_key` and a unique index. Queue consumers pass a key
derived from the **event** (`review-requested:<reviewId>:<userId>`), never from the clock, and the
write is `INSERT … ON CONFLICT DO NOTHING`. The engine decides, which is the only place the
decision can be made correctly — a `SELECT`-first check is the same read-then-write race.

### 4.1 The two engines need different index shapes

This is not stylistic and it cost two failed test runs to get right.

| | Behaviour | Index |
|---|---|---|
| **SQLite / D1** | every NULL in a unique index is distinct | plain `UNIQUE(dedupe_key)` |
| **MongoDB** | NULLs compare equal | `partialFilterExpression: { dedupeKey: { $type: 'string' } }` |

Two traps here, both hit:

1. **`sparse: true` is not sufficient on MongoDB.** Sparse excludes documents where the field is
   *absent*. Every inline-written notification stores an explicit `dedupeKey: null` from the
   schema default, so a sparse unique index indexes all of them, decides they are the same key,
   and rejects the second notification anybody ever receives.

2. **A partial index on D1 breaks the upsert.** SQLite matches `ON CONFLICT (col)` to an index by
   comparing the columns *and* the WHERE clause, so a partial index needs
   `ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL` — and drizzle's SQLite builder emits
   its `where` after `DO NOTHING`, which is the `DO UPDATE` position and a syntax error. The
   failure is not on a duplicate; it is on the very first insert.

The test that keeps this honest is not the deduplication test — it is
*"keeps two identical notifications that carry no dedupe key"*. An implementation that
deduplicated on content rather than on an explicit key would pass the first and silently swallow
real notifications.

## 5. Cloudflare Access (Phase 8 groundwork)

### 5.1 Why it is a prerequisite, not an enhancement

`passwordHash` is Argon2id from `@node-rs/argon2`, a native Rust N-API addon. workerd loads no
native code and Argon2id has no WebCrypto equivalent, so **those hashes cannot be verified in a
Worker by any means**. `next.config.ts` already swaps in `shims/argon2.worker.ts`, which refuses
rather than falling back — substituting PBKDF2 would reject every correct password, which looks
like a mass account lockout.

So a Worker has no password login at all. `loadWorkerEnv` now refuses to boot a **production**
Worker with Access unconfigured, because such a deployment 401s every request while reporting
healthy.

### 5.2 What is trusted

Only a signature. `verifyAccessJwt` fetches the team's public keys, verifies RS256 over the
signing input, then checks issuer, audience, `exp` and `nbf`.

Three things are deliberately *not* trusted:

* **`Cf-Access-Authenticated-User-Email` is never read.** It is a plaintext header, forgeable by
  anything that can reach the Worker directly, and a Worker URL is public. Trusting it would make
  authentication a matter of typing an address into `curl`. There is a test asserting
  `readAccessToken` ignores it.

* **A token with no audience check is any application's token.** Every Access application on the
  same team is signed by the same keys, including one an attacker can enrol in. `CF_ACCESS_AUD`
  is what binds a token to this application, and `accessConfigFrom` returns `null` rather than a
  half-configuration when it is missing — a team domain without an audience is the dangerous
  state, not the harmless one.

* **Access proves identity, not authorization.** `completeAccessLogin` establishes an email
  address from a signature and hands everything else to `completeOAuthLogin`: company-domain
  check, auto-provisioning policy, active-user enforcement, login history, audit, session issue.
  Delegating rather than reimplementing matters — two copies of the account-status policy is how
  one of them keeps letting a deactivated employee in after the other stopped.

The suite signs real RS256 tokens with a generated key pair and serves a real JWKS through a
stubbed `fetch`, so the WebCrypto path actually runs. It refuses `alg: none`, an HS256 token
(the "verify with the public key as the HMAC secret" forgery), a tampered payload, an unknown
`kid`, another application's audience, another team's issuer, an expired token, a not-yet-valid
token, and an unreachable certs endpoint.

## 6. The flag matrix, failing closed

`DATA_SOURCE_DEPENDENCIES` in `data-source.ts` records which modules cannot be on D1 unless
another is. Each entry is a **foreign key that exists in the D1 schema** — not a preference. A
split pair does not degrade: every write in the dependent module fails on a constraint violation,
at runtime, on a user's action.

`assertDataSourceMatrix()` is called from both `loadEnv` and `loadWorkerEnv`, so the mistake
surfaces at startup with the exact pair named. `dataSourceViolations()` returns every violation
rather than the first, because fixing one flag per restart cycle is how a cutover window gets
spent.

`workerReadinessGaps()` reports modules still routed to MongoDB. In a production Worker that is
an error; outside production it is a warning, so `cf:preview` can still boot with a partial flag
set — which is how each module was verified in a Worker as it landed.

### 6.1 Configured is not the same as routed

`dataSourceFor()` answers *"which repository should this call use right now"* and consults the
per-module test override map. `configuredDataSourceFor()` answers *"how is this environment set
up"* and reads `process.env` only. The matrix check uses the second.

The distinction is not decorative, and conflating them broke a suite before it was noticed. The
first version of `dataSourceViolations()` called `isD1()`, which reads overrides — so
`tests/d1/lifecycle-unit-of-work.test.ts`, which deliberately puts folders on D1 and files on
MongoDB **to prove the hierarchy layer refuses that pair with `SplitDataSourceHierarchyError`**,
got an `UnsafeDataSourceMatrixError` from the environment guard instead. The guard pre-empted the
assertion the test existed to make.

Two different questions, two different functions. A future reader tempted to "simplify" one into
the other will find three tests in that file disagreeing.

Requirements also resolve **transitively**: `fileVersions` → `files` → `folders` →
`departments`. An operator told only about the first edge would fix it, restart, be told about
the next, and spend a write freeze learning one answer per restart.

### 6.2 Two flags that are not independently movable

Most modules can be flipped alone. These cannot, and the reason is operational rather than
structural:

* **`DATA_SOURCE_SESSIONS`** — moving it invalidates every session, because the new engine has
  none of them. Every user is logged out at the moment of the flip. That is a cutover step, and
  it belongs inside the write freeze.
* **`DATA_SOURCE_NOTIFICATIONS`** — notifications written before the flip live in the other
  database and stop appearing until the migration copies them.

Neither is a defect; both are runbook items.

## 7. Verification

| Gate | Command | Result |
|---|---|---|
| Sessions + organizations, both engines | `vitest run --config vitest.d1.config.ts tests/d1/session-organization-repository.test.ts` | 42 passed |
| Notifications, both engines | `vitest run --config vitest.d1.config.ts tests/d1/notification-repository.test.ts` | 20 passed |
| Cloudflare Access | `vitest run tests/unit/cloudflare-access.test.ts` | 21 passed |
| Flag matrix | `vitest run tests/unit/data-source-matrix.test.ts` | 12 passed |
| Lifecycle split-provider refusal (regression) | `vitest run --config vitest.d1.config.ts tests/d1/lifecycle-unit-of-work.test.ts` | 24 passed |
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |

Full-suite figures are recorded in `FINAL-READINESS.md`.

## 8. What this module does *not* do

Stated because the absence of a result is not a pass:

* **No route reads the Access assertion yet.** `completeAccessLogin` exists and is tested; no
  `/api/auth/access` handler calls it, and `resolveSession` still expects a session cookie. Wiring
  it is a route change plus a decision about whether Access replaces the login page or sits in
  front of it.
* **No live Access token has been verified.** The suite generates its own key pair. Verifying
  against a real team requires an Access application, which is an external input.
* **The Queue consumer does not exist.** `dedupe_key` is the mechanism a consumer will use;
  `wrangler.jsonc` still declares producers only, deliberately — a consumer declared without a
  handler silently swallows messages.
