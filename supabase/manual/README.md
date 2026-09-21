# Supabase 手動 SQL

本資料夾包含 disposable staging 範例資料、唯讀查核檔，以及明確標示目標環境的維運 SQL。`DEMO-` seed／清理檔只可用在 disposable staging；其他 SQL 請依各節的目標、前置條件與影響說明執行，不要把範例資料檔套用到 production。

若建立耐久匯入批次時出現 `function digest(text, unknown) does not exist`，先執行 `fix-pgcrypto-digest-search-path.sql`；這是已手動套用舊 migration 的資料庫需要的相容性修正。

## SQL Editor 順序

1. `seed-demo-warehouses.sql`
2. `seed-demo-master-data.sql`
3. 重新整理網站後，於「總覽 → 主檔與資料基礎」確認機構、部門、制服品號、供應商匯入狀態。
4. 期初庫存不要直接 INSERT `inventory_balances`；在「倉庫作業 → 庫存管理 → 期初庫存」選擇 `OPENING_BALANCE`，使用 `sample-opening-balances.csv`，由 worker 預覽後再確認發布。

網站的「載入範例」按鈕也會產生同一組 `DEMO-` 資料。套用範例前必須勾選 disposable staging 確認，且仍會經過既有 authenticated RPC、RLS、冪等與稽核流程。

若要清除本次建立的四個示範品號，只有在確認它們仍是示範資料、庫存流水全部為期初庫存，且沒有任何業務引用時，才可在同一個 project 執行 `remove-demo-uniform-items.sql`。它只鎖定 `DEMO-SHIRT-M`、`DEMO-SHIRT-L`、`DEMO-PANTS-M`、`DEMO-PANTS-L`，遇到非期初流水、混合品號 posting 或任何業務外鍵引用會整批回滾；不要把它改成通用的 `DEMO-%` 清理，也不要用在正式業務資料。

若四個品號已被本次確認的三張 DEMO 測試單據引用，才可改執行 `remove-demo-uniform-items-with-test-documents.sql`。它另外限定 `REP-20260918071402`、`MANUAL-ADD-100-20260918-002`、`MANUAL-ADD-50-20260918-001`，只接受 `SHIPPED`／`POSTED` 狀態，會先阻擋修正歷史、其他品號、其他業務 FK、cutover opening posting 與非指定過帳；這是經明確授權的單次測試資料清理，不可拿來清除正式單據。

若指定盤點單是混合正式品號，請改執行 `remove-demo-uniform-items-preserve-real-stocktake.sql`。它只刪四個 DEMO 品號的盤點明細與庫存流水，保留同一 posting 中的正式品號；只有完全由 DEMO 組成的 posting 才會刪除，混合 posting 會保留。原本的整張測試單據清理檔不要套用在混合盤點單上。SQL Editor 沒有登入 JWT 時，這份腳本會在同一個 transaction 內，以 `created_at`／`id` 穩定選擇一個既有的啟用中 `SYSTEM_ADMIN` Auth 綁定帳號作為稽核 actor；若找不到帳號會在任何 DELETE 前停止。

## 本輪模組化管理 SQL

`migrations/0076_inventory_report_export_audit.sql`（或同名 `manual/0076_inventory_report_export_audit.sql`）只需在 `audit_events` 與 `private.append_audit_event` 已存在的資料庫執行一次。它提供庫存管理 CSV 匯出的 metadata 稽核 RPC，不會保存或寫入匯出的資料列。

商品與組織管理清單若要顯示停用資料並支援重新啟用，依序在 Supabase SQL Editor 執行：

1. `migrations/0077_uniform_item_manager_read_inactive.sql`（商品停用品號；若尚未套用）。
2. `manual/0078_organization_manager_read_inactive.sql`（機構／部門停用資料）。

`0078` 只增加 HR 對停用機構與部門的 `SELECT` 權限；既有角色讀取啟用資料的 RLS 不變，新增、修改、停用仍只能經過 `apply_master_import`。

若新增部門時出現 `departments.institution_id` 不可為 null，請在同一個正式 Supabase project 執行 `0087_department_parent_resolution.sql`。它會讓部門表單送出的機構 UUID 與代碼由 RPC 交叉確認，並保留舊匯入檔只帶機構代碼的相容路徑；找不到有效機構時會在寫入前拒絕，不會留下半筆部門資料。執行後重新整理網站再試。

員工主檔管理的單筆新增／修改／停用與稽核匯出，請在上述 migration 都已套用、且 `operation_commands`、`audit_events`、`private.append_audit_event` 已存在後執行：

3. `migrations/0079_employee_master_management.sql`

`0079` 新增 HR-only 的 `save_employee_master` 與 `record_employee_master_export`。新增時若工號已存在會拒絕，修改時必須帶既有員工 UUID 且不可變更工號；停用只更新 `employment_status = 'INACTIVE'`，不會 DELETE 員工或交易歷史。執行前不需要刪除既有資料，成功後重新整理網站即可使用單筆保存與稽核匯出。

若商品保存顯示 `there is no unique or exclusion constraint matching the ON CONFLICT specification`，請先在網站實際連線的 Supabase project 執行 `verify-master-data-conflict-targets.sql`。它是唯讀查核，會分辨 0083 索引是否真的存在、網站呼叫的 `apply_master_import` signature，以及手動 SQL 未寫入 migration ledger 的情況；不要只依 SQL Editor 的 `Success. No rows returned` 判斷已完成。

