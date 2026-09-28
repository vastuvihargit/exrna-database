# Security hardening

What is in place, where it is enforced, and what it deliberately does not do. The threat
model this answers is `docs/phase-0/08-security-threat-model.md`.

The organising principle throughout: **the backend decides everything, and it decides it
again on every request.** Nothing the browser sends about who it is or what it may do is
trusted, including things the browser was told a moment ago.

---

## Authentication

| Control | Where |
| --- | --- |
| Company-domain-only sign-in | `server/auth/email-domain.ts` |
| Argon2id password hashing | `server/auth/password.ts` |
| HTTP-only, `SameSite=Strict`, `Secure` session cookies | `server/http/cookies.ts` |
| Session rotation on privilege change | `server/auth/session.service.ts` |
| Idle and absolute session timeouts | `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_MINUTES` |
| Login rate limiting, per IP and per email | `server/auth/rate-limit.ts` |
| Login history and device records | `LoginHistory` |

**On the Cloudflare deployment, identity belongs to Cloudflare Access** (Google Workspace as the
identity provider), verified server-side on every request
(`docs/cloudflare-migration/22-cloudflare-access.md`). Password sign-in and the application's
own password reset are refused there — `403` with a message pointing to the identity provider's
account recovery, and the `/forgot-password` and `/reset-password` pages say the same — because
the application does not own the password (`isPasswordRecoveryAvailable`,
`server/auth/access-session.ts`). The reset-token store is MongoDB-only on purpose: there is no
D1 counterpart to build, since a production Worker always runs behind Access.

Owning a company email address does not grant access. `ALLOW_AUTO_PROVISIONING=false`
means an administrator creates the account first; the domain check decides who *may* sign
in, and role records decide what they may then do.

**Deactivation is immediate.** Session resolution re-reads user status on every request
rather than trusting the session cookie's contents, so a deactivated employee loses
access in-flight rather than at their next login.

---

## Authorization

Every API route validates permission independently. There is no middleware that "already
checked" and no trusted client-side role. `withAuthenticatedRoute` makes this structural:
a handler receives an `Actor` that only the wrapper can construct, so a route that forgot
to authenticate cannot compile.

Permission is scoped — company, department, project, folder, file — and folder
permissions are evaluated against the **whole ancestor chain**, loaded once per request
in `folder-access.ts` so no route can forget it.

Two properties are enforced twice on purpose:

- **Search and listings fold visibility into the MongoDB query** so restricted rows are
  never fetched and `total` never counts them — then re-check each returned row with the
  same `can()` the mutating routes use. The redundancy is the point.
- **Facet and dashboard counts are computed over the caller's visible set.** A single
  organization-wide number would tell a viewer exactly how much is hidden from them.

Unauthorized access to a resource that exists returns the same answer as one that does
not, wherever the existence itself is sensitive.

---

## File storage

| Rule | How it is guaranteed |
| --- | --- |
| Files live outside the web root | Boot assertion refuses any storage root inside `public/` or `.next/` |
| No physical path reaches the browser | `storageKey`, `relativeStoragePath` and `storedFilename` are stripped in the base `toJSON` |
| No path traversal | Allow-list key validation plus resolved-prefix containment (`path-safety.ts`) |
| Generated physical names | UUID/ObjectId keys; the user's filename is metadata, never a path |
| Nothing is overwritten | Exclusive create (`wx`); `overwrite` is typed as literal `false` |
| Integrity is provable | SHA-256 computed while streaming, re-verified on a rolling sample |

All preview and download traffic passes through authenticated route handlers that check
permission and record the access. There is no static file route to the storage volume,
and nginx has no location block that could reach it.

---

## Uploads

The pipeline is: **authorize → quarantine → measure → verify → scan → move → record.**
Nothing enters storage before every one of those has passed.

- Extension decides the type; the client-declared MIME type is only ever a cross-check.
- A file whose bytes do not match its extension is flagged for review, not imported.
- Size is what the server measured while streaming, never what the client declared.
- Quota (personal and department) and the free-disk floor are checked *before* bytes are
  accepted, so a refusal costs nothing.
- ClamAV scans every upload. In production, scanning fails **closed** by default.
- Upload authorization is rate-limited separately from ordinary API traffic, because a
  successful authorization reserves quota and a quarantine slot.

---

## Transport and headers

Applied to every route (`next.config.ts`):

