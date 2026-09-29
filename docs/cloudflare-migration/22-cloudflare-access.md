# Cloudflare Access: sign-in integration

**Status: code complete, tested locally.** It has not been verified against a live Access
application: none exists yet (external item). Tokens in the tests are real RS256 JWTs signed by a
generated key pair.

---

## 1. Architecture

```
Browser ──► Cloudflare Access (Google Workspace IdP)       identity, at the edge
              │  adds Cf-Access-Jwt-Assertion + CF_Authorization cookie
              ▼
         Worker ──► /api/auth/access                        sign-in bridge
              │       verifyAccessJwt (signature, iss, aud, exp, nbf)
              │       → completeOAuthLogin policy: company domain, provisioning, active status
              │       → application session (bd_session)
              ▼
         every request: resolveRequestSession
              session valid (status re-read, roles re-loaded)   AND
              Access JWT valid AND its e-mail == the session user's e-mail
              ▼
         existing roles + resource ACLs decide what the person may do (unchanged)
```

Access proves **who**. The application still decides **what**. No role, permission or ACL entry
is derived from Access or from Google group membership.

## 2. What was built

| File | Role |
|---|---|
| `src/server/auth/access-session.ts` | `resolveRequestSession()`, the single per-request check; `signInPath()`, `signOutRedirect()`, `isAccessEnforced()` |
| `src/app/api/auth/access/route.ts` | The sign-in bridge. Verifies the assertion, resolves the employee, issues the session and redirects to `next` (path only). Returns 404 when Access is not configured. |
| `src/server/http/authenticated-route.ts`, `page-guard.ts` | API routes, pages and optional-actor lookups all go through `resolveRequestSession` |
| `src/server/services/auth.service.ts` | `completeAccessLogin` exported. Password sign-in and password reset are refused while Access is enforced. |
| `src/app/api/auth/google/route.ts` | Redirects to the Access bridge while Access is enforced |
| `src/app/api/auth/providers/route.ts`, `components/auth/login-form.tsx` | Login page offers only "Continue with company sign-in" under Access |
| `src/app/api/auth/logout*/route.ts`, `hooks/use-session.ts` | Sign-out also ends the Access session (`/cdn-cgi/access/logout`); otherwise the next page load would sign the person straight back in |
| `src/middleware.ts` | A browser that arrived through Access with no session is routed to the bridge, not the password page. This decides routing only; nothing is trusted because of it. |
| `src/server/config/env.ts`, `env.worker.ts` | `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` must be set together, in every environment. A production Worker refuses to boot without them. |

### 2.1 Why the assertion is checked on every request

A session cookie outlives the Access session that created it. Without the per-request check:

* revoking someone in Access or in Google Workspace would leave their application session working
  until the idle timeout;
* a request sent to the Worker's `*.workers.dev` hostname, bypassing Access, would be served on a
  stolen cookie alone.

The assertion is verified against cached JWKS keys (one-hour TTL), so the per-request cost is one
RSA signature check.

### 2.2 What is never trusted

* `Cf-Access-Authenticated-User-Email`, or any other plaintext header.
* An e-mail address or user id sent by the browser.
* A token whose `aud` belongs to another Access application, or whose `iss` is another team.
* A token signed with `alg: none` or HS256.

### 2.3 Account policy is unchanged

`completeAccessLogin` delegates to the same `completeOAuthLogin` the Google sign-in uses, so the
rules are identical:

* **Company domain:** an address outside `COMPANY_EMAIL_DOMAINS` and the organization's domains
  is refused.
* **Unknown user:** refused (`not_provisioned`) unless the organization has auto-provisioning
  switched on. It is off by default.
* **Inactive user:** refused (`deactivated`). An already-issued session also stops working on the
  next request, because `resolveSession` re-reads the user's status.
* **Organization isolation:** the user is resolved by e-mail within its own organization, and the
  session carries that `organizationId` exactly as before.

## 3. Configuration

