#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL to a protected database connection string}"
: "${BACKUP_ROOT:?Set BACKUP_ROOT to an offsite staging directory outside the repository}"
run_id="${BACKUP_RUN_ID:?Use the same BACKUP_RUN_ID as export-db.sh}"
command -v pg_dump >/dev/null || { echo "pg_dump is required" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
node scripts/backup/validate-run-id.mjs "${run_id}" >/dev/null
run_dir="$(cd -- "${BACKUP_ROOT}/${run_id}" && pwd)"
if [[ -e "${run_dir}/auth-data.sql" || -e "${run_dir}/auth-metadata.json" ]]; then
  echo "Refusing to overwrite existing Auth backup for generation: ${run_id}" >&2
  exit 1
fi
if [[ ! -f "${run_dir}/application.dump" || ! -f "${run_dir}/database-metadata.json" || ! -f "${run_dir}/tool-versions.txt" || ! -f "${run_dir}/manifest.json" ]]; then
  echo "Database backup phase is incomplete for generation: ${run_id}" >&2
  exit 1
fi
node scripts/backup/verify-manifest.mjs "${run_dir}" >/dev/null

# Auth is data-only: migrations own application schema, while Auth UUIDs and
# identity rows must be preserved exactly for actor foreign keys on restore.
pg_dump --data-only --schema=auth --no-owner --no-privileges --file "${run_dir}/auth-data.sql" "${SUPABASE_DB_URL}"
psql --no-psqlrc --tuples-only --no-align "${SUPABASE_DB_URL}" \
  --command "do \$\$ begin if to_regclass('auth.mfa_factors') is null then raise exception 'auth.mfa_factors is required for a complete Auth backup'; end if; end \$\$; select json_build_object('users',(select count(*) from auth.users),'identities',(select count(*) from auth.identities),'mfa_factors',(select count(*) from auth.mfa_factors))" \
  > "${run_dir}/auth-metadata.json"
node scripts/backup/create-manifest.mjs "${run_dir}"
printf 'auth_backup_run=%s\nmanifest=%s\n' "${run_id}" "${run_dir}/manifest.json"