`Content-Security-Policy` (no `unsafe-eval` in production, `frame-ancestors 'none'`,
`base-uri 'none'`) · `Strict-Transport-Security` (production, 2 years, preload) ·
`X-Content-Type-Options: nosniff` · `X-Frame-Options: DENY` ·
`Referrer-Policy: strict-origin-when-cross-origin` · `Permissions-Policy` ·
`Cross-Origin-Opener-Policy` · `Cross-Origin-Resource-Policy`.

One route is exempt and it is documented in the config: `/api/files/:id/preview` sets its
own sandbox CSP, because the application-wide `frame-ancestors 'none'` would stop the
preview being embedded in our own viewer.

---

## CSRF

State-changing requests need a same-origin check **and** a CSRF token header bound to the
session. `Sec-Fetch-Site` is honoured where the browser sends it; `Origin` is the
fallback; the token is the control. Enforced in `withAuthenticatedRoute`, so it is not
possible to write a mutating route that skips it.

---

## Rate limiting

Two layers. nginx applies coarse per-IP limits; the application applies limits that know
about accounts and endpoints:

| Rule | Limit |
| --- | --- |
| Login, per IP / per email | 10 / 5 per 15 min |
| Password reset, per IP / per email | 10 / 3 per hour |
| Authenticated API, per user | 1000 per 15 min |
| Upload authorization, per user | 300 per 10 min |
| Search, per user | 120 per 5 min |

Counters are per-actor, so one person's bulk import cannot lock their department out.

**Where the counters live depends on the runtime** (`server/auth/rate-limit.ts`):

| Runtime | Store | Why |
| --- | --- | --- |
| Node (legacy deployment, tests, `next dev`) | in-process `Map` | one application process, so the process's count is the whole count (assumption A9) |
| Cloudflare Worker | the `RATE_LIMITER` Durable Object, one object per key | a Worker is many isolates; a `Map` there would count one isolate's share, and "5 sign-ins per 15 min" would silently become "5 per isolate". One Durable Object per key sees every request, exactly |

Both stores run the same fixed-window arithmetic (`rate-limit-window.ts`). The Workers Rate
Limiting binding was not used: it only supports 10- or 60-second periods and counts
approximately per location, and every rule above runs over 5–60 minutes.

The Worker refuses to start without the `RATE_LIMITER` binding (`assertBindings`). If a call to
the object fails at runtime, the attempt is still counted in the isolate's own `Map` and an
error is logged: a weaker limit for the length of a platform outage, never none, and never a
lock-out of every user. Tests: `tests/unit/rate-limit.test.ts` (including a cross-isolate
simulation) and `tests/unit/rate-limiter-durable-object.test.ts`.

A second Node app container would still need a shared store; the Node deployment remains
single-node until it is retired.

---

## Audit

Append-only. There is no update or delete path in `audit.service.ts` and no API route
that could reach one. Records carry actor, action, entity, before/after values,
timestamp, IP, user agent and request id. Access is restricted to company-scoped
`audit.view` — the same bar as the System page, because free disk, backup ages and
quarantine counts are exactly the reconnaissance a foothold would want.

---

## Secrets

Never in the repository. CI fails the build if any `.env*` file other than
`.env.example` is committed. Logs redact passwords, tokens, session hashes, cookies and
physical storage paths (`server/logging/logger.ts`) — a leaked absolute path is a
security finding, not a convenience.

The one secret the server must read back rather than compare (the Google Drive refresh
token) is sealed with AES-256-GCM under an HKDF-derived key, excluded from the record
type and the DTO, and read by exactly one named function.

---

## What is deliberately not implemented

| Not built | Why |
| --- | --- |
| Public share links / "anyone with the link" | Out of scope by requirement. Every access is attributable to an employee. |
| External collaborator accounts | Same. Enabling it would need a separate identity boundary. |
| Client-side encryption | Would break search, preview and server-side scanning. Encryption is at rest and in transit. |
| Automatic orphan deletion | The one time it would be catastrophic is during a partial restore — exactly when the sweep is most likely to run. |
| Automatic rollback on failed deploy | A half-rolled-back file volume is worse than a stopped deploy. |

---

## Verifying it

The security suites in `tests/security/` are executable versions of these claims — one
department cannot read another's restricted files, a guessed file id does not download,
a path cannot be manipulated, a deactivated user loses access immediately, search does
not leak restricted filenames, approved files cannot be silently overwritten, old
versions remain, a failed upload leaves no usable record.

```bash
npm test                     # everything
npm run review:indexes       # declared vs built indexes
npm run verify:storage       # metadata and bytes agree
npm run monitor              # every operational check, right now
```
