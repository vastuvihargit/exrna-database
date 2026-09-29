# Rollback runbook: Cloudflare Worker + D1 → Node + MongoDB

The target of every rollback is the Node deployment, left running in `maintenance` mode at
cutover step 19, with MongoDB exactly as it was at the final delta pass (cutover step 10).
Step numbers below refer to `CUTOVER-RUNBOOK.md`.

> **Changes written only to D1 after cutover do not exist in MongoDB.** There is no automatic
> reverse migration. Nothing in this repository copies D1 back to MongoDB, and a flag revert does
> not make D1 rows appear there. Every rollback after users have started writing loses those
> writes unless they are reconciled by hand (§3).

---

## 1. Which rollback applies

| When the problem is found | Writes that exist only in D1 | Rollback type | Data loss |
|---|---|---|---|
| Before cutover step 15 (flags not switched, Worker not deployed) | none | **Abort**: set Node `MAINTENANCE_MODE=off`, restart the scheduler | none |
| Steps 15–18 (inside the window, before users are let in) | only the operator's smoke-test actions | **Clean rollback** (§2) | none that matters: smoke-test data |
| After step 19, within the rollback window (§4) | real user work since `CUTOVER_AT` | **Rollback with reconciliation** (§2 + §3) | whatever is not re-entered |
| After the rollback window closes | days of work | **Fix forward only** | n/a |

**Maximum safe (lossless) rollback window: from step 15 to step 19.** Users are not writing
then, so reverting loses nothing. That is why step 18's smoke tests are strict: they are the last
point at which rollback is free.

## 2. Procedure

Two people; record every time.

1. **Re-enter the write freeze on the Worker:** set `MAINTENANCE_MODE=maintenance` in
   `env.production.vars` and redeploy (`npx opennextjs-cloudflare deploy --env production`),
   or put a Cloudflare maintenance rule in front of the hostname.
   **Pass:** every request except `/api/health*` answers 503.
2. **Stop writes:** confirm Workers Logs shows no successful non-GET request after the switch.
   Queue deliveries arriving during maintenance are retried, not lost; the cron-triggered
   maintenance jobs enqueue but their consumer answers 503 and retries. To stop them outright:
   `npx wrangler queues consumer remove biotech-drive-sync-production <worker>` (and the
   notifications queue).
3. **Capture D1 state before touching anything:**
   ```bash
   npx wrangler d1 export biotech-drive-production --env production --remote --output rollback-<UTC>.sql
   ```
   This is the only copy of post-cutover work. Keep it with the cutover log.
4. **Revert the Worker deployment.** Route the production hostname away from the Worker (remove
   its Custom Domain, or point DNS back at the Node reverse proxy). Leave the Worker deployed in
   maintenance mode for forensics. If a *code* defect rather than the migration is the cause and
   a previous Worker version was healthy, `npx wrangler rollback --env production` restores it
   instead — that is a Worker revert, not a rollback to MongoDB, and needs no reconciliation.
5. **Revert the data-source flags.** On Node every `DATA_SOURCE_*` stays **unset**, which it
   already is (Node has no D1 binding at all). On the Worker leave them at `d1`: a production
   Worker refuses to boot with any on `mongo` (§5), and it is no longer serving users.
6. **Restore MongoDB as authoritative.** MongoDB was frozen at the final delta and has received
   no writes since. Confirm it is intact:
   ```bash
   npm run migrate:validate          # read-only; still PASS
   ```
   If MongoDB itself is damaged (not the expected case), restore the step-1 baseline:
   `mongorestore --uri "$MONGODB_URI" --gzip --archive=cutover-pre.gz --drop`.
7. **Storage rollback considerations.** Node reads both `local` and `google_drive` versions, and
   every version that existed at the freeze is Drive-backed (steps 8–11). **No storage change is
   needed.** Files uploaded through the Worker after cutover *are* in the Shared Drive, but their
   metadata is only in D1 (§3). Do not delete anything from the Shared Drive: an object that looks
   orphaned to Node may be post-cutover work awaiting reconciliation. Node's `drive:sync` treats
   such objects as unknown and ignores them.
8. **Re-activate Node:**
   * Set `MAINTENANCE_MODE=read_only` in its `.env` and restart:
     `docker compose -f docker-compose.prod.yml up -d app`.
   * Start the scheduler again: `docker compose -f docker-compose.prod.yml start scheduler`.
   * If the Access application stays in front of the hostname, Node ignores it: `CF_ACCESS_*` is
     unset there, so sign-in is password / Google as before.
9. **Reconcile** (§3) — only for a rollback after step 19. Security-relevant changes first.
10. **Validate before reopening access:**

    | Check | Pass |
    |---|---|
    | `GET /api/health/ready` on Node | 200, database `ok`, storage `ok` |
    | Sign in with a password (or Google) | works |
    | Open, download and preview three files that existed before cutover | work |
    | Admin → System | no critical checks; Drive connected; scheduler jobs reporting within 15 min |
    | Every deactivation and revoked grant made on the Worker after `CUTOVER_AT` (§3.3) | re-applied on Node, checked by signing in as one affected user |
    | `npm run migrate:validate` | still PASS |

11. **Sessions.** Every user is signed out again. Node's sessions live in MongoDB and those issued
    before the freeze may have expired during the window; Access-issued Worker sessions exist only
    in D1 and mean nothing to Node. Tell users to sign in again with their password or Google.
12. **Reopen:** set Node `MAINTENANCE_MODE=off`, restart the app container, and announce the
    rollback to users, including the reconciliation note from §3 if it applies.

**Do not delete D1.** It holds the post-cutover record and is the starting point of a retry.

## 3. Reconciling writes made only to D1

Needed only for a rollback after step 19.

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
   what. Automatic inventory write-offs (`stock_transactions.action = 'expired'`, no
   `performed_by`) need no reconciliation: Node's own scheduler repeats them.
2. **Bytes are safe; metadata is not.** Every file uploaded through the Worker is in the Shared
   Drive; `file_versions.google_drive_file_id` in the export names it. Re-creating those files on
   Node means re-uploading them from Drive, by an administrator or by their owners from the list.
3. **Re-enter decisions by hand:** approvals, permission changes, stock movements, deactivations.
   Security-relevant changes come first: a user **deactivated** or an access grant **revoked**
   after cutover is *active again* on Node until re-applied. Re-apply those before step 12.
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

* **Setting `DATA_SOURCE_*` flags to `mongo` on the Worker.** A production Worker refuses to boot
  with any module on MongoDB — it cannot open a MongoDB connection at all.
* **Unsetting `CF_ACCESS_*` on the Worker.** Same: it refuses to boot. The rollback away from
  Access is the rollback to Node.
