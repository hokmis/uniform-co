import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputPath = path.join(repositoryRoot, "supabase/manual/restore-application-read-models.sql");
const verificationOutputPath = path.join(repositoryRoot, "supabase/manual/verify-application-read-models.sql");

export const migrationFiles = [
  "0099_hr_request_history_view.sql",
  "0100_reporting_join_indexes.sql",
  "0101_transaction_read_indexes.sql",
  "0102_correction_history_read_indexes.sql",
  "0103_warehouse_shipment_queue_view.sql",
  "0104_hr_request_option_views.sql",
  "0105_warehouse_transfer_correction_source_view.sql",
  "0106_stocktake_correction_source_view.sql",
  "0107_receipt_return_correction_source_views.sql",
  "0108_hr_issue_correction_source_view.sql",
  "0109_seasonal_procurement_queue_view.sql",
  "0110_seasonal_demand_workspace_view.sql",
  "0111_seasonal_approval_queue_view.sql",
  "0112_hr_request_history_detail_view.sql",
  "0113_stocktake_server_recapture.sql",
  "0114_warehouse_post_with_lines.sql",
  "0115_sso_account_email_read_index.sql",
  "0116_correction_history_view.sql",
  "0117_replenishment_shipment_lines_view.sql",
  "0118_overview_core_view.sql",
  "0119_warehouse_shipment_lines_view.sql",
  "0120_employee_directory_view.sql",
  "0121_account_directory_view.sql",
  "0122_remove_redundant_master_conflict_indexes.sql",
  "0123_correction_history_line_indexes.sql",
  "0124_durable_import_work_queue_index.sql",
  "0125_atomic_seasonal_campaign_setup.sql",
  "0126_atomic_purchase_receipt_completion.sql",
  "0127_atomic_stocktake_completion.sql",
  "0128_atomic_hr_request_submission.sql",
  "0129_overview_core_account_binding.sql",
  "0130_atomic_replenishment_submission.sql",
  "0131_atomic_correction_completion.sql",
  "0132_atomic_return_completion.sql",
];

export const expectedViews = [
  "v_account_directory",
  "v_correction_history",
  "v_employee_directory",
  "v_hr_issue_correction_sources",
  "v_hr_request_employee_options",
  "v_hr_request_history",
  "v_hr_request_history_detail",
  "v_hr_request_item_options",
  "v_overview_core",
  "v_purchase_receipt_correction_sources",
  "v_replenishment_shipment_lines",
  "v_return_correction_sources",
  "v_seasonal_approval_queue",
  "v_seasonal_demand_workspace",
  "v_seasonal_procurement_queue",
  "v_stocktake_correction_sources",
  "v_warehouse_shipment_lines",
  "v_warehouse_shipment_queue",
  "v_warehouse_transfer_correction_sources",
];

export const expectedIndexes = [
  "inventory_balances_item_warehouse_read_idx",
  "hr_issue_lines_request_item_read_idx",
  "purchase_receipt_lines_order_line_read_idx",
  "purchase_receipt_correction_lines_source_read_idx",
  "audit_events_occurred_at_read_idx",
  "purchase_orders_open_po_no_idx",
  "purchase_receipts_posted_receipt_no_idx",
  "hr_requests_shipped_distribution_date_idx",
  "return_notes_posted_id_idx",
  "correction_notes_purchase_receipt_source_idx",
  "correction_notes_return_note_source_idx",
  "correction_notes_hr_request_source_idx",
  "correction_notes_stocktake_source_idx",
  "correction_notes_warehouse_shipment_source_idx",
  "correction_notes_replenishment_source_idx",
  "hr_requests_created_at_idx",
  "inventory_reservations_source_status_idx",
  "app_accounts_email_snapshot_idx",
  "return_correction_lines_source_read_idx",
  "issue_correction_lines_source_read_idx",
  "warehouse_transfer_correction_lines_shipment_source_read_idx",
  "warehouse_transfer_correction_lines_replenishment_source_read_idx",
  "stocktake_correction_lines_source_read_idx",
  "import_batches_work_queue_idx",
];

