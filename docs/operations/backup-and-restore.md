# Backup and restore

The system keeps research files on one server's disk. That is a deliberate architectural
choice (see `docs/phase-0/04-storage.md`) and it has one consequence that shapes
everything in this document: **a single disk failure would otherwise destroy the
company's research record.** Backups are not a nice-to-have here, they are the other
half of the storage design.

---

## What is backed up

| What | Where it lives | How it is captured |
| --- | --- | --- |
| File bytes | `app-data` volume, `/data/storage` | `restic` incremental, encrypted, deduplicated |
| Metadata, permissions, audit log | MongoDB | `mongodump --gzip --archive`, then into the same restic repository |
| Configuration | `.env.production` on the host | **Not backed up by this job.** See below. |

Two directories are excluded on purpose:

- `quarantine/` — bytes that have not passed inspection. Some of them may be malware.
  Restoring them would reintroduce exactly what quarantine exists to hold back.
- `temporary/` — half-finished uploads. Restoring them restores nothing usable.

`.env.production` holds the secrets and is deliberately outside this job. Store it in
your password manager or secret store. **Including `BACKUP_ENCRYPTION_PASSWORD`** — a
backup password whose only copy is on the machine being backed up is not a backup
password.

---

## The schedule

Run by cron in the `backup` container (`docker/backup/crontab`), all times UTC:

| When | Job | What it does |
| --- | --- | --- |
| Daily 02:15 | `backup` | Dump, back up, verify 5% of pack data, apply retention, copy off-server |
| Sunday 03:30 | `verify-restore` | Restore into a scratch database and re-hash a sample of restored objects |
| Saturday 04:00 | `full-check` | Read every pack in the repository back — finds bit rot in old snapshots |

Retention: 30 daily, 8 weekly, 12 monthly (`BACKUP_RETENTION_DAYS` controls the daily
count).

Every run writes `last-backup.json` into the shared status volume. The application reads
it and the admin **System** page reports it. **A missing status file is reported as
"never ran", never as "fine"** — a backup system that fails silently is indistinguishable
from one that was never installed.

---

## Checking that backups are working

Three places, in increasing order of effort:

1. **Admin → System.** Backup age, whether the last run succeeded, whether it was
   verified, whether it left the building, and when a restore was last rehearsed.
2. **The alert channel.** The scheduler runs the same checks every 15 minutes and alerts
   without waiting for anyone to open a page. A backup more than 26 hours old warns; more
   than 48 hours is critical.
3. **`docker logs biotech-drive-backup`.** Every job logs its start, its stage and its
   exit code.

---

## Restoring

> Read this section before you need it. The restore script defaults to a dry run and
> refuses to write over live data, but the decisions below are yours, not the script's.

### 1. Stop writing

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app scheduler
```

Leave MongoDB running — you are about to restore into it. Stopping the app first means
no upload lands half-way through the restore.

### 2. See what you have

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  exec backup bash /usr/local/bin/restore.sh --list
```

### 3. Dry run

```bash
docker compose ... exec backup bash /usr/local/bin/restore.sh --what=all
```

This prints the plan and changes nothing. Read it. In particular check the snapshot date
— restoring last night's backup after a two-day-old corruption restores the corruption.

### 4. Restore

```bash
# Files: restored into a STAGING directory, never over live storage.
docker compose ... exec backup bash /usr/local/bin/restore.sh --what=files --confirm

# Database: --drop is required if the target database still has collections.
docker compose ... exec backup bash /usr/local/bin/restore.sh \
  --what=mongo --confirm --drop --target-uri="mongodb://mongodb:27017/biotech_drive?replicaSet=rs0"
```

Files land in `/backups/restore-staging/files-<timestamp>/data/storage/`. **The script
does not put them back into live storage and this is not an oversight.** An automated
restore that overwrites good data with older data is a second outage on top of the first.
Look at what came back, then move it yourself:

```bash
# From the host, with the app stopped:
docker run --rm -v biotech_app-data:/live -v biotech_backup-data:/restored alpine \
  cp -a /restored/restore-staging/files-<timestamp>/data/storage/. /live/storage/
```

### 5. Prove it before serving it

```bash
docker compose ... run --rm scheduler npm run verify:storage
```

This walks every version row and checks its bytes exist, are the right length, and — on a
sample — still hash to what was recorded. Exit code 2 means missing or corrupted objects
were found; do not start the application until you understand why.

### 6. Start

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## The restore drill

`verify-restore.sh` runs weekly and does, automatically, what section 4 does manually:
restores the latest snapshot into a scratch directory, loads the database into a scratch
database, samples file versions **from the restored database**, finds their bytes **in
the restored tree**, and re-hashes them.

That last detail is the point. Verifying the backup against the *live* database would
prove nothing about whether the backup is self-consistent. A backup is only good if the
metadata and the bytes come back agreeing with each other — either half alone restores
nothing usable.

Both scratch artefacts are destroyed on every exit path, including failure.

Run it by hand any time:

```bash
docker compose ... exec backup bash /usr/local/bin/verify-restore.sh
```

Never-rehearsed shows as a warning on the System page indefinitely, and a drill older
than 90 days warns again. An untested backup is a hypothesis.

---

## Setting up the off-server copy

Without `BACKUP_OFFSITE_TARGET` the backups sit on the same machine as the data they
protect, which defeats the purpose. The System page reports this as a standing warning
and it is the correct thing to fix first.

```env
# Another server over SSH
BACKUP_OFFSITE_TARGET=sftp:backup@nas.internal:/volume1/biotech-drive

# S3-compatible (AWS, MinIO, Cloudflare R2, Backblaze B2)
BACKUP_OFFSITE_TARGET=s3:s3.eu-west-1.amazonaws.com/company-biotech-backups
```

S3-compatible targets also need `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the
backup container's environment. The copy is encrypted before it leaves the host, so the
remote operator never holds readable research data.

---

## Recovery objectives

| | Target | Why |
| --- | --- | --- |
| RPO — how much work can be lost | 24 hours | Daily backup. Shorten it by adding a second cron entry if the research day justifies it. |
| RTO — how long to be back | 2–4 hours | Dominated by copying the file volume back, so it scales with total storage, not with the number of files. |

Measure both during a drill and write down what you actually got. An RTO nobody has
timed is an aspiration.
