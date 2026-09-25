# Rollback runbook: Cloudflare Worker + D1 → Node + MongoDB

The target of every rollback is the Node deployment, left running in `maintenance` mode at
cutover step 18, with MongoDB exactly as it was at the final delta pass.

> **Changes written only to D1 after cutover do not exist in MongoDB.** There is no automatic
> reverse migration. Nothing in this repository copies D1 back to MongoDB, and a flag revert does
> not make D1 rows appear there. Every rollback after users have started writing loses those
> writes unless they are reconciled by hand (§3).

---

## 1. Which rollback applies

| When the problem is found | Writes that exist only in D1 | Rollback type | Data loss |
|---|---|---|---|
| Before cutover step 13 (flags not switched) | none | **Abort**: set Node `MAINTENANCE_MODE=off`, restart the scheduler | none |
| Steps 13–17 (inside the window, before users are let in) | only the operator's smoke-test actions | **Clean rollback** (§2) | none that matters: smoke-test data |
| After step 18, within the rollback window (§4) | real user work since `CUTOVER_AT` | **Rollback with reconciliation** (§2 + §3) | whatever is not re-entered |
| After the rollback window closes | days of work | **Fix forward only** | n/a |

**Maximum safe (lossless) rollback window: from step 13 to step 18.** Users are not writing
then, so reverting loses nothing. That is why step 17's smoke tests are strict: they are the last
point at which rollback is free.

## 2. Procedure

Numbered to match the cutover. Two people; record every time.

1. **Enable maintenance mode on the Worker:** set `MAINTENANCE_MODE=maintenance` in the production
   vars and redeploy (`npx opennextjs-cloudflare deploy -- --env production`), or put a
   Cloudflare maintenance rule in front of the hostname.
   **Pass:** every request except `/api/health*` answers 503.
2. **Stop writes:** confirm Workers Logs shows no successful non-GET requests after the switch.
   Pause both queue consumers: `npx wrangler queues consumer remove …`, or leave them paused by
   maintenance mode, where deliveries answer 503 and are retried.
3. **Capture D1 state before touching anything:**
   ```bash
   npx wrangler d1 export biotech-drive-production --env production --remote --output rollback-<UTC>.sql
   ```
   This is the only copy of post-cutover work. Keep it with the cutover log.
4. **Restore the previous `DATA_SOURCE_*` configuration:** on Node every flag stays **unset**,
   which it already is. Nothing points Node at D1 (Node has no D1 binding at all).
5. **Restore MongoDB as authoritative.** MongoDB was frozen at the final delta pass and has
   received no writes since. Confirm it is intact:
   ```bash
   npm run migrate:validate          # read-only; still PASS
   ```
   If MongoDB itself is damaged (not the expected case), restore `cutover-pre.gz` from step 1:
   `mongorestore --gzip --archive=cutover-pre.gz --drop`.
6. **Restore the previous storage path if necessary.** Node reads both `local` and `google_drive`
   versions, and every version that existed at the freeze is Drive-backed (step 7). **No storage
   change is needed.** Files uploaded through the Worker after cutover are in the Shared Drive,
   but their metadata is only in D1 (§3).
7. **Deploy (re-activate) the previous application build:** the Node deployment is still running.
   * Set `MAINTENANCE_MODE=off` in its `.env`.
   * Restart it: `docker compose -f docker-compose.prod.yml up -d app`.
   * Start the scheduler again: `docker compose -f docker-compose.prod.yml start scheduler`.
   * Point the production hostname back to the Node reverse proxy (DNS / route). If the Access
     application stays in front, Node ignores it: `CF_ACCESS_*` is unset there, so sign-in is
     password / Google as before.
8. **Validate:**

   | Check | Pass |
   |---|---|
   | `GET /api/health/ready` on Node | 200, database `ok`, storage `ok` |
   | Sign in with a password (or Google) | works |
   | Open, download and preview three files that existed before cutover | work |
   | Admin → System | no critical checks; Drive connected; scheduler jobs reporting again within 15 min |

9. **Resume writes:** announce the rollback to users, including the reconciliation note from §3
   if it applies.

The Worker stays deployed in maintenance mode and D1 stays intact, for forensics and a later
retry. **Do not delete D1.**

## 3. Reconciling writes made only to D1

Needed only for a rollback after step 18.

1. **List what happened after cutover.** From the export, or directly:
   ```sql
   -- run with: npx wrangler d1 execute biotech-drive-production --env production --remote --command "…"
   SELECT 'file' AS kind, id, display_name AS label, created_by AS actor, created_at FROM files      WHERE created_at >= '<CUTOVER_AT>'
   UNION ALL SELECT 'version', id, original_filename, uploaded_by, created_at FROM file_versions    WHERE created_at >= '<CUTOVER_AT>'
   UNION ALL SELECT 'folder', id, name, created_by, created_at FROM folders                        WHERE created_at >= '<CUTOVER_AT>'
   UNION ALL SELECT 'approval', id, reviewer_name, reviewer_user_id, decided_at FROM approvals      WHERE decided_at >= '<CUTOVER_AT>'
   UNION ALL SELECT 'stock', id, item_name, performed_by, performed_at FROM stock_transactions     WHERE performed_at >= '<CUTOVER_AT>'
   ORDER BY 5;
   ```
   Also list updates to pre-existing records: `updated_at >= '<CUTOVER_AT>'` on `files`, `folders`,
   `projects`, `experiments`, `inventory_items`, `users`, `resource_permissions`, and the
   `audit_logs` rows since `CUTOVER_AT`. The audit trail is the most complete account of who did
   what.
2. **Bytes are safe; metadata is not.** Every file uploaded through the Worker is in the Shared
   Drive; `file_versions.google_drive_file_id` in the export names it. Re-creating those
   files on Node means re-uploading them from Drive, done by an administrator or by their owners
   from the list.
3. **Re-enter decisions by hand:** approvals, permission changes, stock movements, deactivations.
   Security-relevant changes come first: a user **deactivated** or an access grant **revoked**
   after cutover is *active again* on Node until re-applied. Re-apply those before resuming writes
   (step 9).
4. Send each affected owner the part of the list that concerns them.

## 4. Closing the rollback window

Recommended: **24 hours** of normal use for a rollback with reconciliation, and never more than
**7 days**. Past that, reconciliation is larger than any plausible fix-forward.

Close it deliberately, in the cutover log, once all of these hold:

* no severity-1 issue open (data correctness, access control, authentication);
* dead-letter queues empty for 48 h;
* Drive sync cursor advancing;
* administrators confirm key workflows (upload, review, inventory).

Then:

* stop the Node app;
* take a final `mongodump`;
* keep it and the backup volumes for 90 days.

## 5. What is *not* a rollback

* **Deleting `DATA_SOURCE_*` flags on the Worker.** A production Worker refuses to boot without
  them, and it has no MongoDB to fall back to.
* **Unsetting `CF_ACCESS_*` on the Worker.** Same: it refuses to boot. The rollback away from
  Access is the rollback to Node.
