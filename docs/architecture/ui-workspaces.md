# UI 工作區模組架構

## 目的

正式網站的頁面外殼參照 `prototype/uniform-management-prototype.html` 的六個工作區，但 prototype 只負責版面、命名與流程示意。正式資料仍由 `src/domain/`、`src/app/*Panel.tsx` 與 Supabase migrations／RLS 提供。

## 模組分層

```text
src/app/page.tsx
└─ WorkspaceShell                 導航、hash 工作區狀態、共用頁面外殼
   ├─ workspaces/OverviewWorkspace   組織主檔、商品管理、耐久匯入
   ├─ workspaces/HrWorkspace          人資需求、補庫、退回、員工匯入、更正
   ├─ workspaces/WarehouseWorkspace   庫存管理、發貨、盤點、倉庫更正
   ├─ workspaces/ProcurementWorkspace 採購決策、差異、入庫、更正
   ├─ workspaces/SeasonalWorkspace    換季活動、需求登記、CEO 審核
   └─ workspaces/ReportsWorkspace     報表、PDF artifact、ERP 匯出
```

`WorkspaceShell` 的介面只有工作區選擇與呈現；它不直接讀取業務 table，也不實作任何 RPC。每個 workspace module 是一個可替換的版面組合，內部面板仍各自擁有 Supabase 查詢、表單狀態、錯誤處理與操作流程。

## 七個工作區契約

工作區 ID 集中在 `src/app/workspaces/workspace-config.ts`。新增或調整工作區時，需同步：

1. config 的 `id`、中文名稱、說明與導航順序。
2. `WorkspaceShell.tsx` 的內容映射與 hash deep link。
3. 對應的 workspace module 及其面板分組。
4. 正式網站的 workspace／module DOM smoke；prototype 仍維持自己的六工作區契約。

目前正式工作區名稱固定為：`總覽`、`帳號管理`、`人資需求`、`倉庫作業`、`採購與入庫`、`換季活動`、`報表`。

## 商品與庫存模組邊界

- `總覽 > 商品管理` 是 `ProductManagementPanel` 的組合入口。`ProductCatalogPanel` 提供目前品號與可見供應商 MOQ 清單；`ProductMasterEditorPanel` 提供制服品號、供應商及供應商品號／MOQ 的單筆新增、修改與停用；`MasterDataPanel` 提供小批次 CSV／JSON 預覽、匯入與匯出，`DurableImportPanel` 以獨立 recovery key 提供大批次 CSV／XLSX。組織機構／部門則留在 `組織主檔`，避免資料責任重疊。
- `倉庫作業 > 庫存管理` 是 `InventoryManagementPanel` 的組合入口。`InventoryAvailabilityPanel` 只讀 `v_item_availability` 顯示兩倉帳面量、品號合計預留與可申請量；`InventoryOperationHub` 只提供導向，將期初、發貨、盤點、採購入庫與更正交給既有正式面板；`InventoryHistoryExportPanel` 只從 security-invoker views 讀取並下載 CSV；`InventoryCalculator` 保留為不寫入的規則試算。
- 商品與庫存模組不建立第二份數量或商品資料。商品匯入走既有主檔 RPC；庫存數字仍由 `inventory_balances`／不可變流水及 security-invoker view 提供，瀏覽器不直接寫入餘額。
- 商品刪除採 `is_active=false` 停用；庫存草稿可以修改，已過帳資料只能追加更正或退回。庫存匯出 metadata 透過 `0076_inventory_report_export_audit.sql` 的 `record_report_export` 寫入 append-only `audit_events`。

## 狀態與資料邊界

- 工作區切換只改變瀏覽器 hash 與顯示中的 `tabpanel`，不新增 localStorage，也不建立第二份業務資料。
- 各工作區的所有面板都保留在同一個 `AuthSessionBoundary` 下；登入或登出後，資料面板會依新的 session 重新掛載。
- `AuthPanel` 是共用登入介面；角色與資料範圍仍由 Supabase Auth、`user_roles` 與 RLS 判定。
- 報表只讀取 security-invoker views；PDF／ERP 只請求正式 artifact，不在 UI 端自行產生業務數字。
- 倉庫名稱、機構清單、人資需求欄位與需求狀態流程沿用 `agents.md`／README 的既有契約。

## 延伸規則

- 新增一個完整業務流程時，先在 `src/domain/` 建立可測試的領域模組，再新增或擴充對應的 `*Panel.tsx`；最後把面板放進正確 workspace module。
- 只要是版面共用問題，修改 `WorkspaceShell` 或 `globals.css`；不要在每個面板複製側欄、工作區選單或登入狀態。
- 不要把 Supabase client、RPC 名稱或資料表查詢放進 workspace config；config 只描述導航與工作區元資料。
- 若功能跨越兩個工作區，保留單一資料面板作為行為來源，必要時用工作區入口或連結導向，不要複製同一份表單狀態。

## 視覺契約

正式網站目前對齊 prototype 的 C 版視覺系統：米灰畫布、深炭側欄、珊瑚色主要操作色、低陰影的米白卡片、12px 圓角與左側珊瑚強調線。共用色票與響應式斷點集中在 `src/app/globals.css` 的 prototype visual system 區塊；新增面板應沿用既有 `.panel`、`.panel-heading`、`.status-pill`、`.primary-button` 與 `.secondary-button`，不要重新建立一套顏色或按鈕樣式。

## 驗證

UI 重構後至少執行：

```text
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

瀏覽器再確認七個導航項目都能切換、商品管理與庫存管理頁籤可開啟、每次只有一個可見 `tabpanel`、`#overview`／`#hr` 等 hash 可直接開啟，以及手機寬度會出現工作區下拉選單。
