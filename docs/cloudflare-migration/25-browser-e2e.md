# Browser end-to-end suite (Playwright, D1 backend)

**Status: green.** 34 of 34 pass locally on the D1 backend (2026-09-29). Results in §4. The
defects found on the way, four of them in the product, are in §5.

---

## 1. What it is

`npm run test:e2e` drives the real UI in Google Chrome against a real `next dev` server and a
real database. Nothing is mocked: no API stubs, no fake repositories, no seeded browser state.

| Spec | Covers |
|---|---|
| `e2e/00-smoke.spec.ts` | `/api/health`; an anonymous visitor is sent to `/login`; a seeded employee signs in through the form and reaches My Drive |
| `e2e/10-drive-flow.spec.ts` | One scientist's working day with a second person in it: My Drive → create folder → upload → details, research metadata, tags → search → star → Starred and Recent → the second user is refused before sharing → share (and the delegation guard refusing "approver") → Shared with me → upload version 2 with a note → version history → an administrator delegates approval → submit for review → the department head approves version 2 → move the folder → the approved file cannot be trashed (menu and server) → a draft file is trashed and restored → download and preview return the current bytes, version 1 still retrievable, a real browser download → the audit trail recorded every step |
| `e2e/20-inventory.spec.ts` | Create an item (starts empty) → receive against a batch → issue to a department → overdraw refused with the server's message → the stock ledger is complete and append-only (PUT/PATCH/DELETE → 405) |
| `e2e/30-admin.spec.ts` | Create a department → add an employee → the employee reaches only their own department → a department-scoped role grant signs them out → after signing in the new department is reachable → a `restricted` project opens only on membership → deactivation refuses both the session and sign-in |
| `e2e/35-admin-loading.spec.ts` | Regression: the *Add employee* pickers work while the employee list is still loading |

Authentication is the real password form (the dev account switcher is off). The Access path is
covered by `tests/security/cloudflare-access-integration.test.ts`; a browser test of it needs a
live Cloudflare Access application.

## 2. How the backend is prepared (`e2e/global-setup.ts`)

1. Drops and re-seeds MongoDB database `biotech_drive_e2e` with the deployment's own seed script
   (`scripts/seed.ts --demo`): an administrator and three employees in different departments.
2. For the D1 backend (the default): creates a fresh local D1 under the OS temp directory, applies
   the real migrations (`wrangler d1 migrations apply --local`), loads the seeded MongoDB into it
   with the real migration tool (`migrate:d1 --write`) and verifies the load (`migrate:verify`).
   **Every E2E run is therefore also a migration dry run** of the tooling on seeded data.
3. The dev server runs with every `DATA_SOURCE_*=d1` and `D1_LOCAL_PROXY_PERSIST` pointing at that
   database, so every repository is the D1 one.

`E2E_BACKEND=mongo npm run test:e2e` runs the same specs against the MongoDB deployment.

### 2.1 `D1_LOCAL_PROXY_PERSIST` cannot reach a deployment

`src/server/db/d1-context.ts` gives a Node dev server a D1 through wrangler's platform proxy
(the same workerd SQLite as `wrangler dev --local`) when that variable is set. It is:

* **ignored on a Worker**: the binding comes from Cloudflare;
* **refused on Node unless `NODE_ENV` is `development` or `test`**: a production or staging Node
  server with it set fails with `D1BindingUnavailableError` rather than opening a local file;
* loaded by a computed module name, so no bundler pulls wrangler into the application.

`tests/unit/d1-local-proxy-guard.test.ts` pins all three.

One proxy per Node process (held on `globalThis`): `next dev` compiles each route into its own
module graph, and a module-level cache started one `workerd` per route until the machine ran out
of memory.

## 3. Requirements and running it

* MongoDB on `127.0.0.1:27017` as replica set `rs0` (transactions). Override with
  `E2E_MONGODB_URI`. README §Quick start shows the one-line Docker setup.
* Google Chrome installed (`channel: 'chrome'`; no browser download).
* Serial, one worker, by design: the specs are one working day in order.
* The dev server uses Turbopack. Webpack's dev compiler held 3.5 GB and drove an 8 GB machine
  into paging.

* Each browser context presents its own client address (`newMachine` in `e2e/helpers.ts`,
  TEST-NET-3), so the suite's ~12 sign-ins do not add up against the per-IP sign-in limit, which
  stays at its production value of 10 per 15 minutes.
* On a nearly full Windows disk, Storage Sense empties `%TEMP%` — which holds the suite's D1
  database — part-way through a run. Point `TEMP`/`TMP` elsewhere for the run, e.g. the
  git-ignored `playwright-report/tmp`.

Iteration aids: `E2E_REUSE_STATE=1` keeps the seeded backend; `npx tsx e2e/dev-server.ts` plus
`E2E_REUSE_SERVER=1` attaches to a server started by hand, with its logs visible.

No credential is committed: the suite's secrets are fixed test-only strings in `e2e/env.ts`,
the password is a test constant, and `test-results/` and `playwright-report/` are git-ignored.

