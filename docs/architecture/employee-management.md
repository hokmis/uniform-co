# 員工主檔管理模組

## 模組邊界

`EmployeeManagementPanel` 是人資工作區內的員工主檔入口，只組裝「員工清單／單筆表單」與「批次匯入」兩個使用者任務。清單查詢沿用 `employees`、`institutions`、`departments` 的 RLS；新增、修改與停用集中在 `save_employee_master`，CSV 批次沿用 `apply_employee_import_checked`，匯出前由 `record_employee_master_export` 留下 metadata 稽核。前端不持有 service-role，也不直接對 `employees` 做 DML。

## 穩定識別與生命週期

- 員工 UUID 是修改命令的資料庫 identity，員工工號是建立後不可變的業務識別。
- 新增命令的 `p_employee_id` 必須為 `null`；若工號已存在，資料庫拒絕請求，不把新增誤當修改。
- 修改命令必須帶既有 UUID；若 UUID 不存在或工號與原資料不符，資料庫拒絕請求。
- 刪除語意固定為 `employment_status = 'INACTIVE'`。不得 DELETE 員工，也不得改寫需求、發放、退回或換季歷史。

## 權限、冪等與稽核

`0079_employee_master_management.sql` 的兩個 RPC 都要求 authenticated HR、冪等鍵及 request fingerprint。單筆保存記錄前後員工資料，匯出只記錄列數與 fingerprint，不保存匯出內容。若瀏覽器在回應前斷線，畫面保留相同冪等鍵重試；使用者修改表單後才建立新的命令。

## 操作分流

- 日常新增與修正：使用完整單筆表單，可維護機構、部門、狀態、職稱、到職日、離職日與備註。
- 大量建檔：使用 CSV 預覽、欄位驗證、差異摘要與整批原子套用。
- 查詢與交接：清單提供搜尋、機構／狀態篩選、排序、分頁及目前篩選結果 CSV 匯出。

正式環境必須先套用 `0078` 才能讓 HR 編輯器正確載入停用的機構／部門，再套用 `0079` 啟用單筆保存與稽核匯出。兩者都不代表 production RLS 驗收完成；仍需以 HR 與非 HR session 在 staging 驗證允許與拒絕路徑。