export const expectedFunctions = [
  "recapture_stocktake_draft(uuid,text,text,text)",
  "post_warehouse_shipment_with_lines(uuid,jsonb,text,text)",
  "create_seasonal_campaign_with_scope(text,text,text,date,date,timestamptz,timestamptz,uuid[],uuid[],text,text,text,text)",
  "complete_purchase_receipt(text,uuid,bigint,bigint,bigint,text,date,text,text,text,text)",
  "complete_stocktake(uuid,text,uuid,text,jsonb,text,text,text,text,text,text)",
  "submit_hr_request_with_lines(uuid,text,date,text,jsonb,jsonb,text,text,text,text,text,text)",
  "submit_replenishment_request_with_lines(uuid,text,text,jsonb,text,text,text,text,text,text)",
  "complete_return_correction(text,uuid,bigint,text,text,text,text,text,text)",
  "complete_hr_issue_correction(text,uuid,bigint,text,text,text,text,text,text)",
  "complete_warehouse_transfer_correction(text,text,uuid,bigint,text,text,text,text,text,text)",
  "complete_purchase_receipt_correction(text,uuid,bigint,bigint,bigint,text,text,text,text,text,text)",
  "complete_stocktake_correction(text,uuid,bigint,text,text,text,text,text,text)",
  "complete_return_note(text,uuid,date,text,text,text,jsonb,text,text,text,text)",
];

export const expectedSourceRelations = [
  "app_accounts",
  "audit_events",
  "correction_notes",
  "departments",
  "employees",
  "hr_issue_lines",
  "hr_request_items",
  "hr_requests",
  "import_batches",
  "institutions",
  "inventory_balances",
  "inventory_item_locks",
  "inventory_reservations",
  "issue_correction_lines",
  "operation_commands",
  "purchase_order_lines",
  "purchase_orders",
  "purchase_receipt_correction_lines",
  "purchase_receipt_lines",
  "purchase_receipts",
  "replenishment_request_lines",
  "replenishment_requests",
  "return_correction_lines",
  "return_lines",
  "return_notes",
  "seasonal_approval_lines",
  "seasonal_approval_submissions",
  "seasonal_approvals",
  "seasonal_campaign_employees",
  "seasonal_campaign_items",
  "seasonal_campaigns",
  "seasonal_demand_lines",
  "seasonal_procurement_lines",
  "stocktake_lines",
  "stocktakes",
  "supplier_uniform_items",
  "suppliers",
  "uniform_items",
  "user_roles",
  "warehouse_shipment_lines",
  "warehouse_shipments",
  "warehouse_transfer_correction_lines",
  "warehouses",
];

export const expectedSourceViews = [
  "v_item_availability",
  "v_hr_request_item_totals",
  "v_pending_warehouse_shipments",
  "v_purchase_order_receipt_progress",
];

export const expectedBaseFunctions = [
  "private.current_account_id()",
  "public.post_warehouse_shipment(uuid,text,text)",
  "public.create_seasonal_campaign(text,text,text,date,date,timestamptz,timestamptz,text,text)",
  "public.set_seasonal_campaign_scope(uuid,uuid[],uuid[],text,text)",
  "public.create_purchase_receipt_draft(text,uuid,bigint,bigint,bigint,text,date,text,text)",
  "public.post_purchase_receipt(uuid,text,text)",
  "public.create_stocktake_draft(text,uuid,text,jsonb,text,text)",
  "public.update_stocktake_draft(uuid,text,jsonb,boolean,text,text)",
  "public.post_stocktake(uuid,text,text)",
  "public.create_hr_request_draft(text,date,text,jsonb,jsonb,text,text)",
  "public.update_hr_request_draft(uuid,date,text,jsonb,jsonb,text,text)",
  "public.submit_hr_request(uuid,text,text)",
  "public.apply_master_import(text,text,jsonb,text,text)",
  "public.create_replenishment_draft(text,text,jsonb,text,text)",
  "public.update_replenishment_request_draft(uuid,text,jsonb,text,text)",
  "public.submit_replenishment_request(uuid,text,text)",
  "public.create_return_correction_draft(text,uuid,bigint,text,text,text,text)",
  "public.post_return_correction(uuid,text,text)",
  "public.create_hr_issue_correction_draft(text,uuid,bigint,text,text,text,text)",
  "public.post_hr_issue_correction(uuid,text,text)",
  "public.create_warehouse_transfer_correction_draft(text,text,uuid,bigint,text,text,text,text)",
  "public.post_warehouse_transfer_correction(uuid,text,text)",
  "public.create_purchase_receipt_correction_draft(text,uuid,bigint,bigint,bigint,text,text,text,text)",
  "public.post_purchase_receipt_correction(uuid,text,text)",
  "public.create_stocktake_correction_draft(text,uuid,bigint,text,text,text,text)",
  "public.post_stocktake_correction(uuid,text,text)",
  "public.create_return_note_draft(text,uuid,date,text,text,text,jsonb,text,text)",
  "public.post_return_note(uuid,text,text)",
];

