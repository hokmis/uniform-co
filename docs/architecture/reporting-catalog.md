# 營運報表目錄介面

## 目的

`src/domain/reporting-catalog.ts` 是營運報表的顯示語意 seam。資料庫 view 保留穩定英文欄位，避免破壞 Supabase 查詢、RLS、匯出與既有整合；正式 UI 只透過這個 module 取得報表名稱、用途、欄位順序、中文欄名、常用值格式、搜尋與排序行為。

這個 interface 集中九張 security-invoker view 的使用知識：

- `reportDefinitions`：報表名稱、中文顯示名稱、說明與穩定欄位順序。
- `getReportColumns()`：依報表情境取得中文欄名；同名欄位若語意不同，可使用報表專屬名稱。
- `formatReportValue()`：處理空值、數量、日期、布林值、倉庫用途及常用狀態中文化。
- `filterReportRows()`／`sortReportRows()`：讓 UI 不必重複搜尋與穩定排序 implementation。

## 資料與權限界線

`ReportingPanel` 只對目前選定的 view 執行 `select('*').limit(200)`，不建立報表資料表、不回寫業務來源，也不繞過底層資料表 RLS。切換報表後自動載入；`reporting-catalog` 處理中文顯示語意與搜尋排序，`ManagementCatalogTable` 處理欄位顯示、密度、25／50／100 筆完整分頁與 sticky header。

一般營運報表不自行新增下載按鈕。現有 CSV 匯出仍由庫存管理的 `InventoryHistoryExportPanel` 與 `record_report_export` allowlist／稽核 RPC 負責；若日後要開放其他報表匯出，必須先擴充伺服器端角色、資料集 allowlist、筆數限制、冪等與稽核契約。

## 維護規則

1. View 新增或改名欄位時，同步更新 `reportDefinitions`、中文欄名與 interface tests。
2. 未登記的新欄位會顯示「未設定中文欄位」，不得直接把英文資料庫欄名退回正式 UI。
3. 同一英文欄位在不同 view 有不同業務語意時，使用報表專屬中文名稱，不要勉強共用錯誤翻譯。
4. 中文化只影響呈現；查詢欄位、UUID、原始 JSON 與資料庫契約保持不變。
5. 搜尋、排序與分頁只處理已由 RLS 放行、最多 200 筆的目前結果，不能宣稱是未載入全量資料的伺服器端查詢。
