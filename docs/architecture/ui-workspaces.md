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

工作區採兩層按需載入 seam：`WorkspaceShell` 以 `next/dynamic` 載入目前切換到的 workspace；各 `*Workspace.tsx` 再讓主要入口保持同步、次要 panel 透過 `next/dynamic` 延後到第一次開啟時載入。工作區與次要 panel 共用 `WorkspacePanelLoading`，立即呈現同頁骨架及可及載入訊息，不顯示 lazy-loading 的內部實作細節；骨架動畫支援 `prefers-reduced-motion`。載入狀態不改變 hash、模組選擇、`RetainedPanelSet` 的 visited mount policy 或任何資料權限。這是 bundle 與首屏互動性的優化，不是把資料查詢或 RLS 規則搬到前端。

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
- 總覽會在 `app_accounts` 身分查核期間啟動同一 Auth session 的 read-ahead：優先讀取 `v_overview_core`，只有同一 SQL statement 回傳的 `account_id` 與身份查核結果相同時，才用 account-bound 快照；舊 view 缺少 `account_id` 時以不含該欄位的查詢相容；view 不存在時，則立即並行讀取四個既有摘要 view，避免等身份查核結束才開始 fallback。fallback 仍使用同一 Supabase client 與 RLS，結果以 `authUserId` 綁定；真正的權限／schema 錯誤保持為錯誤、不轉成成功 fallback。任何預讀結果都只能在 `identityReady` 且 Auth user 相同後採用；account-bound 結果還要再次比對 `accountId`。不得移除 `hasCurrentDataSnapshot` 顯示隔離，也不得把這項最佳化擴散到其他面板。
- 總覽同一帳號已有核心摘要快照時，重新進入或背景刷新期間繼續顯示該快照，並以「背景更新中」提示；只有尚無有效快照時才以 `—` 佔位。活動摘要仍可延後載入，不得讓它阻擋核心摘要；身份錯誤時隱藏數字但不宣告仍在載入。`overviewReadPresentation` 是這些載入／刷新呈現規則的唯一純邏輯 seam，測試須同時涵蓋首次載入、同帳號背景刷新與身份錯誤。
- 人資需求的員工／品號選項優先讀取 0104 的 RLS read views，明確確認 view 不存在時才走既有資料表 fallback；員工 FK embed 無法解析時才退回分開讀取。資料快照維持 30 秒，schema miss 則沿用 read-model rollout 的 60 秒 TTL，避免每次資料快取更新都重複送出必定失敗的 probe，同時讓仍開啟的頁面可偵測新 migration；有作用域的資料異動只刷新資料，不清除 schema 能力快取。權限錯誤不得被 fallback 隱藏。
- `WorkspaceShell` 以穩定的 `selectWorkspace` callback、保留上次工作區的 ref、memoized `WorkspaceContent` 與 `workspacePanels`，避免導航／主題等不相關 render 重跑已造訪的隱藏工作區；各 `*Workspace` 以 `useMemo` 固定 `RetainedPanelSet` 的 panel element，工作區頁籤切換只改變可見性，不重建面板內容；Overview／Warehouse 面板只有其真正使用的導航 callback 改變時才重建。`PanelActivityContext` 仍在工作區／子頁籤啟用狀態改變時通知相關消費者；不可為了減少 render 移除訪問後保留、延遲掛載或活動狀態控制。這是程式層 render 去重，尚不能代替已登入瀏覽器的正式操作量測。
- `WorkspaceSessionProvider` 的共用身份 context 只發布登入布林值、穩定的 Auth user ID、業務帳號／角色與身份載入狀態；輪替中的 Supabase `Session`／access token 不得放回這個共用 context，避免 token refresh 通知所有已造訪面板。只在必須手動組 Authorization header 的 server API 呼叫使用 `useWorkspaceAccessToken()`；登出與換帳號仍需更新身份 context，帳號管理也必須讀取最新 token。
- `AuthPanel` 是共用登入介面；角色與資料範圍仍由 Supabase Auth、`user_roles` 與 RLS 判定。
- 報表只讀取 security-invoker views；PDF／ERP 只請求正式 artifact，不在 UI 端自行產生業務數字。
- **PDF／ERP 狀態互動**：`useWorkflowStatusPoll` 讓背景輪詢與手動重新查詢共用同一個 in-flight promise；純狀態讀取期間仍可再次查詢，點擊會加入既有請求而不增加 RPC。`READY` 成品在讀取期間仍可下載，因為下載 RPC 會重新驗證角色與狀態。建立下一份／批次只受 mutation `busy` 與 artifact 非終態限制，不因 `artifactLoading` 暫時鎖住；啟動下一份或同批重試時，以 `createReadRequestController` 作廢舊狀態讀取，晚到結果不能覆蓋新工作區。終態判斷集中在 `isArtifactTerminalStatus`，`PREPARING` 仍不能另開同類 revision。
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

若新增或移動 workspace 次要 panel，另執行 `src/domain/workspace-loading-contract.test.ts`；測試必須確認 dynamic import 與 loading shell 存在，且沒有為方便而恢復同一 panel 的靜態 import。

瀏覽器再確認七個導航項目都能切換、商品管理與庫存管理頁籤可開啟、每次只有一個可見 `tabpanel`、`#overview`／`#hr` 等 hash 可直接開啟，以及手機寬度會出現工作區下拉選單。