const redundantIndexes = [
  "operation_commands_operation_idempotency_conflict_idx",
  "institutions_code_conflict_idx",
  "departments_institution_code_conflict_idx",
  "uniform_items_item_code_conflict_idx",
  "suppliers_supplier_code_conflict_idx",
  "supplier_uniform_items_supplier_item_conflict_idx",
];

function valuesList(values, sqlExpression = (value) => `'${value}'`) {
  return values.map((value) => `    (${sqlExpression(value)})`).join(",\n");
}

function buildPreflight() {
  return `-- Verify that this database has the base schema these forward migrations depend on.
do $read_model_preflight$
declare
  missing_relations text;
  missing_functions text;
begin
  select string_agg(required.name, ', ' order by required.name)
    into missing_relations
  from (values
${valuesList([...expectedSourceRelations, ...expectedSourceViews])}
  ) as required(name)
  where to_regclass('public.' || required.name) is null;

  if missing_relations is not null then
    raise exception using
      errcode = '55000',
      message = 'Read-model repair prerequisites are missing: ' || missing_relations;
  end if;

  select string_agg(required.signature, ', ' order by required.signature)
    into missing_functions
  from (values
${valuesList(expectedBaseFunctions, (value) => `'${value}'`)}
  ) as required(signature)
  where to_regprocedure(required.signature) is null;

  if missing_functions is not null then
    raise exception using
      errcode = '55000',
      message = 'Read-model repair RPC prerequisites are missing: ' || missing_functions;
  end if;
end;
$read_model_preflight$;
`;
}