### 3.1 Cloudflare Access application

1. **Zero Trust → Settings → Authentication:** add **Google Workspace** as the identity provider,
   using an OAuth client from the company's Google Cloud project.
2. **Zero Trust → Access → Applications → Add → Self-hosted:**
   * **Domain:** the production hostname of the Worker, e.g. `drive.company.com`. Add the staging
     hostname as a separate application.
   * **Session duration:** 8–24 h. The application session has its own idle and absolute limits.
   * **Identity providers:** Google Workspace only. Turn on instant auth.
   * **Policy:** *Allow*, where *Emails ending in* `@company.com`. Optionally also require the
     Google Workspace group of employees.
3. Copy the application's **Audience (AUD) tag** from its Overview tab. That value is `CF_ACCESS_AUD`.
4. `CF_ACCESS_TEAM_DOMAIN` is `<team>.cloudflareaccess.com`, without `https://`.
5. **Close the bypass:** disable the `*.workers.dev` route for the production Worker
   (`workers_dev = false` / Settings → Domains & Routes), so the only way in is through Access.
   The per-request check refuses such requests anyway; this removes the route entirely.

### 3.2 Secrets

```
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN --env production
npx wrangler secret put CF_ACCESS_AUD         --env production
```

Neither value is strictly a secret, but keeping them in the secret store means the deployed
configuration cannot be edited by a change to `wrangler.jsonc`.

### 3.3 Google Workspace

* The OAuth client used by Access belongs to the company's Google Cloud project. It needs only the
  standard sign-in scopes (openid, email, profile).
* This is **separate** from the Drive service account, which must not have domain-wide delegation
  (see `FINAL-READINESS.md`).

### 3.4 Employees

Every employee who will sign in must already exist in the application with status `active`. The
cutover migration copies existing users. After cutover, new employees are created by an
administrator as before. Access does not create accounts.

## 4. Local development

With `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` empty (the default in `.env.example` and
`.dev.vars.example`), nothing changes:

* password sign-in, Google sign-in and the development user switcher work as before;
* `resolveRequestSession` is a pass-through;
* `/api/auth/access` returns 404.

A **production-mode** Worker preview refuses to boot without Access, as production would. Preview
with the `development` wrangler environment, or supply real Access values.

**There is no insecure production fallback.** The only switch is "Access configured", and a
production Worker cannot start without it.

## 5. Verification

| Test | Result |
|---|---|
| `tests/unit/cloudflare-access.test.ts` (existing): forgery refusal | 21 passed |
| `tests/security/cloudflare-access-integration.test.ts` (new) | **16 passed** |
| `tests/unit/route-protection.test.ts`: bridge and internal route on the allow-list, structural checks | passed |
| `tests/unit/malware-http-scanner.test.ts` → Worker configuration: half-Access refused, production without Access refused | passed |

The integration suite, in its own words:

* resolves the employee from the verified identity and issues a session;
* refuses an identity with no account under the default no-auto-provisioning policy;
* refuses a deactivated employee even with a valid Access token;
* refuses an address outside the company domains;
* refuses a session cookie with no Access assertion (for example, a request that bypassed Access);
* never trusts the plaintext e-mail header;
* refuses a session whose Access identity is now somebody else;
* refuses an expired or foreign-audience assertion;
* drops access the moment the employee is deactivated, Access token notwithstanding;
* accepts the cookie form of the assertion;
* refuses password sign-in and password reset while Access is configured;
* works exactly as before when Access is not configured;
* bridge: sets the session and redirects, never redirects off-site, and sends a missing, invalid
  or unprovisioned identity to the denial page without a session;
* bridge returns 404 when Access is not configured.

## 6. Rollback

Unset both `CF_ACCESS_*` values. Sign-in returns to password and Google on the Node deployment on
the next request. A production *Worker* cannot run without Access, so a rollback away from Access
is a rollback to the Node deployment (`ROLLBACK-RUNBOOK.md`).
