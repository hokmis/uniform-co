\set ON_ERROR_STOP on
do $$
begin
  if exists (select 1 from public.inventory_balances where on_hand_quantity < 0) then
    raise exception 'negative inventory balance found';
  end if;
  if exists (select 1 from public.inventory_reservations where quantity <= 0) then
    raise exception 'invalid reservation quantity found';
  end if;
  if exists (select 1 from public.document_artifacts where status = 'READY' and is_current group by family_id having count(*) > 1) then
    raise exception 'multiple current PDF artifacts found';
  end if;
  if exists (select 1 from public.erp_export_artifacts where status = 'READY' and is_current group by batch_id having count(*) > 1) then
    raise exception 'multiple current ERP artifacts found';
  end if;
  if exists (select 1 from public.erp_export_source_links group by issue_line_id having issue_line_id is not null and count(*) > 1) then
    raise exception 'duplicate ERP issue source link found';
  end if;
end
$$;
select 'inventory_balances' as check_name, count(*) as rows from public.inventory_balances
union all select 'inventory_ledger_entries', count(*) from public.inventory_ledger_entries
union all select 'operation_commands', count(*) from public.operation_commands;
