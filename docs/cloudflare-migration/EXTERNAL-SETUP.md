# External setup checklist: what a person with account access must create

Everything in this list needs an account, a credential or a business decision that the
repository cannot supply. The code for each item is written and tested locally; what is blocked
is the live run. Do the **staging** column first, rehearse (`REHEARSAL.md`), then production.

Secrets are listed **by name only**. None has a value in Git; `.dev.vars` and `.env` are
git-ignored.

---

## 1. Cloudflare

### 1.1 D1 databases

| Environment | Command | Then |
|---|---|---|
| staging | `npx wrangler d1 create biotech-drive-staging` | paste the returned id into `wrangler.jsonc` → `env.staging.d1_databases[0].database_id` |
| production | `npx wrangler d1 create biotech-drive-production` | paste into `env.production.d1_databases[0].database_id` |
| development (optional) | `npx wrangler d1 create biotech-drive-dev` | top-level and `env.development` blocks. Local development does not need it: `--local` ignores the id. |

Every id is currently the placeholder `00000000-0000-0000-0000-000000000000`. A remote deploy or
`--remote` migration with it fails, and `deploy-cloudflare.yml` refuses to run while the staging
one is still a placeholder.

Apply the schema: `npm run db:migrate:staging`, `npm run db:migrate:production`.
**Pass:** `npx wrangler d1 migrations list biotech-drive-<env> --env <env> --remote` shows
0000–0005 applied.

### 1.2 Queues (four per environment)

```
npx wrangler queues create biotech-drive-sync-<env>
npx wrangler queues create biotech-drive-sync-dlq-<env>
npx wrangler queues create biotech-drive-notifications-<env>
npx wrangler queues create biotech-drive-notifications-dlq-<env>
```

`<env>` is `staging` and `production` (and `dev` if you deploy the development environment).
The consumers, retry limits and dead-letter wiring are already in `wrangler.jsonc`. The sync
queue also carries the scheduled maintenance jobs (inventory expiry, trash purge, expired
uploads, the approval check); there is no separate queue for them.

### 1.3 Durable Object (rate limiter)

Nothing to create by hand. `wrangler deploy` creates the `RateLimiter` Durable Object class from
the `migrations` block in `wrangler.jsonc` on first deploy. It needs a Workers **Paid** plan
(SQLite-backed Durable Objects).

### 1.4 Sign-in: choose one front door per environment

`AUTH_PROVIDER` in `env.<env>.vars` selects it (`src/server/auth/auth-provider.ts`). **Staging
uses `google_oauth`**; production is undecided and, with `AUTH_PROVIDER` unset, still requires
Access (§1.4b). Either way the identity provider only establishes *who* someone is: the account
must already exist in the application and be `active`, and roles, departments, projects and ACLs
decide what they may do.

#### 1.4a Google Workspace OAuth (`AUTH_PROVIDER=google_oauth`, staging)

No Cloudflare Access. `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` must be **unset** — the Worker
refuses to boot with them. Password sign-in and self-service password recovery are closed, and
unknown users are refused (no auto-provisioning, whatever the organisation setting says).

1. Google Cloud console → the company project → APIs & Services → OAuth consent screen:
   **Internal** (Workspace users only); scopes `openid`, `email`, `profile` — nothing else.
2. Credentials → Create credentials → OAuth client ID → **Web application**.
   * Authorized redirect URI — exactly `${APP_URL}/api/auth/google/callback`. For staging:
     `https://exrna-database-staging.cmc-330.workers.dev/api/auth/google/callback`
   * No JavaScript origins are needed (the flow is server-side).
3. Client ID → secret `GOOGLE_OAUTH_CLIENT_ID`; client secret → secret
   `GOOGLE_OAUTH_CLIENT_SECRET`.
4. `APP_URL` (https) is the origin the redirect URI is derived from; set `GOOGLE_REDIRECT_URI`
   only to override it, and then only on the same origin.

What a sign-in must satisfy: a valid RS256 ID token from Google for this client (issuer,
audience, expiry, nonce), `email_verified`, an `hd` claim equal to `GOOGLE_WORKSPACE_DOMAIN`, an
email address on that same domain, and an existing active user with that address.
`COMPANY_EMAIL_DOMAINS` must include `GOOGLE_WORKSPACE_DOMAIN`.

