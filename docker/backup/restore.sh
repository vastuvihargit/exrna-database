#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Restore from an encrypted backup.
#
# This script is the one that runs on the worst day, so it is built to be boring:
#
#   • It does NOTHING without --confirm. The default is a dry run that prints the plan.
#   • It NEVER writes over live storage. Files are restored into a staging directory and
#     the operator moves them, consciously, after looking. An automated restore that
#     overwrites good data with older data is a second outage on top of the first.
#   • It refuses to drop a database that has documents in it unless --drop is passed as
#     well, because "restore into the wrong environment" is the classic way to turn a
#     recoverable incident into an unrecoverable one.
#
# Usage:
#   restore.sh --list                          # what snapshots exist
#   restore.sh --what=all                      # dry run — prints the plan, changes nothing
#   restore.sh --what=files --confirm
#   restore.sh --what=mongo --confirm --drop
#   restore.sh --what=all --snapshot=a1b2c3d4 --confirm
#
# Full procedure, including how to bring the application back up:
#   docs/operations/backup-and-restore.md
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${BACKUP_ROOT:=/backups}"
: "${BACKUP_ENCRYPTION_PASSWORD:?BACKUP_ENCRYPTION_PASSWORD is required}"
: "${RESTORE_STAGING_DIR:=/backups/restore-staging}"

RESTIC_REPO="${BACKUP_ROOT}/restic"
export RESTIC_PASSWORD="${BACKUP_ENCRYPTION_PASSWORD}"

SNAPSHOT="latest"
WHAT="all"
CONFIRM="false"
DROP="false"
LIST="false"
MONGO_TARGET_URI="${MONGODB_URI:-}"

for arg in "$@"; do
  case "${arg}" in
    --snapshot=*) SNAPSHOT="${arg#*=}" ;;
    --what=*)     WHAT="${arg#*=}" ;;
    --target-uri=*) MONGO_TARGET_URI="${arg#*=}" ;;
    --staging=*)  RESTORE_STAGING_DIR="${arg#*=}" ;;
    --confirm)    CONFIRM="true" ;;
    --drop)       DROP="true" ;;
    --list)       LIST="true" ;;
    -h|--help)    sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

case "${WHAT}" in
  files|mongo|all) ;;
  *) echo "--what must be one of: files, mongo, all" >&2; exit 2 ;;
esac

if [ "${LIST}" = "true" ]; then
  log "Snapshots in ${RESTIC_REPO}"
  restic -r "${RESTIC_REPO}" snapshots
  exit 0
fi

FILES_TARGET="${RESTORE_STAGING_DIR}/files-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
MONGO_TARGET="${RESTORE_STAGING_DIR}/mongo-$(date -u +%Y-%m-%dT%H-%M-%SZ)"

echo
echo "──────────────────────────── RESTORE PLAN ────────────────────────────"
echo "  repository     ${RESTIC_REPO}"
echo "  snapshot       ${SNAPSHOT}"
echo "  restoring      ${WHAT}"
[ "${WHAT}" != "mongo" ] && echo "  files      →   ${FILES_TARGET}   (staging, not live storage)"
[ "${WHAT}" != "files" ] && echo "  database   →   ${MONGO_TARGET_URI:-<MONGODB_URI unset>}"
[ "${WHAT}" != "files" ] && echo "  drop first     ${DROP}"
echo "──────────────────────────────────────────────────────────────────────"
echo

if [ "${CONFIRM}" != "true" ]; then
  log "DRY RUN — nothing has been changed. Re-run with --confirm to execute."
  exit 0
fi

mkdir -p "${RESTORE_STAGING_DIR}"

# Files and the database are backed up as two separate snapshots. When the operator
# asked for "latest" that is ambiguous, so each half is selected by its tag; an explicit
# snapshot id is used exactly as given.
TAG_FILES=""
TAG_MONGO=""
if [ "${SNAPSHOT}" = "latest" ]; then
  TAG_FILES="--tag files"
  TAG_MONGO="--tag mongo"
fi

if [ "${WHAT}" = "files" ] || [ "${WHAT}" = "all" ]; then
  log "Restoring file storage into staging"
  mkdir -p "${FILES_TARGET}"
  # shellcheck disable=SC2086
  restic -r "${RESTIC_REPO}" restore "${SNAPSHOT}" ${TAG_FILES} \
    --target "${FILES_TARGET}"
  log "Files restored to ${FILES_TARGET}"
  log "They have NOT been put back into live storage. Review, then move them yourself."
fi

if [ "${WHAT}" = "mongo" ] || [ "${WHAT}" = "all" ]; then
  if [ -z "${MONGO_TARGET_URI}" ]; then
    echo "Refusing to restore the database: no target URI. Pass --target-uri=..." >&2
    exit 2
  fi

  log "Restoring the MongoDB dump into staging"
  mkdir -p "${MONGO_TARGET}"
  # shellcheck disable=SC2086
  restic -r "${RESTIC_REPO}" restore "${SNAPSHOT}" ${TAG_MONGO} \
    --target "${MONGO_TARGET}"

  ARCHIVE="$(find "${MONGO_TARGET}" -name 'mongo-*.gz' -type f | sort | tail -n1)"
  if [ -z "${ARCHIVE}" ]; then
    echo "No mongo-*.gz archive found in the restored snapshot." >&2
    exit 1
  fi
  log "Using archive ${ARCHIVE}"

  # The guard rail: restoring on top of a populated database is almost always a mistake
  # made under pressure. Make the operator say so out loud.
  EXISTING="$(mongosh "${MONGO_TARGET_URI}" --quiet --eval \
    'db.getCollectionNames().length' 2>/dev/null || echo 0)"

  if [ "${EXISTING}" != "0" ] && [ "${DROP}" != "true" ]; then
    echo >&2
    echo "The target database already has ${EXISTING} collections." >&2
    echo "Refusing to restore over live data. Re-run with --drop if that is really what you want." >&2
    exit 3
  fi

  DROP_FLAG=""
  [ "${DROP}" = "true" ] && DROP_FLAG="--drop"

  log "Running mongorestore ${DROP_FLAG}"
  # shellcheck disable=SC2086
  mongorestore --uri="${MONGO_TARGET_URI}" --gzip --archive="${ARCHIVE}" ${DROP_FLAG}
  log "Database restored"
fi

echo
log "Restore finished. Before starting the application:"
log "  1. Move the staged files into the storage volume (see the runbook)."
log "  2. Run: npm run verify:storage    — proves the metadata and the bytes agree."
log "  3. Only then bring the app container back up."
