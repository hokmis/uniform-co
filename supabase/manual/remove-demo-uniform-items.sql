-- 一次性 DEMO 示範資料清理；只允許下列四個固定品號。
--
-- 重要：這會永久刪除這四個品號的庫存餘額、庫存流水、孤立的
-- inventory_postings、供應商品號關聯與商品主檔。請只在已確認這些
-- 是示範資料的 project 執行，不要改成 LIKE 'DEMO-%'，也不要在正式
-- 業務資料上重複使用。
--
-- 本腳本不使用 CASCADE。若四個品號仍被人資需求、發貨、補庫、盤點、
-- 採購、退貨、ERP 或其他業務資料引用，會在任何 DELETE 前失敗並回滾。

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create temp table demo_target_items on commit drop as
select id, item_code
from public.uniform_items
where item_code in (
  'DEMO-SHIRT-M',
  'DEMO-SHIRT-L',
  'DEMO-PANTS-M',
  'DEMO-PANTS-L'
)
order by item_code;

alter table demo_target_items add primary key (id);

do $$
declare
  target_count integer;
begin
  select count(*) into target_count from demo_target_items;
  if target_count <> 4 then
    raise exception using
      errcode = 'P0002',
      message = format('Expected exactly 4 DEMO uniform items, found %s; no data was changed', target_count);
  end if;
end;
$$;

-- 先鎖定四筆商品，避免清理期間同時建立新的業務引用。
select 1
from public.uniform_items item_row
join demo_target_items target on target.id = item_row.id
for update;

-- 除了本腳本明確處理的庫存／供應商品號關聯外，任何直接 FK 引用都
-- 視為業務歷史，立即停止。這個檢查會隨未來新增的 item_id FK 自動涵蓋。
create temp table demo_fk_blockers (
  table_schema text not null,
  table_name text not null,
  constraint_name text not null,
  matched_rows bigint not null
) on commit drop;

do $$
declare
  fk record;
  matched_rows bigint;
begin
  for fk in
    select
      child_namespace.nspname as child_schema,
      child_table.relname as child_table,
      constraint_row.conname as constraint_name,
      array_agg(child_column.attname order by key_position.ordinality) as child_columns
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class child_table
      on child_table.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace child_namespace
      on child_namespace.oid = child_table.relnamespace
    cross join lateral unnest(constraint_row.conkey)
      with ordinality as key_position(attnum, ordinality)
    join pg_catalog.pg_attribute child_column
      on child_column.attrelid = child_table.oid
     and child_column.attnum = key_position.attnum
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.uniform_items'::regclass
      and child_namespace.nspname = 'public'
    group by child_namespace.nspname, child_table.relname, constraint_row.conname
  loop
    if fk.child_table in (
      'supplier_uniform_items',
      'inventory_balances',
      'inventory_item_locks',
      'inventory_ledger_entries'
    ) then
      continue;
    end if;

    if cardinality(fk.child_columns) <> 1
       or fk.child_columns[1] <> 'item_id' then
      insert into demo_fk_blockers(table_schema, table_name, constraint_name, matched_rows)
      values (fk.child_schema, fk.child_table, fk.constraint_name, -1);
      continue;
    end if;

    execute format(
      'select count(*) from %I.%I child join pg_temp.demo_target_items target on child.%I = target.id',
      fk.child_schema,
      fk.child_table,
      fk.child_columns[1]
    ) into matched_rows;

    if matched_rows > 0 then
      insert into demo_fk_blockers(table_schema, table_name, constraint_name, matched_rows)
      values (fk.child_schema, fk.child_table, fk.constraint_name, matched_rows);
    end if;
  end loop;
end;
$$;

do $$
declare
  blocker_detail text;
begin
  select string_agg(
    format('%s.%s [%s] rows=%s', table_schema, table_name, constraint_name, matched_rows),
    '; ' order by table_schema, table_name, constraint_name
  ) into blocker_detail
  from demo_fk_blockers;

  if blocker_detail is not null then
    raise exception using
      errcode = '23514',
      message = 'DEMO uniform items still have business references; no data was changed',
      detail = blocker_detail;
  end if;
end;
$$;

-- 一個 posting 若同時包含其他品號，不能只刪其中幾行，否則會破壞
-- posting 的完整性；這種情況同樣 fail-closed。
create temp table demo_target_postings on commit drop as
select distinct ledger_row.posting_id
from public.inventory_ledger_entries ledger_row
join demo_target_items target on target.id = ledger_row.item_id;

do $$
begin
  if exists (
    select 1
    from public.inventory_ledger_entries ledger_row
    join demo_target_items target on target.id = ledger_row.item_id
    join public.inventory_postings posting_row on posting_row.id = ledger_row.posting_id
    where posting_row.posting_kind <> 'OPENING'
       or ledger_row.movement_kind <> 'OPENING_BALANCE'
  ) then
    raise exception using
      errcode = '23514',
      message = 'A DEMO item has non-opening inventory history; no data was changed',
      detail = 'Only demo OPENING / OPENING_BALANCE rows are eligible for this cleanup';
  end if;

  if exists (
    select 1
    from demo_target_postings target_posting
    join public.inventory_ledger_entries ledger_row
      on ledger_row.posting_id = target_posting.posting_id
    where not exists (
      select 1
      from demo_target_items target
      where target.id = ledger_row.item_id
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'A DEMO inventory posting also contains another item; no data was changed';
  end if;
end;
$$;

select
  'BEFORE_DELETE' as phase,
  (select count(*) from demo_target_items) as item_count,
  (select count(*) from public.inventory_balances b join demo_target_items t on t.id = b.item_id) as balance_count,
  (select count(*) from public.inventory_ledger_entries l join demo_target_items t on t.id = l.item_id) as ledger_count,
  (select count(*) from public.inventory_item_locks l join demo_target_items t on t.id = l.item_id) as item_lock_count,
  (select count(*) from public.supplier_uniform_items s join demo_target_items t on t.id = s.item_id) as supplier_link_count;

delete from public.inventory_ledger_entries ledger_row
using demo_target_items target
where ledger_row.item_id = target.id;

delete from public.inventory_balances balance_row
using demo_target_items target
where balance_row.item_id = target.id;

delete from public.inventory_item_locks lock_row
using demo_target_items target
where lock_row.item_id = target.id;

delete from public.supplier_uniform_items supplier_link
using demo_target_items target
where supplier_link.item_id = target.id;

delete from public.inventory_postings posting_row
using demo_target_postings target_posting
where posting_row.id = target_posting.posting_id
  and not exists (
    select 1
    from public.inventory_ledger_entries remaining_ledger
    where remaining_ledger.posting_id = posting_row.id
  );

delete from public.uniform_items item_row
using demo_target_items target
where item_row.id = target.id;

do $$
begin
  if exists (
    select 1
    from public.uniform_items item_row
    join demo_target_items target on target.id = item_row.id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'DEMO uniform item cleanup did not remove all target items; transaction rolled back';
  end if;
end;
$$;

select
  'AFTER_DELETE' as phase,
  (select count(*) from public.uniform_items item_row join demo_target_items target on target.id = item_row.id) as item_count,
  (select count(*) from public.inventory_balances b join demo_target_items t on t.id = b.item_id) as balance_count,
  (select count(*) from public.inventory_ledger_entries l join demo_target_items t on t.id = l.item_id) as ledger_count,
  (select count(*) from public.supplier_uniform_items s join demo_target_items t on t.id = s.item_id) as supplier_link_count;

commit;
