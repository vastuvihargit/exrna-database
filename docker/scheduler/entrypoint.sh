#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Scheduler container entrypoint.
#
# Captures the environment for cron (which inherits none), installs the schedule and
# hands over to crond in the foreground.
#
# This container never listens on a port and never serves a request. It exists so that
# maintenance which must happen on a timer — health monitoring, integrity sweeps, trash
# retention — happens whether or not anybody is logged in.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

echo "[scheduler] Capturing environment for cron"
# Every variable the jobs need, quoted so values containing spaces survive. 0600
# because MONGODB_URI and the secrets are in here.
#
# `GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY` is deliberately **not** in this list, while
# `..._PRIVATE_KEY_FILE` is. The inline form is a development convenience; copying a PEM
# through `env` and a `sed` that wraps values in single quotes is fragile, and it would
# write a second copy of the key to disk here. The scheduler reads the same mounted secret
# the application does, which is one copy, owned by the orchestrator.
{
  echo "# Generated at container start. Do not edit."
  env | grep -E '^(NODE_ENV|MONGODB_URI|MONGODB_DATABASE|APP_URL|APP_NAME|LOG_LEVEL|AUTH_SECRET|SESSION_SECRET|COMPANY_EMAIL_DOMAINS|ALLOW_AUTO_PROVISIONING|LOCAL_STORAGE_ROOT|TEMP_UPLOAD_ROOT|QUARANTINE_ROOT|PREVIEW_ROOT|EXPORT_ROOT|BACKUP_ROOT|MAX_UPLOAD_SIZE_MB|MIN_FREE_DISK_GB|UPLOAD_CHUNK_SIZE_MB|DEFAULT_USER_STORAGE_QUOTA_GB|DEFAULT_DEPARTMENT_STORAGE_QUOTA_GB|TRASH_RETENTION_DAYS|INCOMPLETE_UPLOAD_RETENTION_HOURS|EXPORT_RETENTION_HOURS|SESSION_IDLE_TIMEOUT_MINUTES|SESSION_ABSOLUTE_TIMEOUT_MINUTES|MALWARE_SCAN_ENABLED|MALWARE_SCAN_FAIL_CLOSED|CLAMAV_HOST|CLAMAV_PORT|CLAMAV_TIMEOUT_MS|ALERT_WEBHOOK_URL|TZ|GOOGLE_DRIVE_STORAGE_ENABLED|DEFAULT_STORAGE_PROVIDER|GOOGLE_WORKSPACE_DOMAIN|GOOGLE_SHARED_DRIVE_ID|GOOGLE_DRIVE_ROOT_FOLDER_ID|GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL|GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY_FILE|GOOGLE_DRIVE_UPLOAD_CHUNK_MB|GOOGLE_DRIVE_MAX_CONCURRENT_TRANSFERS|GOOGLE_DRIVE_REQUEST_TIMEOUT_MS|UPLOAD_DRIVE_SYNC_THRESHOLD_MB|LOCAL_COPY_RETENTION_DAYS|DELETE_LOCAL_AFTER_MIGRATION|DRIVE_SYNC_INTERVAL_MINUTES)=' \
    | sed "s/^\([A-Z_]*\)=\(.*\)$/export \1='\2'/"
} >/etc/scheduler.env
chmod 0600 /etc/scheduler.env

# One wrapper for every job: loads the environment, names the job in the log, and
# preserves the exit code so a failing sweep is visible in `docker logs`.
cat >/usr/local/bin/run.sh <<'WRAPPER'
#!/bin/sh
set -u
. /etc/scheduler.env
JOB="${1:?usage: run.sh <npm-script>}"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] job '${JOB}' starting"
cd /app
npm run --silent "${JOB}"
CODE=$?
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] job '${JOB}' finished with exit code ${CODE}"
exit ${CODE}
WRAPPER
chmod 0755 /usr/local/bin/run.sh

echo "[scheduler] Installing schedule"
mkdir -p /etc/crontabs
cp /usr/local/etc/scheduler-crontab /etc/crontabs/root
chmod 0600 /etc/crontabs/root

echo "[scheduler] Starting cron"
exec crond -f -l 8