function buildPostflight() {
  return `-- Fail the transaction unless the published read models, indexes, and RPCs are ready.
do $read_model_postflight$
declare
  incomplete_views text;
  incomplete_indexes text;
  incomplete_functions text;
  remaining_redundant_indexes text;
  overview_identity_binding_ready boolean;
begin
  select string_agg(required.name, ', ' order by required.name)
    into incomplete_views
  from (values
${valuesList(expectedViews)}
  ) as required(name)
  left join pg_class relation_row
    on relation_row.relnamespace = 'public'::regnamespace
   and relation_row.relname = required.name
  where relation_row.oid is null
     or not coalesce(relation_row.reloptions @> array['security_invoker=true'], false)
     or not coalesce(has_table_privilege('authenticated', relation_row.oid, 'SELECT'), false);

  if incomplete_views is not null then
    raise exception using
      errcode = '55000',
      message = 'Read-model view verification failed: ' || incomplete_views;
  end if;

  select exists (
    select 1
    from pg_attribute attribute_row
    where attribute_row.attrelid = 'public.v_overview_core'::regclass
      and attribute_row.attname = 'account_id'
      and not attribute_row.attisdropped
  ) into overview_identity_binding_ready;

  if not overview_identity_binding_ready then
    raise exception using
      errcode = '55000',
      message = 'Overview account snapshot binding is missing.';
  end if;

  select string_agg(required.name, ', ' order by required.name)
    into incomplete_indexes
  from (values
${valuesList(expectedIndexes)}
  ) as required(name)
  left join pg_class index_row
    on index_row.relnamespace = 'public'::regnamespace
   and index_row.relname = required.name
  left join pg_index index_definition
    on index_definition.indexrelid = index_row.oid
  where index_row.oid is null
     or not coalesce(index_definition.indisvalid, false)
     or not coalesce(index_definition.indisready, false);

  if incomplete_indexes is not null then
    raise exception using
      errcode = '55000',
      message = 'Read-path index verification failed: ' || incomplete_indexes;
  end if;

  select string_agg(required.signature, ', ' order by required.signature)
    into incomplete_functions
  from (values
${valuesList(expectedFunctions)}
  ) as required(signature)
  where to_regprocedure('public.' || required.signature) is null
     or not coalesce(
       has_function_privilege('authenticated', to_regprocedure('public.' || required.signature), 'EXECUTE'),
       false
     );

  if incomplete_functions is not null then
    raise exception using
      errcode = '55000',
      message = 'Atomic-workflow RPC verification failed: ' || incomplete_functions;
  end if;

  select string_agg(required.name, ', ' order by required.name)
    into remaining_redundant_indexes
  from (values
${valuesList(redundantIndexes)}
  ) as required(name)
  join pg_class index_row
    on index_row.relnamespace = 'public'::regnamespace
   and index_row.relname = required.name;

  if remaining_redundant_indexes is not null then
    raise exception using
      errcode = '55000',
      message = 'Redundant master-data indexes remain: ' || remaining_redundant_indexes;
  end if;
end;
$read_model_postflight$;

select
  (select count(*) from (values
${valuesList(expectedViews)}
  ) as required(name)
   join pg_class relation_row
     on relation_row.relnamespace = 'public'::regnamespace
    and relation_row.relname = required.name) as read_views_ready,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname in (
${expectedIndexes.map((name) => `    '${name}'`).join(",\n")}
  )) as read_indexes_ready,
  (select count(*) from (values
${valuesList(expectedFunctions)}
  ) as required(signature)
   where to_regprocedure('public.' || required.signature) is not null) as optimized_rpcs_ready,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname in (
${redundantIndexes.map((name) => `    '${name}'`).join(",\n")}
  )) as redundant_indexes_remaining;
`;
}

export function buildVerificationSql() {
  return `-- READ ONLY. Verify application read models and workflow RPCs without changing schema or data.
begin transaction read only;

with
required_source_relations(name) as (values
${valuesList([...expectedSourceRelations, ...expectedSourceViews])}
),
required_base_functions(signature) as (values
${valuesList(expectedBaseFunctions)}
),
required_views(name) as (values
${valuesList(expectedViews)}
),
required_indexes(name) as (values
${valuesList(expectedIndexes)}
),
required_functions(signature) as (values
${valuesList(expectedFunctions)}
),
redundant_indexes(name) as (values
${valuesList(redundantIndexes)}
),
source_relation_status as (
  select
    required.name,
    to_regclass('public.' || required.name) is not null as ready
  from required_source_relations required
),
base_function_status as (
  select
    required.signature,
    to_regprocedure(required.signature) is not null as ready
  from required_base_functions required
),
view_status as (
  select
    required.name,
    relation_row.oid is not null
      and relation_row.relkind = 'v'
      and coalesce(relation_row.reloptions @> array['security_invoker=true'], false)
      and coalesce(has_table_privilege('authenticated', relation_row.oid, 'SELECT'), false) as ready
  from required_views required
  left join pg_class relation_row
    on relation_row.relnamespace = 'public'::regnamespace
   and relation_row.relname = required.name
),
index_status as (
  select
    required.name,
    index_row.oid is not null
      and coalesce(index_definition.indisvalid, false)
      and coalesce(index_definition.indisready, false) as ready
  from required_indexes required
  left join pg_class index_row
    on index_row.relnamespace = 'public'::regnamespace
   and index_row.relname = required.name
  left join pg_index index_definition
    on index_definition.indexrelid = index_row.oid
),
function_status as (
  select
    required.signature,
    function_row.oid is not null
      and coalesce(has_function_privilege('authenticated', function_row.oid, 'EXECUTE'), false) as ready
  from required_functions required
  left join lateral (
    select to_regprocedure('public.' || required.signature) as oid
  ) function_row on true
),
redundant_status as (
  select required.name, index_row.oid is not null as exists
  from redundant_indexes required
  left join pg_class index_row
    on index_row.relnamespace = 'public'::regnamespace
   and index_row.relname = required.name
)
select
  (select count(*) from required_source_relations) as expected_source_relations,
  (select count(*) from source_relation_status where ready) as ready_source_relations,
  coalesce((select string_agg(name, ', ' order by name) from source_relation_status where not ready), '') as missing_source_relations,
  (select count(*) from required_base_functions) as expected_base_functions,
  (select count(*) from base_function_status where ready) as ready_base_functions,
  coalesce((select string_agg(signature, ', ' order by signature) from base_function_status where not ready), '') as missing_base_functions,
  (select count(*) from required_views) as expected_views,
  (select count(*) from view_status where ready) as ready_views,
  coalesce((select string_agg(name, ', ' order by name) from view_status where not ready), '') as views_needing_attention,
  (select count(*) from required_indexes) as expected_indexes,
  (select count(*) from index_status where ready) as ready_indexes,
  coalesce((select string_agg(name, ', ' order by name) from index_status where not ready), '') as indexes_needing_attention,
  (select count(*) from required_functions) as expected_rpcs,
  (select count(*) from function_status where ready) as callable_rpcs,
  coalesce((select string_agg(signature, ', ' order by signature) from function_status where not ready), '') as rpcs_needing_attention,
  coalesce((select exists (
    select 1
    from pg_attribute attribute_row
    where attribute_row.attrelid = to_regclass('public.v_overview_core')
      and attribute_row.attname = 'account_id'
      and not attribute_row.attisdropped
  )), false) as overview_snapshot_account_bound,
  (select count(*) from redundant_status where exists) as redundant_indexes_remaining,
  coalesce((select string_agg(name, ', ' order by name) from redundant_status where exists), '') as redundant_indexes_to_review;

commit;
`;
}

