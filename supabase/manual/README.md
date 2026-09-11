# Supabase 手動範例資料

這些檔案只供 disposable staging／測試專案使用，所有資料都使用 `DEMO-` 識別碼，不是真實公司資料。不要在 production 執行。

若建立耐久匯入批次時出現 `function digest(text, unknown) does not exist`，先執行 `fix-pgcrypto-digest-search-path.sql`；這是已手動套用舊 migration 的資料庫需要的相容性修正。

## SQL Editor 順序

1. `seed-demo-warehouses.sql`
2. `seed-demo-master-data.sql`
3. 重新整理網站後，於「總覽 → 主檔與資料基礎」確認機構、部門、制服品號、供應商匯入狀態。
4. 期初庫存不要直接 INSERT `inventory_balances`；在「倉庫作業 → 庫存管理 → 期初庫存」選擇 `OPENING_BALANCE`，使用 `sample-opening-balances.csv`，由 worker 預覽後再確認發布。

網站的「載入範例」按鈕也會產生同一組 `DEMO-` 資料。套用範例前必須勾選 disposable staging 確認，且仍會經過既有 authenticated RPC、RLS、冪等與稽核流程。

## 本輪模組化管理 SQL

`migrations/0076_inventory_report_export_audit.sql`（或同名 `manual/0076_inventory_report_export_audit.sql`）只需在 `audit_events` 與 `private.append_audit_event` 已存在的資料庫執行一次。它提供庫存管理 CSV 匯出的 metadata 稽核 RPC，不會保存或寫入匯出的資料列。

商品與組織管理清單若要顯示停用資料並支援重新啟用，依序在 Supabase SQL Editor 執行：

1. `migrations/0077_uniform_item_manager_read_inactive.sql`（商品停用品號；若尚未套用）。
2. `manual/0078_organization_manager_read_inactive.sql`（機構／部門停用資料）。

`0078` 只增加 HR 對停用機構與部門的 `SELECT` 權限；既有角色讀取啟用資料的 RLS 不變，新增、修改、停用仍只能經過 `apply_master_import`。

員工主檔管理的單筆新增／修改／停用與稽核匯出，請在上述 migration 都已套用、且 `operation_commands`、`audit_events`、`private.append_audit_event` 已存在後執行：

3. `migrations/0079_employee_master_management.sql`

`0079` 新增 HR-only 的 `save_employee_master` 與 `record_employee_master_export`。新增時若工號已存在會拒絕，修改時必須帶既有員工 UUID 且不可變更工號；停用只更新 `employment_status = 'INACTIVE'`，不會 DELETE 員工或交易歷史。執行前不需要刪除既有資料，成功後重新整理網站即可使用單筆保存與稽核匯出。
