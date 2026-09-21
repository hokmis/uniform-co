-- 第二階段 DEMO 測試資料清理；只允許下列四個品號與三張指定單據。
--
-- 這會永久刪除：
--   * REP-20260918071402（SHIPPED 補庫單）
--   * MANUAL-ADD-100-20260918-002（POSTED 盤點單）
--   * MANUAL-ADD-50-20260918-001（POSTED 盤點單）
--   * 四個 DEMO 品號、其期初／測試庫存餘額、庫存流水與供應商品號關聯
--
-- 只有在上述資料全數確認為測試資料時執行。腳本不使用 CASCADE；若發現
-- 其他品號、非指定狀態、修正單、其他業務 FK、非期初／指定測試過帳，或
-- posting 同時包含其他品號，會在任何 DELETE 前失敗並整批回滾。

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

create temp table demo_target_replenishments on commit drop as
select id, request_no, status
from public.replenishment_requests
where request_no = 'REP-20260918071402';
alter table demo_target_replenishments add primary key (id);

create temp table demo_target_stocktakes on commit drop as
select id, stocktake_no, status
from public.stocktakes
where stocktake_no in (
  'MANUAL-ADD-100-20260918-002',
  'MANUAL-ADD-50-20260918-001'
)
order by stocktake_no;
alter table demo_target_stocktakes add primary key (id);

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

  select count(*) into target_count from demo_target_replenishments;
  if target_count <> 1 then
    raise exception using
      errcode = 'P0002',
      message = format('Expected exactly 1 named DEMO replenishment, found %s; no data was changed', target_count);
  end if;
  if exists (select 1 from demo_target_replenishments where status <> 'SHIPPED') then
    raise exception using
      errcode = '23514',
      message = 'Named DEMO replenishment is not SHIPPED; no data was changed';
  end if;

  select count(*) into target_count from demo_target_stocktakes;
  if target_count <> 2 then
    raise exception using
      errcode = 'P0002',
      message = format('Expected exactly 2 named DEMO stocktakes, found %s; no data was changed', target_count);
  end if;
  if exists (select 1 from demo_target_stocktakes where status <> 'POSTED') then
    raise exception using
      errcode = '23514',
      message = 'Named DEMO stocktake is not POSTED; no data was changed';
  end if;

  if not exists (
    select 1
    from public.replenishment_request_lines line_row
    join demo_target_replenishments request_row on request_row.id = line_row.request_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Named DEMO replenishment has no lines; no data was changed';
  end if;

  if not exists (
    select 1
    from public.stocktake_lines line_row
    join demo_target_stocktakes stocktake_row on stocktake_row.id = line_row.stocktake_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Named DEMO stocktakes have no lines; no data was changed';
  end if;
end;
$$;

select 1
from public.uniform_items item_row
join demo_target_items target on target.id = item_row.id
for update;

select 1
from public.replenishment_requests request_row
join demo_target_replenishments target on target.id = request_row.id
for update;

select 1
from public.stocktakes stocktake_row
join demo_target_stocktakes target on target.id = stocktake_row.id
for update;

-- 指定測試單據只能包含四個 DEMO 品號。
do $$
begin
  if exists (
    select 1
    from public.replenishment_request_lines line_row
    join demo_target_replenishments request_row on request_row.id = line_row.request_id
    where not exists (
      select 1 from demo_target_items target where target.id = line_row.item_id
    )
  ) or exists (
    select 1
    from public.stocktake_lines line_row
    join demo_target_stocktakes stocktake_row on stocktake_row.id = line_row.stocktake_id
    where not exists (
      select 1 from demo_target_items target where target.id = line_row.item_id
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Named DEMO documents contain a non-DEMO item; no data was changed';
  end if;

  if exists (
    select 1
    from public.replenishment_request_lines line_row
    join demo_target_items target on target.id = line_row.item_id
    where not exists (
      select 1 from demo_target_replenishments request_row where request_row.id = line_row.request_id
    )
  ) or exists (
    select 1
    from public.stocktake_lines line_row
    join demo_target_items target on target.id = line_row.item_id
    where not exists (
      select 1 from demo_target_stocktakes stocktake_row where stocktake_row.id = line_row.stocktake_id
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'A DEMO item is used by another replenishment or stocktake; no data was changed';
  end if;

  if exists (
    select 1 from public.correction_notes correction_row
    where correction_row.original_replenishment_request_id in (
      select id from demo_target_replenishments
    )
    or correction_row.original_stocktake_id in (
      select id from demo_target_stocktakes
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Named DEMO documents have correction history; no data was changed';
  end if;

  if exists (
    select 1
    from public.warehouse_transfer_correction_lines correction_line
    where correction_line.original_replenishment_request_id in (
      select id from demo_target_replenishments
    )
  ) or exists (
    select 1
    from public.stocktake_correction_lines correction_line
    where correction_line.original_stocktake_id in (
      select id from demo_target_stocktakes
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Named DEMO documents have correction lines; no data was changed';
  end if;
end;
$$;

-- 收集指定單據與四個品號目前所有可清理的 posting。
create temp table demo_target_postings on commit drop as
select posting_row.id as posting_id
from public.inventory_postings posting_row
where (
  posting_row.posting_kind = 'REPLENISHMENT'
  and posting_row.source_entity_id in (select id from demo_target_replenishments)
)
or (
  posting_row.posting_kind = 'STOCKTAKE'
  and posting_row.source_entity_id in (select id from demo_target_stocktakes)
)
or exists (
  select 1
  from public.inventory_ledger_entries ledger_row
  join demo_target_items target on target.id = ledger_row.item_id
  where ledger_row.posting_id = posting_row.id
);
alter table demo_target_postings add primary key (posting_id);

do $$
begin
  if exists (
    select 1
    from public.inventory_ledger_entries ledger_row
    join demo_target_items target on target.id = ledger_row.item_id
    join public.inventory_postings posting_row on posting_row.id = ledger_row.posting_id
    where not (
      posting_row.posting_kind = 'OPENING'
      or (
        posting_row.posting_kind = 'REPLENISHMENT'
        and posting_row.source_entity_id in (select id from demo_target_replenishments)
      )
      or (
        posting_row.posting_kind = 'STOCKTAKE'
        and posting_row.source_entity_id in (select id from demo_target_stocktakes)
      )
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'A DEMO item has an unrelated inventory posting; no data was changed';
  end if;

  if exists (
    select 1
    from public.inventory_ledger_entries ledger_row
    join demo_target_postings target_posting on target_posting.posting_id = ledger_row.posting_id
    where not exists (
      select 1 from demo_target_items target where target.id = ledger_row.item_id
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'A target posting also contains another item; no data was changed';
  end if;

  if exists (
    select 1
    from public.inventory_ledger_entries ledger_row
    join demo_target_items target on target.id = ledger_row.item_id
    join public.inventory_postings posting_row on posting_row.id = ledger_row.posting_id
    where posting_row.posting_kind = 'OPENING'
      and ledger_row.movement_kind <> 'OPENING_BALANCE'
  ) then
    raise exception using
      errcode = '23514',
      message = 'A DEMO opening posting has a non-opening movement; no data was changed';
  end if;

  if exists (
    select 1
    from public.system_cutover_state cutover_row
    where cutover_row.opening_posting_id in (select posting_id from demo_target_postings)
  ) then
    raise exception using
      errcode = '23514',
      message = 'A target posting is the system cutover opening posting; no data was changed';
  end if;
end;
$$;

-- 任何非庫存流水的 posting FK 都代表仍有正式證據／更正引用，不允許清除。
create temp table demo_posting_fk_blockers (
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
    join pg_catalog.pg_class child_table on child_table.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace child_namespace on child_namespace.oid = child_table.relnamespace
    cross join lateral unnest(constraint_row.conkey)
      with ordinality as key_position(attnum, ordinality)
    join pg_catalog.pg_attribute child_column
      on child_column.attrelid = child_table.oid
     and child_column.attnum = key_position.attnum
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.inventory_postings'::regclass
      and child_namespace.nspname = 'public'
    group by child_namespace.nspname, child_table.relname, constraint_row.conname
  loop
    if fk.child_table = 'inventory_ledger_entries' then
      continue;
    end if;

    if cardinality(fk.child_columns) <> 1
       or fk.child_columns[1] <> 'posting_id' then
      insert into demo_posting_fk_blockers(table_schema, table_name, constraint_name, matched_rows)
      values (fk.child_schema, fk.child_table, fk.constraint_name, -1);
      continue;
    end if;

    execute format(
      'select count(*) from %I.%I child join pg_temp.demo_target_postings target on child.%I = target.posting_id',
      fk.child_schema,
      fk.child_table,
      fk.child_columns[1]
    ) into matched_rows;

    if matched_rows > 0 then
      insert into demo_posting_fk_blockers(table_schema, table_name, constraint_name, matched_rows)
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
  from demo_posting_fk_blockers;

  if blocker_detail is not null then
    raise exception using
      errcode = '23514',
      message = 'Target postings still have evidence references; no data was changed',
      detail = blocker_detail;
  end if;
end;
$$;

-- 盤點／補庫已 POSTED／SHIPPED，正常 trigger 會保護不可變歷史；本檔案
-- 是經明確授權的 DEMO 一次性清理，僅暫停四張指定資料表的既有保護 trigger，
-- 並在同一交易內刪除後立即恢復。任何錯誤都會回滾 trigger 狀態與資料。
alter table public.replenishment_requests disable trigger replenishment_requests_immutable_guard;
alter table public.replenishment_request_lines disable trigger replenishment_lines_immutable_guard;
alter table public.stocktakes disable trigger stocktakes_immutable_guard;
alter table public.stocktake_lines disable trigger stocktake_lines_immutable_guard;

delete from public.replenishment_request_lines line_row
using demo_target_replenishments target
where line_row.request_id = target.id;

delete from public.replenishment_requests request_row
using demo_target_replenishments target
where request_row.id = target.id;

delete from public.stocktake_lines line_row
using demo_target_stocktakes target
where line_row.stocktake_id = target.id;

delete from public.stocktakes stocktake_row
using demo_target_stocktakes target
where stocktake_row.id = target.id;

alter table public.replenishment_request_lines enable trigger replenishment_lines_immutable_guard;
alter table public.replenishment_requests enable trigger replenishment_requests_immutable_guard;
alter table public.stocktake_lines enable trigger stocktake_lines_immutable_guard;
alter table public.stocktakes enable trigger stocktakes_immutable_guard;

delete from public.inventory_ledger_entries ledger_row
using demo_target_postings target
where ledger_row.posting_id = target.posting_id;

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
using demo_target_postings target
where posting_row.id = target.posting_id;

delete from public.uniform_items item_row
using demo_target_items target
where item_row.id = target.id;

do $$
begin
  if exists (select 1 from public.uniform_items item_row join demo_target_items target on target.id = item_row.id)
     or exists (select 1 from public.replenishment_requests request_row join demo_target_replenishments target on target.id = request_row.id)
     or exists (select 1 from public.stocktakes stocktake_row join demo_target_stocktakes target on target.id = stocktake_row.id)
     or exists (select 1 from public.inventory_postings posting_row join demo_target_postings target on target.posting_id = posting_row.id) then
    raise exception using
      errcode = 'P0001',
      message = 'DEMO test cleanup did not remove all target rows; transaction rolled back';
  end if;
end;
$$;

select
  'AFTER_DELETE' as phase,
  (select count(*) from public.uniform_items item_row join demo_target_items target on target.id = item_row.id) as item_count,
  (select count(*) from public.replenishment_requests request_row join demo_target_replenishments target on target.id = request_row.id) as replenishment_count,
  (select count(*) from public.stocktakes stocktake_row join demo_target_stocktakes target on target.id = stocktake_row.id) as stocktake_count,
  (select count(*) from public.inventory_balances b join demo_target_items target on target.id = b.item_id) as balance_count,
  (select count(*) from public.inventory_ledger_entries l join demo_target_items target on target.id = l.item_id) as ledger_count,
  (select count(*) from public.supplier_uniform_items s join demo_target_items target on target.id = s.item_id) as supplier_link_count;

commit;
