#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Cron wrapper.
#
# BusyBox cron runs jobs with an almost empty environment — no MONGODB_URI, no
# BACKUP_ENCRYPTION_PASSWORD. Every scheduled job therefore goes through here, which
# loads the environment the entrypoint captured at container start.
#
# It also does the one thing a cron job must never skip: make failure visible. Output
# goes to the container log (which the compose file rotates) and the exit code is
# preserved, so a job that dies is not silently swallowed by cron's default mail-nowhere
# behaviour.
#
#   run-job.sh backup | verify-restore | full-check
# ─────────────────────────────────────────────────────────────────────────────
set -eu

ENV_FILE=/etc/backup-job.env
[ -f "${ENV_FILE}" ] && . "${ENV_FILE}"

JOB="${1:?usage: run-job.sh backup|verify-restore|full-check}"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "───────────────────────────────────────────────────────────────"
echo "[${STARTED}] job '${JOB}' starting"

# `set -e` is suspended around the job itself: a failing job must still reach the
# "finished with exit code N" line. A cron job that dies without saying so is how a
# backup schedule stops working for a month without anybody noticing.
CODE=0
set +e
case "${JOB}" in
  # Invoked through `bash` explicitly rather than relying on the shebang: the scripts
  # are read-only bind mounts, so the container cannot chmod +x them if the host's
  # filesystem did not carry the execute bit across (it does not, on Windows).
  backup)
    bash /usr/local/bin/backup.sh
    CODE=$?
    ;;
  verify-restore)
    bash /usr/local/bin/verify-restore.sh
    CODE=$?
    ;;
  full-check)
    # Not routed through a status file: the nightly backup's own verify covers the
    # dashboard. This is the deeper, slower sweep, and its result belongs in the log.
    RESTIC_PASSWORD="${BACKUP_ENCRYPTION_PASSWORD}" \
      restic -r "${BACKUP_ROOT:-/backups}/restic" check --read-data
    CODE=$?
    ;;
  *)
    echo "Unknown job: ${JOB}" >&2
    exit 2
    ;;
esac
set -e

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] job '${JOB}' finished with exit code ${CODE}"
exit ${CODE}