若查核已確認六組完整唯一索引、`apply_master_import` 版本與相關 trigger 都正常，但登入後的 RPC 仍回傳 PostgreSQL `42P10`，先執行 `rebuild-master-import-rpc.sql`。若仍失敗，再執行 `0084_master_data_constraint_targets.sql`；此檔案會先確認六個原始唯一約束存在，再把 RPC 的六個 conflict target 改為明確的 constraint name，不會新增、修改或刪除主檔資料。兩個檔案都應在正式網站使用的同一 Supabase project 執行，完成後請重新登入網站再試。

## 退回一鍵完成 RPC（0132）

`0132_atomic_return_completion.sql` 是 `supabase/migrations/0132_atomic_return_completion.sql` 的手動執行副本。它只建立受限的 `complete_return_note` transaction wrapper，不直接寫入或刪除退回、庫存、稽核或單據資料；權限、冪等、來源明細驗證、鎖定、庫存流水與稽核仍交由既有 `create_return_note_draft`／`post_return_note` RPC。執行前請確認是在網站目前使用的同一個 Supabase project，且既有函式存在：

```sql
select
  to_regprocedure('public.create_return_note_draft(text,uuid,date,text,text,text,jsonb,text,text)') as create_return_note_draft,
  to_regprocedure('public.post_return_note(uuid,text,text)') as post_return_note;
```

兩欄都非 `NULL` 後，再於 Supabase SQL Editor 執行整份 `0132_atomic_return_completion.sql` 一次。完成後可查核：

```sql
select to_regprocedure('public.complete_return_note(text,uuid,date,text,text,text,jsonb,text,text,text,text)') as complete_return_note;
```

結果應為非 `NULL`。接著重新載入網站，再以 HR／`SYSTEM_ADMIN` 權限測試一筆可撤回的 staging 退回流程；不要用正式業務資料做未核准的測試交易。若尚未套用 SQL，網站仍相容使用舊的兩個 RPC；SQL Editor 成功不代表正式退回交易已驗收。

## 正式工作台讀取路徑修復（2026-09-20 查核）

`restore-application-read-models.sql` 與 `verify-application-read-models.sql` 是由 `scripts/database/generate-production-read-model-sql.mjs` 從版本化 migration `0099`–`0132` 原文產生，不要手動編輯產物。修復檔會先確認底層資料表、基礎 view 與 28 個 workflow 前置函式，再於單一 transaction 安裝 security-invoker views、讀取索引與 13 個既有程式會呼叫的 RPC wrapper；`0122` 會先確認 named constraints 與主檔 RPC 定義，再移除六個冗餘索引；`0129` 會恢復 overview 的帳號綁定欄位，postflight 會確認 `v_overview_core.account_id` 存在。SQL 本身不新增、修改或刪除業務資料；交易失敗時所有 DDL 一併回滾。CI 會執行 generator Node tests，並在修改來源 migration 後以 `node scripts/database/generate-production-read-model-sql.mjs --check` 驗證產物同步。

先執行 `verify-application-read-models.sql` 做唯讀盤點。此檔只有 `BEGIN TRANSACTION READ ONLY`、catalog SELECT 與 COMMIT，不會改 schema、資料或 migration ledger；它會列出修復前置條件與缺漏的 view／index／RPC 名稱。修復 SQL 執行後，再執行同一份檔案驗收，避免只憑 `Success` 或 migration ledger 判斷成功。

若已登入 Supabase CLI 且 repository 已 link 到要查核的 project，可在 repository 根目錄執行：

```powershell
npx supabase db query --linked --file supabase/manual/verify-application-read-models.sql --output-format json
```

此命令只執行唯讀 verifier；執行修復檔仍須先通過 staging 與正式環境維運核准。

2026-09-20 對目前連線的 production project 實際唯讀查核結果：修復前置 relations `47/47`、28 個基礎函式 `28/28` 均存在；security-invoker 且 authenticated 可讀的 view `0/19`、有效 read index `0/24`、authenticated 可呼叫的應用 RPC `0/13`；另有 6 個需由 `0122` 清除的冗餘唯一索引。migration ledger 只記錄到 `0067`，但部分後續 SQL 曾手動執行，因此此狀態不能用 migration ledger 單獨推斷。先在 staging 套用並驗證；確認目標是網站目前使用的 production Supabase project 後，再由維運者於低流量時段在 SQL Editor 執行整份修復檔。索引建立使用現有 migration 的一般 `CREATE INDEX`，大型資料表可能短暫阻擋寫入。

驗收應為 source relations `47/47`、base functions `28/28`、ready views `19/19`、ready indexes `24/24`、callable RPCs `13/13`、`overview_snapshot_account_bound = true`、`redundant_indexes_remaining = 0`，且缺漏清單為空。本修復檔不會補寫 `supabase_migrations.schema_migrations`；在完整比對並修復 migration ledger 前，不要對目前 production 執行整批 `supabase db push` 或 GitHub migrations workflow，避免重播 `0068`–`0132` 中已手動套用或尚未確認的其他變更。修改 migration source 後，以 `node scripts/database/generate-production-read-model-sql.mjs` 重建兩份 SQL，並以 `node scripts/database/generate-production-read-model-sql.mjs --check` 驗證產物同步。