#### 1.4b Cloudflare Access (one application per hostname)

Full procedure: `22-cloudflare-access.md` §3.

1. Zero Trust → Settings → Authentication: add **Google Workspace** as an identity provider.
2. Access → Applications → Add → Self-hosted:
   * domain: the staging hostname, then (a separate application) the production hostname;
   * identity provider: Google Workspace only;
   * policy: *Allow* where *Emails ending in* your company domain.
3. Record the application's **Audience (AUD) tag** → `CF_ACCESS_AUD`.
4. Record the team domain `<team>.cloudflareaccess.com` → `CF_ACCESS_TEAM_DOMAIN`.

### 1.5 Hostname / custom domain

`wrangler.jsonc` declares **no route and no custom domain** in any environment, and production
has `workers_dev: false`. The production Worker therefore has no public address until you add
one:

* Workers & Pages → the Worker → Settings → Domains & Routes → **Add custom domain**
  (e.g. `drive.company.com`), **or** add a `routes` entry to `env.production` in
  `wrangler.jsonc`.
* Put the same hostname in front of the Access application (§1.4b), when Access is used, **before** users are sent to
  it.
* Consider setting `workers_dev: false` for staging too once its custom domain exists; the
  per-request Access check refuses a request that bypassed Access either way.

### 1.6 Worker secrets

`npx wrangler secret put <NAME> --env staging` (then `--env production`).

| Name | Required | Notes |
|---|---|---|
| `AUTH_SECRET` | yes | ≥ 32 characters |
| `SESSION_SECRET` | yes | ≥ 32 characters, different from `AUTH_SECRET` |
| `APP_URL` | yes | `https://<hostname>`. Staging: `https://exrna-database-staging.cmc-330.workers.dev` |
| `COMPANY_EMAIL_DOMAINS` | yes | comma-separated. **A var for staging** (`wrangler.jsonc`) — do not also set it as a secret |
| `GOOGLE_SHARED_DRIVE_ID` | yes | §2.1 |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | recommended | §2.2. Without it, content is written to the Shared Drive root and the admin page warns. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | yes | §2.3 |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | yes | the PEM from the key JSON, one line, `\n`-escaped |
| `GOOGLE_WORKSPACE_DOMAIN` | yes | e.g. `company.com`. **A var for staging** (`wrangler.jsonc`) — do not also set it as a secret |
| `GOOGLE_OAUTH_CLIENT_ID` | with `AUTH_PROVIDER=google_oauth` | §1.4a |
| `GOOGLE_OAUTH_CLIENT_SECRET` | with `AUTH_PROVIDER=google_oauth` | §1.4a |
| `CF_ACCESS_TEAM_DOMAIN` | **yes in production** unless `AUTH_PROVIDER=google_oauth`, when it must be unset | §1.4b. Must be set together with `CF_ACCESS_AUD`. |
| `CF_ACCESS_AUD` | as `CF_ACCESS_TEAM_DOMAIN` | §1.4b |
| `MALWARE_SCAN_SECRET` | when `MALWARE_SCAN_MODE=http` | ≥ 16 characters; §4 |

Also required, as **vars** in `wrangler.jsonc` → `env.<env>.vars`:

* `MALWARE_SCAN_MODE`: `http` or `disabled` (§4). Staging and production refuse to boot
  without it.
* `MALWARE_SCAN_ENDPOINT`: an `https://` URL, when the mode is `http`.
* The 22 `DATA_SOURCE_*=d1` flags, at cutover step 15 (`DATA-SOURCE-FLAGS.md` §2). Set them for
  **staging** as soon as staging holds migrated data.

Not needed on the Worker: `MONGODB_URI`, the `*_ROOT` storage paths and `CLAMAV_*`. They are
Node-deployment settings. (`GOOGLE_CLIENT_ID` / `_SECRET` are accepted as aliases of the
`GOOGLE_OAUTH_*` names.)

**Set values as secrets, never as dashboard text variables.** `wrangler deploy` replaces the
Worker's plain-text variables with the `vars` in `wrangler.jsonc`, so a value typed into the
dashboard as a *variable* disappears on the next deploy and the Worker refuses to boot. Secrets
survive deploys. Conversely, a name that is a `var` in `wrangler.jsonc` (for staging:
`AUTH_PROVIDER`, `GOOGLE_WORKSPACE_DOMAIN`, `COMPANY_EMAIL_DOMAINS`, `MALWARE_SCAN_MODE`) must not
also be a secret.

