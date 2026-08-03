#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Restore drill — proves the backups are restorable, automatically, on a schedule.
#
# "We take backups" and "we can restore" are different claims, and only the second one
# matters. This script makes the second one true by actually doing it:
#
#   1. Restore the latest snapshot into a scratch directory.
#   2. Restore the MongoDB dump into a scratch database (never the live one).
#   3. Sample file versions from the RESTORED database, find their bytes in the RESTORED
#      tree, and re-hash them. A backup is only good if the metadata and the bytes came
#      back agreeing with each other — either half alone restores nothing usable.
#   4. Write last-restore-drill.json for the admin dashboard.
#   5. Delete the scratch database and directory.
#
# Nothing it touches is live. The live database is never named, the live storage volume
# is mounted read-only, and the scratch database is dropped at the end.
#
# Exit codes:  0 drill passed   1 drill failed   2 could not run
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

: "${MONGODB_URI:?MONGODB_URI is required}"
: "${BACKUP_ROOT:=/backups}"
: "${BACKUP_ENCRYPTION_PASSWORD:?BACKUP_ENCRYPTION_PASSWORD is required}"
: "${BACKUP_STATUS_DIR:=/status}"
: "${RESTORE_DRILL_SAMPLE:=25}"

RESTIC_REPO="${BACKUP_ROOT}/restic"
SCRATCH="${BACKUP_ROOT}/drill-$(date -u +%Y%m%d%H%M%S)-$$"
DRILL_DB="biotech_drive_restore_drill_$$"
STATUS_FILE="${BACKUP_STATUS_DIR}/last-restore-drill.json"
export RESTIC_PASSWORD="${BACKUP_ENCRYPTION_PASSWORD}"

# Point mongosh/mongorestore at the scratch database, never at the configured one.
DRILL_URI="$(printf '%s' "${MONGODB_URI}" | sed -E "s#(mongodb(\+srv)?://[^/]+)/[^?]*#\1/${DRILL_DB}#")"

FILES_VERIFIED=0
DOCS_RESTORED=0
DETAIL=""

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

write_status() {
  local ok="$1" detail="$2" tmp
  mkdir -p "${BACKUP_STATUS_DIR}"
  tmp="$(mktemp "${BACKUP_STATUS_DIR}/.last-restore-drill.XXXXXX")"
  cat >"${tmp}" <<EOF
{
  "schemaVersion": 1,
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "ok": ${ok},
  "filesVerified": ${FILES_VERIFIED},
  "documentsRestored": ${DOCS_RESTORED},
  "detail": "$(printf '%s' "${detail}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-400)"
}
EOF
  chmod 0644 "${tmp}"
  mv -f "${tmp}" "${STATUS_FILE}"
}

cleanup() {
  # Always, on every exit path. A drill that leaves a scratch database behind will
  # eventually be the drill that fills the disk it was meant to protect.
  mongosh "${DRILL_URI}" --quiet --eval 'db.dropDatabase()' >/dev/null 2>&1 || true
  rm -rf "${SCRATCH}" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  log "DRILL FAILED: $1"
  write_status "false" "$1"
  exit 1
}

command -v jq >/dev/null 2>&1 || { log "jq is required"; write_status "false" "jq not installed in the backup container"; exit 2; }

log "Restore drill starting (scratch database ${DRILL_DB})"
mkdir -p "${SCRATCH}" || { log "Cannot create scratch directory"; exit 2; }

# ── 1. restore the snapshots ─────────────────────────────────────────────────
# Files and the database are two separate snapshots, so each is selected by its tag.
# Plain `restore latest` would silently pick whichever ran last — the mongo one — and
# the drill would then "pass" having verified no files at all.
log "Restoring the latest file snapshot into ${SCRATCH}"
restic -r "${RESTIC_REPO}" restore latest --tag files --target "${SCRATCH}" \
  || fail "restic could not restore the latest file snapshot"

STORAGE_TREE="${SCRATCH}/data/storage"
[ -d "${STORAGE_TREE}" ] || fail "The restored snapshot contains no /data/storage tree"

