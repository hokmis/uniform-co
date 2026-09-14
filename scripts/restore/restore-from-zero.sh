#!/usr/bin/env bash
set -euo pipefail

: "${BACKUP_RUN_DIR:?Set BACKUP_RUN_DIR to one verified backup generation}"
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to a new empty Supabase database}"
: "${CONFIRM_RESTORE:?Set CONFIRM_RESTORE=YES to acknowledge a destructive restore target}"
: "${BACKUP_DECRYPT_COMMAND:?Set BACKUP_DECRYPT_COMMAND to the protected two-person decrypt command}"
[[ "${CONFIRM_RESTORE}" == "YES" ]] || { echo "Refusing restore without CONFIRM_RESTORE=YES" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
node scripts/backup/verify-manifest.mjs "${BACKUP_RUN_DIR}" --for-offsite
psql --no-psqlrc --set ON_ERROR_STOP=1 "${TARGET_DATABASE_URL}" --file scripts/restore/assert-empty-target.sql
bash -c "${BACKUP_DECRYPT_COMMAND}" -- "${BACKUP_RUN_DIR}"
[[ -f "${BACKUP_RUN_DIR}/manifest.json" && -f "${BACKUP_RUN_DIR}/application.dump" && -f "${BACKUP_RUN_DIR}/auth-data.sql" ]] || { echo "Backup generation is incomplete after protected decryption" >&2; exit 1; }
# The encrypted generation manifest describes ciphertext. Rebuild a local
# protected manifest after the two-person decrypt so restore inputs are hashed.
node scripts/backup/create-manifest.mjs "${BACKUP_RUN_DIR}"
node scripts/backup/verify-manifest.mjs "${BACKUP_RUN_DIR}"
node scripts/restore/verify-metadata.mjs "${BACKUP_RUN_DIR}" --validate-only

pg_restore --no-owner --no-privileges --exit-on-error --dbname "${TARGET_DATABASE_URL}" "${BACKUP_RUN_DIR}/application.dump"
psql --no-psqlrc --set ON_ERROR_STOP=1 "${TARGET_DATABASE_URL}" --file "${BACKUP_RUN_DIR}/auth-data.sql"
if [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_ROLE_KEY:-}" && -f "${BACKUP_RUN_DIR}/storage-manifest.json" ]]; then
  node scripts/restore/restore-storage.mjs
else
  echo "Storage restore not run: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and storage-manifest.json are required" >&2
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 "${TARGET_DATABASE_URL}" --file scripts/restore/verify.sql
node scripts/restore/verify-metadata.mjs "${BACKUP_RUN_DIR}"
printf 'restore_verified=%s\n' "${BACKUP_RUN_DIR}"
