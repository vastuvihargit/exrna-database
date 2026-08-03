# Operations runbook

What to do when something is wrong. Each section starts with what you would actually see
first, because that is how these arrive — as a symptom, not a diagnosis.

Related: [backup and restore](./backup-and-restore.md) · [security hardening](../security/hardening.md)

---

## The stack

```
Internet → nginx (TLS) → app (Next.js)  ┬→ mongodb        (metadata, permissions, audit)
                                        ├→ app-data       (the research files themselves)
                                        ├→ clamav         (upload scanning)
                                        └→ Google Shared Drive  (when enabled — file bytes)

scheduler   — cron: health monitor, integrity sweep, upload cleanup, trash retention,
                    and the three Shared Drive jobs below
backup      — cron: encrypted backups, restore drills; mounts the file volume READ-ONLY
```

| Shared Drive job | Every | What it does |
| --- | --- | --- |
| `npm run drive:drain` | 5 min | Moves queued uploads on to the Shared Drive |
| `npm run drive:sync` | 15 min | Picks up renames, edits and trashing done directly in Drive |
| `npm run drive:check-approvals` | hourly | Re-checks that each approved document is still the revision that was signed off |

All three are no-ops when `GOOGLE_DRIVE_STORAGE_ENABLED=false`. There is deliberately **no**
scheduled job that archives or deletes retained local copies — that is an explicit admin action
through `POST /api/admin/storage/local-copies`, and its absence from cron is the point.

| Command | Purpose |
| --- | --- |
| `docker compose -f docker-compose.yml -f docker-compose.prod.yml ps` | What is running |
| `... logs -f app` | Application logs (JSON, one object per line) |
| `... exec app curl -s localhost:3000/api/health/ready` | Liveness plus database and storage |
| `... run --rm scheduler npm run monitor` | Run every health check right now |
| `... run --rm scheduler npm run verify:storage` | Do the metadata and the bytes agree |
| `... run --rm scheduler npm run review:indexes` | Are all declared indexes built |

---

## Alert: storage volume critical — uploads are being refused

**Symptom.** Users see "The server is low on storage. An administrator has been alerted."
Admin → System shows the disk check in red.

**What is happening.** Free space fell below `MIN_FREE_DISK_GB`. This is deliberate:
uploads stop *before* the disk is full, because a genuinely full disk corrupts writes
rather than failing them cleanly. Nothing is damaged yet. That is the whole point.

**Do, in order:**

1. Confirm where it went: `docker system df -v` and `du -sh /var/lib/docker/volumes/*/`.
2. **Purge expired trash.** Files in the trash still occupy disk until their retention
   window passes.
   ```bash
   docker compose ... run --rm scheduler npm run purge:trash -- --dry-run   # look first
   docker compose ... run --rm scheduler npm run purge:trash
   ```
3. **Clear abandoned uploads.** `npm run cleanup:uploads`.
4. **Check for orphans** — bytes with no database row, usually residue from a crash:
   `npm run verify:storage`. They are reported and never deleted automatically, because
   the one time deleting them would be catastrophic is during a partial restore, which is
   exactly when this is most likely to be run. Delete them by hand once you are sure the
   database is intact.
5. If it is genuinely full, grow the volume. Lowering `MIN_FREE_DISK_GB` to make the
   alert go away is not a fix; it removes the guard rail that is currently protecting you.

---

## Alert: no backup has ever reported success / backups are stale

**Symptom.** Admin → System shows the backup check red.

1. `docker compose ... ps backup` — is the container even running?
2. `docker logs biotech-drive-backup --tail 200` — the failure line names the *stage*
   (`mongodump`, `backup_files`, `offsite_copy`, …), which is what tells you where to look.
3. Common causes:
   - `BACKUP_ENCRYPTION_PASSWORD` unset → the job refuses to start at all.
   - The off-server target is unreachable → everything succeeded except the copy. The
     status file says so and the run is marked failed, correctly: an on-server-only
     backup is not a backup.
   - The backup volume is itself full → `restic forget --prune` needs headroom to work.
4. Force a run once fixed:
   ```bash
   docker compose ... exec backup sh /usr/local/bin/run-job.sh backup
   ```

Full procedure: [backup and restore](./backup-and-restore.md).

