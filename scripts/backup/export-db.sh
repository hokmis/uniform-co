#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL to a protected database connection string}"
: "${BACKUP_ROOT:?Set BACKUP_ROOT to an offsite staging directory outside the repository}"
run_id="${BACKUP_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
command -v pg_dump >/dev/null || { echo "pg_dump is required" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
node scripts/backup/validate-run-id.mjs "${run_id}" >/dev/null
mkdir -p -- "${BACKUP_ROOT}"
if [[ -e "${BACKUP_ROOT}/${run_id}" ]]; then
  echo "Refusing to reuse backup generation: ${run_id}" >&2
  exit 1
fi
run_dir="$(mkdir -- "${BACKUP_ROOT}/${run_id}" && cd -- "${BACKUP_ROOT}/${run_id}" && pwd)"
{
  pg_dump --version
  psql --version
  node --version
} > "${run_dir}/tool-versions.txt"

pg_dump --format=custom --no-owner --no-privileges \
  --schema=public --schema=private \
  --file "${run_dir}/application.dump" "${SUPABASE_DB_URL}"
psql --no-psqlrc --tuples-only --no-align "${SUPABASE_DB_URL}" \
  --command "select json_build_object('database_size_bytes',pg_database_size(current_database()),'migration_head',coalesce((select max(version) from supabase_migrations.schema_migrations),''),'application_counts',json_build_object('app_accounts',(select count(*) from public.app_accounts),'employees',(select count(*) from public.employees),'inventory_balances',(select count(*) from public.inventory_balances),'inventory_ledger_entries',(select count(*) from public.inventory_ledger_entries),'operation_commands',(select count(*) from public.operation_commands),'document_artifacts',(select count(*) from public.document_artifacts),'erp_export_artifacts',(select count(*) from public.erp_export_artifacts),'import_batches',(select count(*) from public.import_batches)))" \
  > "${run_dir}/database-metadata.json"
node scripts/backup/create-manifest.mjs "${run_dir}"
printf 'backup_run=%s\nmanifest=%s\n' "${run_id}" "${run_dir}/manifest.json"