# ── 2. restore the database into a scratch database ──────────────────────────
log "Restoring the latest database snapshot"
restic -r "${RESTIC_REPO}" restore latest --tag mongo --target "${SCRATCH}" \
  || fail "restic could not restore the latest database snapshot"

ARCHIVE="$(find "${SCRATCH}" -name 'mongo-*.gz' -type f 2>/dev/null | sort | tail -n1)"
[ -n "${ARCHIVE}" ] || fail "The restored snapshot contains no MongoDB archive"

log "Restoring ${ARCHIVE} into ${DRILL_DB}"
mongorestore --uri="${DRILL_URI}" --gzip --archive="${ARCHIVE}" \
  --nsFrom='*.*' --nsTo="${DRILL_DB}.*" --drop >/dev/null 2>&1 \
  || fail "mongorestore could not load the archive"

DOCS_RESTORED="$(mongosh "${DRILL_URI}" --quiet --eval '
  db.getCollectionNames().reduce((total, name) => total + db.getCollection(name).countDocuments(), 0)
' 2>/dev/null | tr -dc '0-9')"
DOCS_RESTORED="${DOCS_RESTORED:-0}"
[ "${DOCS_RESTORED}" -gt 0 ] || fail "The restored database is empty"
log "Restored ${DOCS_RESTORED} documents"

# ── 3. do the metadata and the bytes still agree? ────────────────────────────
# Sampled from the restored database, resolved against the restored tree. Nothing here
# consults the live system, so a drill can be run on a completely separate machine.
SAMPLE="$(mongosh "${DRILL_URI}" --quiet --eval "
  JSON.stringify(db.fileversions.aggregate([
    { \$match: { storageArea: { \$in: ['originals', 'versions', 'archives'] } } },
    { \$sample: { size: ${RESTORE_DRILL_SAMPLE} } },
    { \$project: { _id: 0, storageKey: 1, storageArea: 1, checksumSha256: 1, fileSize: 1 } }
  ]).toArray())
" 2>/dev/null)"

if [ -z "${SAMPLE}" ] || [ "${SAMPLE}" = "[]" ]; then
  # A brand new deployment genuinely has no versions yet. That is a pass with a caveat,
  # not a failure — but it must say so rather than quietly reporting success.
  DETAIL="Database restored (${DOCS_RESTORED} documents). No stored file versions existed to verify."
  log "${DETAIL}"
  write_status "true" "${DETAIL}"
  log "Restore drill passed"
  exit 0
fi

MISMATCHES=0
while IFS=$'\t' read -r key area checksum size; do
  [ -z "${key}" ] && continue
  path="${STORAGE_TREE}/${area}/${key}"

  if [ ! -f "${path}" ]; then
    log "MISSING: ${area}/${key}"
    MISMATCHES=$((MISMATCHES + 1))
    continue
  fi

  actual_size="$(wc -c <"${path}" | tr -d ' ')"
  actual_hash="$(sha256sum "${path}" | cut -d' ' -f1)"

  if [ "${actual_hash}" != "${checksum}" ]; then
    log "CHECKSUM MISMATCH: ${area}/${key}"
    MISMATCHES=$((MISMATCHES + 1))
  elif [ "${actual_size}" != "${size}" ]; then
    log "SIZE MISMATCH: ${area}/${key} (recorded ${size}, restored ${actual_size})"
    MISMATCHES=$((MISMATCHES + 1))
  else
    FILES_VERIFIED=$((FILES_VERIFIED + 1))
  fi
done < <(printf '%s' "${SAMPLE}" | jq -r '.[] | [.storageKey, .storageArea, .checksumSha256, .fileSize] | @tsv')

if [ "${MISMATCHES}" -gt 0 ]; then
  fail "${MISMATCHES} of $((MISMATCHES + FILES_VERIFIED)) sampled objects were missing or corrupted in the backup"
fi

DETAIL="Restored ${DOCS_RESTORED} documents and verified ${FILES_VERIFIED} stored objects against their recorded checksums."
log "${DETAIL}"
write_status "true" "${DETAIL}"
log "Restore drill passed"
exit 0