function stripMigrationTransactionControls(sql) {
  return sql
    .replace(/^[\t ]*begin[\t ]*;[\t ]*$/gim, "")
    .replace(/^[\t ]*commit[\t ]*;[\t ]*$/gim, "")
    .trim();
}

export async function buildBundle(root = repositoryRoot) {
  const sourceSql = await Promise.all(migrationFiles.map(async (filename) => {
    const filePath = path.join(root, "supabase/migrations", filename);
    const contents = stripMigrationTransactionControls(await readFile(filePath, "utf8"));
    return `-- Source: supabase/migrations/${filename}\n${contents}`;
  }));

  return [
    "-- GENERATED FILE. Do not edit directly.",
    "-- Regenerate with: node scripts/database/generate-production-read-model-sql.mjs",
    "-- Source of truth: the versioned migrations listed below.",
    "-- This transaction changes schema objects only; it does not insert, update, or delete business rows.",
    "-- Migration ledger note: executing in SQL Editor does not reconcile supabase_migrations.schema_migrations.",
    "-- Do not run `supabase db push` until the remote migration history has been reconciled against the actual schema.",
    "",
    "begin;",
    buildPreflight(),
    ...sourceSql,
    buildPostflight(),
    "commit;",
    "",
  ].join("\n\n").trimEnd() + "\n";
}

async function main() {
  const generated = await buildBundle();
  const generatedVerification = buildVerificationSql();
  if (process.argv.includes("--check")) {
    const existing = await readFile(outputPath, "utf8").catch(() => "");
    const existingVerification = await readFile(verificationOutputPath, "utf8").catch(() => "");
    if (existing !== generated || existingVerification !== generatedVerification) {
      console.error("A generated production read-model SQL artifact is out of date. Run the generator without --check.");
      process.exitCode = 1;
      return;
    }
    console.log("The production read-model repair and verification SQL match their migration sources.");
    return;
  }

  await writeFile(outputPath, generated, "utf8");
  await writeFile(verificationOutputPath, generatedVerification, "utf8");
  console.log(`Generated ${path.relative(repositoryRoot, outputPath)} and ${path.relative(repositoryRoot, verificationOutputPath)} from shared migration metadata.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