CI: the `e2e` job in `.github/workflows/ci.yml` (MongoDB replica set service, ubuntu's Chrome).

## 4. Results

Last full run (2026-09-29, D1 backend, local MongoDB rs0, Chrome, fresh seed and fresh
server): **34 passed, 0 failed, 0 skipped** in 17.3 min, after ~6 min of global setup (seed,
D1 migrations, `migrate:d1 --write`, `migrate:verify` — all ok).

The three failures open at the previous run (2026-09-28: 18 passed, 3 failed, 11 skipped):

| Previously failing | Classification | Resolution |
|---|---|---|
| Administrator delegates approval | Test fixture (race) | The spec now waits for the share POST; the server path was verified directly (§5) |
| Stock history is complete and immutable | Not reproduced | Passed in every run since, including two back-to-back against one server |
| Add an employee | Implementation defect | TanStack Table reset loop fixed. The suspected second loop in Radix Select did not reproduce once it was: reverting that one fix alone brings the hang back |

Getting past those exposed the rest of §5 — the approval, trash, download and audit steps had
never executed before this run.

## 5. Defects the suite found

| Defect | Where | Fix |
|---|---|---|
| The *New department* form could not be submitted with the optional quota empty: `z.coerce.number()` turned `''` into `0`, below the minimum, and the error was never shown | `src/components/admin/create-department-dialog.tsx` | Empty means "no quota"; the field shows its error |
| The drive-flow spec asked for a review from someone holding only a *Viewer* share | `e2e/10-drive-flow.spec.ts` | Spec defect, not a product one: the server correctly refuses to name a reviewer without `review.perform` (422), and the owner, a research scientist, cannot delegate a permission they do not hold. The spec now has an administrator — who holds approval — delegate *Approver* to the department head through the share dialog, and asserts the head's capabilities flip from `canReview/canApprove: false` to `true` |
| **Confidential projects were visible below clearance** (both engines). `listVisible` — which also decides `GET /api/projects/:id` — and `getProjectRoot` let any role-scope route in (own department, department/project scope, company-wide read) regardless of the project's classification. A Lab Technician (cleared to `internal`) with a MOLBIO grant saw the name, members and description of every `confidential` MOLBIO project | `project.repository.{mongo,d1}.ts`, `drive.service.ts`, `project.service.ts` | Role-scope branches now also require `confidentiality ∈ clearance`, exactly as files and folders do (`visibility.ts`); membership and lead still see a project at any classification. One input builder and one predicate, `permissions/project-visibility.ts`, replace two copies. Pinned on both engines in `tests/d1/project-experiment-repository.test.ts` |
| **A revoked session locked the person out of the sign-in page.** After a role change (which revokes sessions) the stale cookie made the middleware send `/login` to `/home`, whose guard sent it back to `/login`: `ERR_TOO_MANY_REDIRECTS`, with no way to sign in again short of clearing cookies by hand | `page-guard.ts` | A server component cannot clear a cookie, so the guard now sends a dead cookie through `GET /api/auth/session-expired`, which clears it and redirects to sign-in. It clears nothing while the session is still valid, so a link to it cannot sign anybody out |
| **Opening the *Add employee* pickers while the employee list was loading hung the tab.** `useReactTable({ data: data?.items ?? [] })` handed the table a new array every render; TanStack answers a new `data` identity with a page-index reset, a state update, so the page re-rendered for ever and the picker's options were detached before they could be clicked. Reproduced by holding `/api/admin/users` back 8 s; reverting the fix makes it fail again | `users-manager.tsx` | A module-level empty array. Regression spec: `e2e/35-admin-loading.spec.ts` |
| **The per-IP sign-in limit was keyed on a client-written header.** `buildRequestContext` used the first `X-Forwarded-For` entry. Cloudflare and the Node deployment's nginx both *append* to that header, so its first entry is whatever the client sent, and anyone could reset their own sign-in counter per attempt | `route-handler.ts` | `CF-Connecting-IP`, then `X-Real-IP` (both overwritten by the proxy), then `X-Forwarded-For` only as a last resort. `tests/unit/client-ip.test.ts`. Found because the suite's own sign-ins tripped the limit, which is left at its production value; each E2E browser context now presents its own TEST-NET-3 address instead |
| The admin's re-share to *Approver* looked like a server defect (share 200, nothing changed) | `e2e/10-drive-flow.spec.ts` | Spec defect: the dialog already listed the head from the earlier viewer share, so "Remove Maya" was visible before the request was sent, and closing the context aborted it. Reproduced against the server directly: the level change applies and `canReview/canApprove` flip. The step now waits for the POST's 200 |
| The trash step trashed the file the previous step had approved | `e2e/10-drive-flow.spec.ts` | Spec defect: an approved file is read-only by design (`assertNotApproved`). The spec now asserts that — menu item disabled, and the server answers 403 with the approval message — and trashes and restores a separate draft file |
| `send()` never sent the CSRF token, so every API step in the admin spec was refused with 401, and a test asserting a *refusal* would have passed for the wrong reason | `e2e/helpers.ts` | `mutate()` sends the `x-csrf-token` echoed from `bd_csrf`, as the application's client does; `send()` and the ledger's 405 check use it |
| The move step read `parentFolderId` from the top level of `{ folder, breadcrumbs }` and compared by substring | `e2e/10-drive-flow.spec.ts` | Reads `folder.parentFolderId` and requires it to equal the target folder's id |
| Global setup spawned `npx` through `cmd.exe`, which re-split every argument on spaces: a checkout or `TEMP` whose path contains a space handed wrangler a broken `--persist-to` | `e2e/global-setup.ts` | Runs the tsx and wrangler CLIs with `process.execPath`, no shell — the same fix `17aaf5d` made in the migration gateway |
| The membership step expected a `confidential` project to be hidden from an employee who also holds Research Scientist (cleared to `confidential`) | `e2e/30-admin.spec.ts` | Spec defect. Clearance belongs to the *person*: `actorClearance` is the highest over all grants, and `authorize.ts` and the file/folder filters use it the same way, so a confidential MOLBIO project is legitimately visible through the MOLBIO grant. The step now uses a `restricted` project, which role scope never reaches — only membership opens it, which is what the step is about and which holds only since the project-visibility fix above |
