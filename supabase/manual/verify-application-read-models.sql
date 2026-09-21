-- READ ONLY. Verify application read models and workflow RPCs without changing schema or data.
begin transaction read only;

with
required_source_relations(name) as (values
    ('app_accounts'),
    ('audit_events'),
    ('correction_notes'),
    ('departments'),
    ('employees'),
    ('hr_issue_lines'),
    ('hr_request_items'),
    ('hr_requests'),
    ('import_batches'),
    ('institutions'),
    ('inventory_balances'),
    ('inventory_item_locks'),
    ('inventory_reservations'),
    ('issue_correction_lines'),
    ('operation_commands'),
    ('purchase_order_lines'),
    ('purchase_orders'),
    ('purchase_receipt_correction_lines'),
    ('purchase_receipt_lines'),
    ('purchase_receipts'),
    ('replenishment_request_lines'),
    ('replenishment_requests'),
    ('return_correction_lines'),
    ('return_lines'),
    ('return_notes'),
    ('seasonal_approval_lines'),
    ('seasonal_approval_submissions'),
    ('seasonal_approvals'),
    ('seasonal_campaign_employees'),
    ('seasonal_campaign_items'),
    ('seasonal_campaigns'),
    ('seasonal_demand_lines'),
    ('seasonal_procurement_lines'),
    ('stocktake_lines'),
    ('stocktakes'),
    ('supplier_uniform_items'),
    ('suppliers'),
    ('uniform_items'),
    ('user_roles'),
    ('warehouse_shipment_lines'),
    ('warehouse_shipments'),
    ('warehouse_transfer_correction_lines'),
    ('warehouses'),
    ('v_item_availability'),
    ('v_hr_request_item_totals'),
    ('v_pending_warehouse_shipments'),
    ('v_purchase_order_receipt_progress')
),
required_base_functions(signature) as (values
    ('private.current_account_id()'),
    ('public.post_warehouse_shipment(uuid,text,text)'),
    ('public.create_seasonal_campaign(text,text,text,date,date,timestamptz,timestamptz,text,text)'),
    ('public.set_seasonal_campaign_scope(uuid,uuid[],uuid[],text,text)'),
    ('public.create_purchase_receipt_draft(text,uuid,bigint,bigint,bigint,text,date,text,text)'),
    ('public.post_purchase_receipt(uuid,text,text)'),
    ('public.create_stocktake_draft(text,uuid,text,jsonb,text,text)'),
    ('public.update_stocktake_draft(uuid,text,jsonb,boolean,text,text)'),
    ('public.post_stocktake(uuid,text,text)'),
    ('public.create_hr_request_draft(text,date,text,jsonb,jsonb,text,text)'),
    ('public.update_hr_request_draft(uuid,date,text,jsonb,jsonb,text,text)'),
    ('public.submit_hr_request(uuid,text,text)'),
    ('public.apply_master_import(text,text,jsonb,text,text)'),
    ('public.create_replenishment_draft(text,text,jsonb,text,text)'),
    ('public.update_replenishment_request_draft(uuid,text,jsonb,text,text)'),
    ('public.submit_replenishment_request(uuid,text,text)'),
    ('public.create_return_correction_draft(text,uuid,bigint,text,text,text,text)'),
    ('public.post_return_correction(uuid,text,text)'),
    ('public.create_hr_issue_correction_draft(text,uuid,bigint,text,text,text,text)'),
    ('public.post_hr_issue_correction(uuid,text,text)'),
    ('public.create_warehouse_transfer_correction_draft(text,text,uuid,bigint,text,text,text,text)'),
    ('public.post_warehouse_transfer_correction(uuid,text,text)'),
    ('public.create_purchase_receipt_correction_draft(text,uuid,bigint,bigint,bigint,text,text,text,text)'),
    ('public.post_purchase_receipt_correction(uuid,text,text)'),
    ('public.create_stocktake_correction_draft(text,uuid,bigint,text,text,text,text)'),
    ('public.post_stocktake_correction(uuid,text,text)'),
    ('public.create_return_note_draft(text,uuid,date,text,text,text,jsonb,text,text)'),
    ('public.post_return_note(uuid,text,text)')
),
required_views(name) as (values
    ('v_account_directory'),
    ('v_correction_history'),
    ('v_employee_directory'),
    ('v_hr_issue_correction_sources'),
    ('v_hr_request_employee_options'),
    ('v_hr_request_history'),
    ('v_hr_request_history_detail'),
    ('v_hr_request_item_options'),
    ('v_overview_core'),
    ('v_purchase_receipt_correction_sources'),
    ('v_replenishment_shipment_lines'),
    ('v_return_correction_sources'),
    ('v_seasonal_approval_queue'),
    ('v_seasonal_demand_workspace'),
    ('v_seasonal_procurement_queue'),
    ('v_stocktake_correction_sources'),
    ('v_warehouse_shipment_lines'),
    ('v_warehouse_shipment_queue'),
    ('v_warehouse_transfer_correction_sources')
),
required_indexes(name) as (values
    ('inventory_balances_item_warehouse_read_idx'),
    ('hr_issue_lines_request_item_read_idx'),
    ('purchase_receipt_lines_order_line_read_idx'),
    ('purchase_receipt_correction_lines_source_read_idx'),
    ('audit_events_occurred_at_read_idx'),
    ('purchase_orders_open_po_no_idx'),
    ('purchase_receipts_posted_receipt_no_idx'),
    ('hr_requests_shipped_distribution_date_idx'),
    ('return_notes_posted_id_idx'),
    ('correction_notes_purchase_receipt_source_idx'),
    ('correction_notes_return_note_source_idx'),
    ('correction_notes_hr_request_source_idx'),
    ('correction_notes_stocktake_source_idx'),
    ('correction_notes_warehouse_shipment_source_idx'),
    ('correction_notes_replenishment_source_idx'),
    ('hr_requests_created_at_idx'),
    ('inventory_reservations_source_status_idx'),
    ('app_accounts_email_snapshot_idx'),
    ('return_correction_lines_source_read_idx'),
    ('issue_correction_lines_source_read_idx'),
    ('warehouse_transfer_correction_lines_shipment_source_read_idx'),
    ('warehouse_transfer_correction_lines_replenishment_source_read_idx'),
    ('stocktake_correction_lines_source_read_idx'),
    ('import_batches_work_queue_idx')
),
required_functions(signature) as (values
    ('recapture_stocktake_draft(uuid,text,text,text)'),
    ('post_warehouse_shipment_with_lines(uuid,jsonb,text,text)'),
    ('create_seasonal_campaign_with_scope(text,text,text,date,date,timestamptz,timestamptz,uuid[],uuid[],text,text,text,text)'),
    ('complete_purchase_receipt(text,uuid,bigint,bigint,bigint,text,date,text,text,text,text)'),
    ('complete_stocktake(uuid,text,uuid,text,jsonb,text,text,text,text,text,text)'),
    ('submit_hr_request_with_lines(uuid,text,date,text,jsonb,jsonb,text,text,text,text,text,text)'),
    ('submit_replenishment_request_with_lines(uuid,text,text,jsonb,text,text,text,text,text,text)'),
    ('complete_return_correction(text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_hr_issue_correction(text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_warehouse_transfer_correction(text,text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_purchase_receipt_correction(text,uuid,bigint,bigint,bigint,text,text,text,text,text,text)'),
    ('complete_stocktake_correction(text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_return_note(text,uuid,date,text,text,text,jsonb,text,text,text,text)')
),
redundant_indexes(name) as (values
    ('operation_commands_operation_idempotency_conflict_idx'),
    ('institutions_code_conflict_idx'),
    ('departments_institution_code_conflict_idx'),
    ('uniform_items_item_code_conflict_idx'),
    ('suppliers_supplier_code_conflict_idx'),
    ('supplier_uniform_items_supplier_item_conflict_idx')
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
