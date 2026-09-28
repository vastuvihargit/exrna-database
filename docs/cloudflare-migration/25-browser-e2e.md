# Browser end-to-end suite (Playwright, D1 backend)

**Status: committed, NOT yet green.** 18 of 32 pass locally; 3 fail and 11 are skipped behind them. Results in §4.

---

## 1. What it is

`npm run test:e2e` drives the real UI in Google Chrome against a real `next dev` server and a
real database. Nothing is mocked: no API stubs, no fake repositories, no seeded browser state.

| Spec | Covers |
|---|---|
| `e2e/00-smoke.spec.ts` | `/api/health`; an anonymous visitor is sent to `/login`; a seeded employee signs in through the form and reaches My Drive |
| `e2e/10-drive-flow.spec.ts` | One scientist's working day with a second person in it: My Drive → create folder → upload → details, research metadata, tags → search → star → Starred and Recent → the second user is refused before sharing → share (and the delegation guard refusing "approver") → Shared with me → upload version 2 with a note → version history → an administrator delegates approval → submit for review → the department head approves version 2 → move the folder → trash and restore → download and preview return the current bytes, version 1 still retrievable, a real browser download → the audit trail recorded every step |
| `e2e/20-inventory.spec.ts` | Create an item (starts empty) → receive against a batch → issue to a department → overdraw refused with the server's message → the stock ledger is complete and append-only (PUT/PATCH/DELETE → 405) |
| `e2e/30-admin.spec.ts` | Create a department → add an employee → the employee reaches only their own department → a department-scoped role grant signs them out → after signing in the new department is reachable → project access follows membership → deactivation refuses both the session and sign-in |

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

Iteration aids: `E2E_REUSE_STATE=1` keeps the seeded backend; `npx tsx e2e/dev-server.ts` plus
`E2E_REUSE_SERVER=1` attaches to a server started by hand, with its logs visible.

No credential is committed: the suite's secrets are fixed test-only strings in `e2e/env.ts`,
the password is a test constant, and `test-results/` and `playwright-report/` are git-ignored.

CI: the `e2e` job in `.github/workflows/ci.yml` (MongoDB replica set service, ubuntu's Chrome).

## 4. Results

Last full run (2026-09-28, D1 backend, local MongoDB rs0, Chrome): **18 passed, 3 failed, 11 did not run** (serial suite: a failure skips the rest of its file).

| Failing test | Classification | Status |
|---|---|---|
| `10-drive-flow` › an administrator delegates approval to the department head | Open. The admin's share returns 200 but neither the D1 ACL row nor an audit row changes, so the head never gains `canReview`/`canApprove`. Suspected implementation defect in the re-share (level change for an existing principal) path on D1; not yet root-caused | **open** |
| `20-inventory` › the stock history is complete and immutable | Passed in the previous run, failed in this one on the UI history table (`0 → 10` not visible after reload). Not yet classified (possible flake) | **open** |
| `30-admin` › add an employee as a Research Scientist | **Real UI defect, reproduced by hand**: opening the *Add employee* dialog's department picker before `/api/admin/users` has loaded hangs the browser tab (endless synchronous re-render, never recovers). Waiting for the list first avoids it. Investigated: not item-count or Radix positioning; TanStack Table `autoResetPageIndex` with `data ?? []` is one confirmed loop source (fix not yet applied); a second loop inside Radix Select internals remains | **open** |

Earlier, the review-request step failed because the spec asked for a review from a Viewer; that was a spec defect and is fixed (§5).

## 5. Defects the suite found

| Defect | Where | Fix |
|---|---|---|
| The *New department* form could not be submitted with the optional quota empty: `z.coerce.number()` turned `''` into `0`, below the minimum, and the error was never shown | `src/components/admin/create-department-dialog.tsx` | Empty means "no quota"; the field shows its error |
| The drive-flow spec asked for a review from someone holding only a *Viewer* share | `e2e/10-drive-flow.spec.ts` | Spec defect, not a product one: the server correctly refuses to name a reviewer without `review.perform` (422), and the owner, a research scientist, cannot delegate a permission they do not hold. The spec now has an administrator — who holds approval — delegate *Approver* to the department head through the share dialog, and asserts the head's capabilities flip from `canReview/canApprove: false` to `true` |