**Pass:** `npx wrangler secret list --env <env>` lists every required name.

### 1.7 GitHub (for `deploy-cloudflare.yml`, staging only)

In the repository's `staging` environment:

* `CLOUDFLARE_API_TOKEN`: a token with Workers Scripts:Edit, D1:Edit and Queues:Edit on the
  account;
* `CLOUDFLARE_ACCOUNT_ID`.

Production is deployed by hand, as a step of `CUTOVER-RUNBOOK.md`, not by a workflow.

---

## 2. Google

### 2.1 Shared Drive

* Create **one Shared Drive** owned by the company (Google Drive → Shared drives → New).
* Its id is the last path segment of its URL → `GOOGLE_SHARED_DRIVE_ID`.

### 2.2 Root folder (recommended)

* Inside the Shared Drive, create a folder for the application (e.g. `Biotech Research Drive`).
* Its id → `GOOGLE_DRIVE_ROOT_FOLDER_ID`.

### 2.3 Service account

1. Google Cloud console → the company project → IAM & Admin → Service accounts → Create.
2. Enable the **Google Drive API** on that project.
3. Keys → Add key → JSON. The `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`; the
   `private_key` → `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`. Store the JSON nowhere else.
4. **Do not** grant domain-wide delegation. Nothing in the application impersonates a user, and
   delegation would turn a leaked key into a whole-domain compromise.

### 2.4 Content Manager access

* Shared Drive → Manage members → add the service account's e-mail as **Content manager**.
* That membership is the only access the key has.

### 2.5 Workspace domain

* `GOOGLE_WORKSPACE_DOMAIN` = the Workspace primary domain.
* `COMPANY_EMAIL_DOMAINS` lists every e-mail domain employees sign in with.
* Every employee who will use the application must exist in it with status `active`, with an
  e-mail matching their Workspace address. The migration copies existing users; Access does not
  create accounts.

### 2.6 First live checks (staging)

Run the manual checklist in `docs/storage-migration/02-phase-2-google-drive.md` §4 against the
real Shared Drive. It has never been run against real Google: every Drive test so far uses
`tests/helpers/fake-drive.ts`.

---

## 3. Data you must provide for the rehearsal

* A **production MongoDB snapshot** (`mongodump --gzip --archive`) restored into a staging
  MongoDB. See `REHEARSAL.md` §1.
* Read-only credentials for the production MongoDB, for `migrate:validate` on the night.

---

## 4. Decision: malware scanning

**The repository does not choose a scanner, and must not.** Choose one of:

| Option | Set | Trade-off |
|---|---|---|
| Commercial HTTP scanning API | `MALWARE_SCAN_MODE=http`, `MALWARE_SCAN_ENDPOINT=https://…`, secret `MALWARE_SCAN_SECRET` | File bytes leave the company (data-processing agreement needed), per-scan cost |
| Self-hosted scanner behind HTTPS (e.g. ClamAV with a small HTTP adapter) | same three settings | A service to run and patch. With fail-closed, its downtime stops uploads. |
| No scanning | `MALWARE_SCAN_MODE=disabled` | An infected file of an allowed type is stored and downloadable. Must be a **signed-off business decision**, recorded in the cutover log. |

The wire contract any scanner must meet is in `24-malware-scanning.md` §2.2. The behaviour is
covered by tests: infected files and scanner errors never become downloadable in production.

---

## 5. Order of operations

1. Google §2.1–2.4 → Cloudflare §1.1–1.2 → secrets §1.6 for **staging**.
2. Sign-in §1.4 (staging: Google OAuth, §1.4a) and hostname §1.5 for staging.
3. Malware decision §4.
4. Deploy staging (`deploy-cloudflare.yml`, or `REHEARSAL.md` §5).
5. Live Drive checks §2.6 and a live Access sign-in on staging.
6. Rehearse the full cutover on staging with a production snapshot (`REHEARSAL.md`).
7. Repeat §1 for production, then `CUTOVER-RUNBOOK.md`.
