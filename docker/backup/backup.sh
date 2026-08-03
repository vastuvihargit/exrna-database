#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Backup job — MongoDB dump + encrypted incremental file backup, pushed off-server.
#
# Run by cron inside the backup container (see docker/backup/crontab). The file volume
# is mounted READ-ONLY, so this script can never damage the data it protects.
#
# Rule from docs/phase-0/09: the only copy must never live on the same disk as the app.
#
# The last act of every run — success or failure — is to write last-backup.json where
# the application can read it. A backup system that fails silently is indistinguishable
# from one that was never installed, right up until somebody needs it.
#
# Exit codes:
#   0  backup completed (see .offsite / .verified in the status file for caveats)
#   1  backup failed — the status file records the stage that failed
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${MONGODB_URI:?MONGODB_URI is required}"
: "${BACKUP_ROOT:=/backups}"
: "${BACKUP_RETENTION_DAYS:=30}"
: "${BACKUP_ENCRYPTION_PASSWORD:?BACKUP_ENCRYPTION_PASSWORD is required}"

# Where the application reads status from. Writable here, read-only there.
: "${BACKUP_STATUS_DIR:=/status}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
STARTED_EPOCH="$(date -u +%s)"
MONGO_DIR="${BACKUP_ROOT}/mongo"
RESTIC_REPO="${BACKUP_ROOT}/restic"
STATUS_FILE="${BACKUP_STATUS_DIR}/last-backup.json"
export RESTIC_PASSWORD="${BACKUP_ENCRYPTION_PASSWORD}"

STAGE="starting"
OFFSITE="false"
VERIFIED="false"
SNAPSHOT_ID=""

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Writes the status file atomically: the application may read it at any moment, and a
# half-written JSON document would be reported as "never ran" — a false alarm at 3am.
write_status() {
  local ok="$1" detail="$2"
  local finished_epoch duration tmp
  finished_epoch="$(date -u +%s)"
  duration=$((finished_epoch - STARTED_EPOCH))
  mkdir -p "${BACKUP_STATUS_DIR}"
  tmp="$(mktemp "${BACKUP_STATUS_DIR}/.last-backup.XXXXXX")"

  cat >"${tmp}" <<EOF
{
  "schemaVersion": 1,
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "ok": ${ok},
  "stage": "${STAGE}",
  "offsite": ${OFFSITE},
  "verified": ${VERIFIED},
  "snapshotId": "${SNAPSHOT_ID}",
  "durationSeconds": ${duration},
  "detail": "$(printf '%s' "${detail}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-400)"
}
EOF

  chmod 0644 "${tmp}"
  mv -f "${tmp}" "${STATUS_FILE}"
}

# Any non-zero exit anywhere below lands here. Reporting the stage matters more than the
# message: "failed at offsite_copy" and "failed at mongodump" are different emergencies.
on_failure() {
  local code=$?
  log "FAILED during stage '${STAGE}' (exit ${code})"
  write_status "false" "Backup failed during stage '${STAGE}' with exit code ${code}."
  exit 1
}
trap on_failure ERR

log "Backup starting (stamp ${STAMP})"

STAGE="mongodump"
mkdir -p "${MONGO_DIR}"
log "Dumping MongoDB"
mongodump --uri="${MONGODB_URI}" --gzip --archive="${MONGO_DIR}/mongo-${STAMP}.gz"

STAGE="repository_init"
log "Initialising restic repository if needed"
restic -r "${RESTIC_REPO}" snapshots >/dev/null 2>&1 || restic -r "${RESTIC_REPO}" init

STAGE="backup_files"
log "Backing up file storage (encrypted, deduplicated)"
# Quarantine and temporary are excluded deliberately: unverified bytes and half-finished
# uploads are not data anybody wants restored, and quarantine may hold live malware.
restic -r "${RESTIC_REPO}" backup /data/storage \
  --exclude /data/storage/quarantine \
  --exclude /data/storage/temporary \
  --tag files --tag "${STAMP}"

STAGE="backup_mongo"
log "Backing up the MongoDB dump into the encrypted repository"
restic -r "${RESTIC_REPO}" backup "${MONGO_DIR}" --tag mongo --tag "${STAMP}"

SNAPSHOT_ID="$(restic -r "${RESTIC_REPO}" snapshots --latest 1 --json 2>/dev/null \
  | sed -n 's/.*"short_id":"\([^"]*\)".*/\1/p' | head -n1 || true)"

STAGE="retention"
log "Applying retention policy"
restic -r "${RESTIC_REPO}" forget \
  --keep-daily "${BACKUP_RETENTION_DAYS}" --keep-weekly 8 --keep-monthly 12 --prune

STAGE="verify"
log "Verifying repository integrity"
# Reads 5% of the actual pack data back, not just the index. Cheap enough nightly, and
# it is the difference between "the job exited zero" and "the bytes are still there".
restic -r "${RESTIC_REPO}" check --read-data-subset=5%
VERIFIED="true"

STAGE="offsite_copy"
if [ -n "${BACKUP_OFFSITE_TARGET:-}" ]; then
  log "Syncing to off-server target"
  restic -r "${RESTIC_REPO}" copy --repo2 "${BACKUP_OFFSITE_TARGET}"
  OFFSITE="true"
else
  log "WARNING: BACKUP_OFFSITE_TARGET is not set — backups are on-server only" >&2
fi

STAGE="cleanup"
# Local plain dumps are redundant once inside the encrypted repository, and an
# unencrypted dump of the whole database sitting on disk is its own problem.
find "${MONGO_DIR}" -name 'mongo-*.gz' -mtime +2 -delete

STAGE="completed"
trap - ERR

if [ "${OFFSITE}" = "true" ]; then
  write_status "true" "Backed up, verified and copied off-server."
else
  write_status "true" "Backed up and verified, but BACKUP_OFFSITE_TARGET is not configured."
fi

log "Backup completed in $(($(date -u +%s) - STARTED_EPOCH))s"
