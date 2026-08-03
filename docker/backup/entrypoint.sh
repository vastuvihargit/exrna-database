#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Backup container entrypoint.
#
# Installs the tooling, captures the environment for cron (which inherits none), puts
# the schedule in place, and hands over to crond in the foreground so Docker supervises
# it properly.
#
# One deliberate behaviour: if there is no backup status file yet, this writes one
# saying so. Otherwise a freshly deployed system shows "no backups" identically to one
# whose backup container has been crash-looping for a week — and those need different
# responses.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

: "${BACKUP_STATUS_DIR:=/status}"

echo "[entrypoint] Installing backup tooling"
apk add --no-cache restic mongodb-tools bash tzdata jq coreutils >/dev/null

# Cron jobs start with an empty environment. Capture what the container was given so
# run-job.sh can source it. Written 0600 — it holds the backup encryption password.
echo "[entrypoint] Capturing environment for cron"
{
  echo "# Generated at container start. Do not edit."
  for var in MONGODB_URI BACKUP_ROOT BACKUP_RETENTION_DAYS BACKUP_ENCRYPTION_PASSWORD \
             BACKUP_OFFSITE_TARGET BACKUP_STATUS_DIR RESTORE_DRILL_SAMPLE TZ; do
    eval "value=\${${var}:-}"
    [ -n "${value}" ] && echo "export ${var}='${value}'"
  done
} >/etc/backup-job.env
chmod 0600 /etc/backup-job.env

echo "[entrypoint] Installing schedule"
mkdir -p /etc/crontabs "${BACKUP_STATUS_DIR}"
cp /usr/local/etc/backup-crontab /etc/crontabs/root
chmod 0600 /etc/crontabs/root

# Seed a status file so "never configured" and "stopped working" are distinguishable.
if [ ! -f "${BACKUP_STATUS_DIR}/last-backup.json" ]; then
  echo "[entrypoint] No backup has run yet — seeding the status file"
  cat >"${BACKUP_STATUS_DIR}/last-backup.json" <<EOF
{
  "schemaVersion": 1,
  "finishedAt": null,
  "ok": null,
  "stage": "never_run",
  "offsite": false,
  "verified": false,
  "detail": "The backup container started at $(date -u +%Y-%m-%dT%H:%M:%SZ) but no scheduled backup has completed yet."
}
EOF
  chmod 0644 "${BACKUP_STATUS_DIR}/last-backup.json"
fi

# Run one immediately on request, so a new deployment is protected within minutes
# rather than at 02:15 tomorrow.
if [ "${BACKUP_RUN_ON_START:-false}" = "true" ]; then
  echo "[entrypoint] BACKUP_RUN_ON_START=true — running an initial backup"
  sh /usr/local/bin/run-job.sh backup || echo "[entrypoint] Initial backup failed; the schedule will retry" >&2
fi

echo "[entrypoint] Starting cron"
exec crond -f -l 8