---

## Alert: malware scanner unreachable

**Symptom.** Uploads fail with a service error (fail-closed) or the System page warns
that files are being stored unscanned (fail-open).

In production with scanning enabled the system **fails closed** by default — an
unreachable scanner refuses uploads rather than accepting them unscanned, because
"unknown" is not "clean".

1. `docker compose ... ps clamav` and `docker logs biotech-drive-clamav`.
2. On first start ClamAV downloads its full signature database, which takes several
   minutes. The healthcheck allows for it; be patient before restarting.
3. Out of memory is the usual cause of a crash loop — ClamAV holds its signatures in RAM
   and needs roughly 2 GB. The prod compose file allocates that.
4. `docker compose ... restart clamav`.

Do not "fix" this by setting `MALWARE_SCAN_FAIL_CLOSED=false` under pressure. That
converts an upload outage into a silent security hole, and nobody will remember to change
it back.

---

## Alert: restore drill failed

The most serious alert in the system, and the least urgent-feeling. Nothing is broken
right now. What has broken is your ability to recover from the next thing.

1. `docker logs biotech-drive-backup` — the drill names what failed: a missing object, a
   checksum mismatch, an empty restored database.
2. A checksum mismatch means the backup does not contain what the database says it
   should. Run `restic check --read-data` (the `full-check` job) against the whole
   repository before trusting any snapshot.
3. Do not clear the alert by disabling the drill.

---

## The application will not start

1. `docker compose ... logs app --tail 100`.
2. **Environment validation failures are loud and specific** — the process refuses to
   start rather than run half-configured, and names each invalid variable. Fix and
   restart; there is nothing subtle here.
3. `Invalid storage configuration: "<root>" is inside the publicly served directory` —
   a storage root was pointed at `public/`. The boot assertion caught it. That
   misconfiguration would have made every research file downloadable without
   authentication.
4. Database unreachable: `docker compose ... exec mongodb mongosh --eval 'rs.status()'`.
   A replica set that never initiated has no primary and every transaction fails; the
   `mongo-init` container runs `rs.initiate()` once.

---

## "A file is missing" / "I cannot download something"

1. Is it in the trash or archive? Both are recoverable in the UI.
2. `npm run verify:storage` — if the version row exists but the bytes do not, that is
   real data loss and the backup is the answer, not the application.
3. If it is a permission problem the user sees a permission-denied state, not a missing
   file. Admin → Audit log, filtered to the file id, shows what was granted and revoked
   and by whom.

---

## Deploying

```bash
git fetch --all --tags && git checkout <tag>
GIT_SHA=$(git rev-parse HEAD) docker compose \
  -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose ... run --rm scheduler npm run verify:storage
```

The last line is not ceremony. "Files survive redeployment" is the acceptance criterion
this whole architecture exists for, and this is what proves it each time.

The `Deploy` GitHub Actions workflow does the same thing over SSH and runs the same check.
It deliberately does **not** roll back automatically on a failed health check: a
half-rolled-back file volume is worse than a stopped deploy.

---

## Rotating secrets

| Secret | Effect of rotating | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | Every employee is signed out | Do it if a session leak is suspected |
| `AUTH_SECRET` | Invalidates password-reset tokens | Must differ from `SESSION_SECRET` in production — enforced at boot |
| `BACKUP_ENCRYPTION_PASSWORD` | **Old snapshots become unreadable** | Keep the old password until the old snapshots have aged out of retention |
| Google OAuth | Sign-in and Drive migration stop until updated | Two separate redirect URIs; the migration grant is far broader than sign-in |

---

## Restoring a deactivated employee's access

Deactivation is immediate and applies to sessions already in flight — session resolution
re-checks user status on every request rather than trusting the cookie. Reactivating from
Admin → Employees restores access the same way. The employee's files were never theirs
personally; they belong to the department and project drives and are unaffected.

---

## What to escalate

| Situation | Why it cannot wait |
| --- | --- |
| Missing bytes reported by `verify:storage` | Research data is already gone; every hour reduces which backup still holds it |
| Restore drill failing repeatedly | You do not currently have a recovery path |
| Disk critical with no purgeable space | Uploads are refused and the platform is read-only |
| Audit log write failures | Actions are happening that are not being recorded |
