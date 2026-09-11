# AI Agent 架構與交接說明

<!-- SYSTEM-GUIDE:GENERATED:START -->

## 1. 接手順序與目前狀態

1. 先讀根目錄 `AGENTS.md`，再讀 `README.md` 與 `CONTEXT.md`。
2. 執行 `git status --short`、`git diff`、`git log -8 --oneline`；保留使用者未提交內容，不可 reset／clean。
3. 正式功能以 `src/`、`src/domain/`、`src/server/` 與 `supabase/migrations/` 為準；`prototype/uniform-management-prototype.html` 是獨立 mock。
4. 依需求讀 `docs/spec/`、`docs/architecture/`、`docs/implementation/roadmap.md` 與 `docs/deployment/`。
5. 先找 workspace、panel、domain function、server API、RPC／RLS seam，再做最小 patch。

分析基準為 2026-08-31 的 `main`。最近功能包含共用管理清單、員工主檔、營運報表中文化、組織主檔、visited mount、工作區模組化、商品管理重構、庫存模組與待發貨理貨工作區。正式狀態仍是 `NOT_READY`，不可由本機測試或 UI smoke 自動改成 READY。

## 2. 技術架構

```text
Browser / Next.js Client Panels
        │ Supabase session / anon key
        ├──────────────► Supabase Auth + RLS SELECT + protected RPC
        │
        └── Bearer token ─► Next.js server API
                              ├─ caller-scoped Supabase client
                              └─ server-only Auth Admin client（限帳號操作）

Durable import / PDF / ERP / Storage cleanup / retention
        └──────────────► dedicated DB LOGIN + job actor binding + thin RPC
```

- Framework：Next.js 15 App Router、React 19、TypeScript。
- UI 入口：`src/app/page.tsx` → `WorkspaceShell`。
- 登入：`useAuthSession()` 與 `AuthPanel`，Supabase browser client 位於 `src/lib/supabase-browser.ts`。
- 權限：Supabase Auth identity 綁定 `app_accounts.auth_user_id`，角色位於 `user_roles`，`private.current_account_id()` 與 `private.has_role()` 是 DB 權威。
- 高權限帳號管理：`POST /api/admin/accounts` → `createCallerClient()` → `authorizeSystemAdmin()` → `executeAccountAdminOperation()`；service role 只在 server bundle。
- 資料真相：PostgreSQL 業務表、append-only posting／ledger 與 security-invoker reporting views。
- 部署：GitHub `main` → Vercel；migration 由手動核准 workflow 或受控 SQL Editor 套用。

## 3. UI 模組與導覽

`workspaceDefinitions` 集中工作區、模組與搜尋索引；`WorkspaceShell` 管理 hash navigation、登入 gate、responsive shell 與 workspace mounting。`RetainedPanelSet` 預設使用 `visited` mount：未造訪 panel 不查詢，造訪後切換仍保留表單狀態。`ModuleWorkbench` 是同一模組內的任務頁籤 seam。

`ManagementCatalogTable` 是帳號、商品、組織、員工、兩倉庫存、營運報表、採購差異原因碼、更正歷史、CEO 待核版本、換季採購決策品項、換季需求登記與待發貨需求的共用 interface：呼叫端提供 rows 與欄位定義，implementation 集中欄位顯示、密度、每頁筆數、範圍與首末頁導覽；純 page／column 規則在 `management-catalog.ts`。`CorrectionHistoryTable` 再以 `correction-history.ts` 的狀態／搜尋／排序 domain 規則組合五個更正 panel 的唯讀歷史；CEO 清單以 `seasonal-approval.ts` 集中活動／revision／送核時間／hash 搜尋與排序，採購清單以 `seasonal-procurement.ts` 集中品號／品名／數量／決策狀態搜尋與排序，需求登記清單以 `seasonal-demand.ts` 集中員工／品號／數量／更新時間搜尋與排序，待發貨需求以 `warehouse-shipment.ts` 集中需求單／日期／來源版本搜尋與排序，再把選取結果交回各自 panel。動態報表可用 absolute row index 補足沒有自然 key 的列，但資料查詢、RLS、匯出稽核與 mutation 不得搬進這些 UI module。

七個正式工作區：

| Workspace | 組裝檔 | 核心功能 |
| --- | --- | --- |
| 總覽 | `OverviewWorkspace.tsx` | 營運摘要、組織、商品、耐久匯入 |
| 帳號管理 | `AccountWorkspace.tsx` | SYSTEM_ADMIN 帳號／角色／scope |
| 人資需求 | `HrWorkspace.tsx` | 日常需求、補庫、退回、更正、員工主檔 |
| 倉庫作業 | `WarehouseWorkspace.tsx` | 庫存、發貨、盤點、倉庫更正 |
| 採購與入庫 | `ProcurementWorkspace.tsx` | 採購決策、原因碼、採購單、入庫與更正 |
| 換季活動 | `SeasonalWorkspace.tsx` | 活動設定、需求登記清單／表單、需求窗口、CEO 核准 |
| 報表 | `ReportsWorkspace.tsx` | 即時 views、PDF、ERP artifact |

主要深模組：

- 商品：`ProductManagementPanel`／`ProductCatalogPanel`／`ProductMasterEditorPanel`／`product-management.ts`。
- 組織：`OrganizationManagementPanel`／catalog／editor／`organization-management.ts`。
- 員工：`EmployeeManagementPanel`／catalog／editor／`employee-management.ts`，單筆保存由 migration `0079` 的 HR-only RPC 處理。
- 庫存：`InventoryManagementPanel` 組合 availability、opening import、operation hub、history export 與 calculator；`inventory-availability.ts` 集中篩選／排序語意，清單使用 `ManagementCatalogTable`，不得直接 DML balance。
- 發貨：`WarehouseShipmentPanel` 以 `warehouse-shipment.ts` 將已送出需求與既有 DRAFT 組合成左側待發貨清單，右側建立／恢復理貨草稿並顯示品號快照與調庫上限；建立者可依 RLS 修改草稿明細，非建立者唯讀，正式 POST 仍只走 `post_warehouse_shipment`，沒有取消／刪除語意。
- 帳號：`AccountAdminPanel` 的目錄使用 `account-directory.ts` 篩選／排序與 `ManagementCatalogTable`；「管理」只選取資料，所有真正異動仍走 `/api/admin/accounts` 的 server-side authorization、冪等鍵與稽核理由。
- 採購差異原因碼：`ProcurementReasonCodePanel` 分離清單與新增／修改模式，查詢排序在 `procurement-reason-management.ts`；代碼編輯時鎖定，保存仍只走 `maintain_procurement_difference_reason`。
- 報表：`ReportingPanel` 只讀 `0063` 起的 security-invoker views，中文欄位 metadata 在 `reporting-catalog.ts`。
- 更正歷史：`CorrectionHistoryTable`／`correction-history.ts` 共用人資發放、退回、盤點、倉庫調撥與採購入庫五個 panel 的唯讀歷史瀏覽；各 panel 保留來源查詢、有效數量計算與 draft／POST RPC，adapter 不得加入直接 UPDATE／DELETE 或 bulk mutation。
- CEO 換季審核：`SeasonalApprovalPanel` 以 `seasonal-approval.ts` 將 PENDING submission 映射成可搜尋／排序／分頁的待核版本清單；選取只改變明細載入目標，核准／退回仍保留 revision/hash 重驗、idempotency 與 `review_seasonal_submission` RPC。
- 換季需求登記：`SeasonalDemandPanel` 以 `seasonal-demand.ts` 將目前活動可讀取的 `seasonal_demand_lines` 映射成可搜尋／排序／分頁的清單；選取只回填右側表單，切換員工／品號會離開修改模式，保存仍只走 `upsert_seasonal_demand_line`，不直接 DML 或刪除需求歷史。
- 換季採購決策：`SeasonalProcurementPanel` 以 `seasonal-procurement.ts` 將 APPROVED line 映射成可搜尋／排序／分頁的品項清單，顯示待決策／已完成與最終採購量；選取只改變右側工作區，供應商／MOQ／差異原因與保存仍由原 panel 走 `set_seasonal_procurement_line`，採購單仍走 `create_purchase_order`。

## 4. 核心領域不變條件

### 倉庫與庫存

- 只有一個啟用 HR 倉與一個啟用 GENERAL 倉；畫面名稱固定「人資倉」、「總倉」。
- 機構／部門是歸屬與報表維度，不是倉庫。
- 品號是庫存最小單位與 ERP 穩定識別；不同尺寸使用不同品號。
- 庫存不得為負。餘額只能由 opening、發貨、入庫、盤點、退回或更正 posting 推導。
- 人資送單建立跨兩倉合計預留；預留不分攤承諾來源倉。補庫不預留。
- 高風險交易使用 operation command、canonical fingerprint、固定鎖序與 response-loss recovery。

### 主檔與歷史

- 穩定代碼／工號建立後不可被改造成另一業務實體。
- 已引用主檔使用停用，不 hard delete；員工刪除語意是 `INACTIVE`。
- 已 POST 原單不可修改；更正以關聯來源的新 append-only 單據處理。
- 員工調動只更新目前歸屬，歷史單據保存 snapshot。

### 狀態與並行

- 倉庫發貨是實物交付與帳務的正式鎖點；POST 前不得交付。
- Stocktake 使用 balance version fencing；過期實盤進 `STALE_COUNT`。
- 盤點／更正造成預留不足時，同交易把 reservation 標記 `CONFLICTED`、需求轉 `INVENTORY_REVIEW_REQUIRED`。
- 換季 submission revision/hash 不可覆寫；CEO review 必須鎖後重驗目前版本。
- 採購上限、採購單、入庫與更正共用鎖集合，避免並行超收。

## 5. Supabase 結構

Migration 從 `0001` 到 `0079` 依序累積；不要編輯已套用 migration，修正使用新的 forward migration。重要範圍：

- `0001–0014`：核心主檔、兩倉、需求、發貨、補庫、盤點、退回、換季、採購、ERP/PDF baseline、opening、主檔匯入。
- `0015–0030`：受保護草稿 RPC、匯入 guard、scope、並行與來源版本、correction／provenance forward fixes。
- `0031–0048`：append-only audit、durable import、private Storage、worker、renderer、generation/download fencing。
- `0049–0062`：採購入庫、退回、發放、調庫、盤點更正與 PDF coverage／metadata guard。
- `0063–0066`：九張 reporting views 與來源 ACL。
- `0067–0070`：帳號 profile、Auth audit、login name 與 bulk roles。
- `0071–0075`：Storage cleanup、terminal retention、staging payload scrub、pgcrypto bridge。
- `0076–0079`：庫存匯出稽核、停用商品／組織可讀、員工主檔管理。

RLS 與 RPC 必須一起檢查。新增可見欄位時同步檢查 schema、表單、清單、詳情、篩選、RPC、RLS、匯入／匯出與測試。

## 6. Durable import 與 artifact

### Durable import

`DurableImportPanel` 只負責建批次、取得固定 private key、直傳檔案、查詢狀態、確認或取消。真正解析與 APPLY 在 `scripts/import/import-worker.ts`，透過 `src/domain/import-worker.ts` 與 worker RPC。瀏覽器不可持有 worker／service-role。

Storage cleanup eligibility 只能由 `0071`／`0072` RPC 決定；DB staging payload retention 只走 `0074` 的 `job_import_retention` RPC。兩個 job role 不得合併或互相擴權。

### PDF／ERP

Renderer runner 位於 `scripts/renderer/renderer-worker.mjs`，Storage proxy 位於 `scripts/renderer/storage-proxy.mjs`。Artifact revision、attempt、lease、generation、object key、bytes/hash 與 download grant 都要 fail closed。正式 ERP mapping 仍未知，不要把 smoke adapter 升格成正式格式。

## 7. System Guide 自身

- Markdown source：`docs/system-guide/user-guide.md`、`admin-guide.md`、`agent-guide.md`。
- 文件定義與 parser：`src/domain/system-guide.ts` 集中三個固定檔名、標題、讀者與有限 block types；`src/server/system-guide.ts` 只讀這份 allowlist。
- Protected API：`HEAD/GET /api/system-guide`，先用 caller bearer token 執行 `authorizeSystemAdmin()`。
- Frontend：`/system-guide` 仍掛載 `WorkspaceShell initialSystemGuide`，保留原作業台左側導航，右側才呈現 `SystemGuidePageClient`；React 以文字節點渲染，不用 `dangerouslySetInnerHTML`。
- 即時導覽：文件按鈕直接使用共用 allowlist metadata，不等待文件 GET 才建立；`useSystemGuideAccess` 以 RLS self-read `user_roles` 決定入口、sessionStorage 只快取目前分頁的正向可見狀態，並在背景預取文件。
- 安全邊界：入口快取不是授權；GET API 每次仍重新驗證 Auth、有效 `app_accounts` 與 `SYSTEM_ADMIN`，角色被移除或 session 失效時會拒絕內容並清除前台快取。
- CSS：所有新增規則以 `.system-guide-*` scope 限定。

## 8. 開發、測試與驗證

```text
npm install
npm run dev
npm run lint
npm test
npm run typecheck
npm run build
git diff --check
```

Prototype 另跑：

```text
node -e "const fs=require('fs'),vm=require('vm'); const h=fs.readFileSync('prototype/uniform-management-prototype.html','utf8'),lt=String.fromCharCode(60); new vm.Script(h.split(lt+'script>')[1].split(lt+'/script>')[0]); console.log('prototype syntax: ok')"
```

測試慣例：

- 純規則放 `src/domain/*.test.ts`。
- Migration／workflow safety 以 contract test 檢查權限、函式、gate 與禁止事項。
- Workspace index 與 module mount policy 有獨立測試。
- System Guide 必須測 parser 對 unsafe HTML／JavaScript 的拒絕、固定文件 allowlist、API server-side authorization seam 與 admin-only navigation。

## 9. 部署與 Git 規則

- 使用者已要求修改完成後自動推送 GitHub；提交前仍要 fetch／比較 `origin/main`，排除未授權檔案。
- 不得 reset／clean 使用者工作樹，不得提交 `prototype/` 或 ignored private evidence。
- 推送 `main` 觸發 Vercel；之後以正式登入 session 做 read-only UI smoke。
- Migration 不因 Vercel deploy 自動套用；需另走受保護 workflow／SQL Editor。
- CI 固定執行 test、lint、typecheck、build。

## 10. 最近變更與接續方向

最近已完成：

- 員工主檔獨立模組、完整單筆表單、停用、匯入與稽核匯出。
- 營運報表中文欄位、搜尋、排序、分頁與即時刷新。
- 組織主檔與商品管理的清單／表單／匯入匯出深模組。
- 帳號、商品、組織、員工、兩倉庫存、營運報表、採購差異原因碼、五種更正歷史、CEO 待核版本、換季採購決策品項、換季需求登記與待發貨需求共用管理清單的欄位顯示、密度、每頁筆數與完整分頁；更正歷史另提供單號／原因搜尋與狀態篩選，CEO 清單提供活動／revision／snapshot hash 搜尋與送核時間排序，採購清單提供品號／品名／數量／決策狀態搜尋與排序，需求清單提供員工／品號／數量／HR 修改狀態搜尋與排序，待發貨清單提供需求單／日期／草稿狀態搜尋與排序，選取後回填右側表單或理貨工作區。
- Workspace／ModuleWorkbench visited mount，避免登入後 eager 查詢。
- 庫存管理整合兩倉可用量、期初、操作入口與歷史匯出。

下一步不得自行製造 production PASS。合理的 repository 工作是新的明確功能、測試或文件需求；production gate 需要使用者提供 staging／production credentials、正式樣本、核准與 evidence。

## 11. 風險與未知資訊

- 正式 `schema_migrations`、六角色 RLS、Auth、private Storage、signed URL 與並行 smoke 的最新 evidence 不在 Git；必須外部查核。
- Durable import worker、renderer、Storage destructive cleanup 與 90-day staging retention 尚需受保護 staging integration／destructive smoke。
- 正式 PDF 樣式、鼎新 mapping、第一批帳號／scope、owner／backup owner、外部 monitoring、RPO／RTO、三年容量及 cutover approval 尚未完成。
- `release-evidence.example.json` 永遠是 `NOT_READY` template，不可修改成全 PASS。
- Error monitoring 不得重新加入 raw message、stack、body、headers、cookie、token、query 或 DB URL。

## 12. 重要證據符號

| 判斷 | 程式／文件證據 |
| --- | --- |
| 登入 gate 與 hash workspace | `WorkspaceShell`、`useAuthSession` |
| SYSTEM_ADMIN server authorization | `authorizeSystemAdmin`、`createCallerClient` |
| 角色與 scope DB 權威 | `private.current_account_id`、`private.has_role`、migration `0036` |
| 庫存真相與預留 | migration `0001`、`0002`、`docs/spec/workflows-and-permissions.md` |
| 固定 mount seam | `ModuleWorkbench`、`RetainedPanelSet`、`shouldMountRetainedPanel` |
| Durable import background work | `scripts/import/import-worker.ts`、migration `0035`／`0044–0048` |
| Reporting views | migration `0063–0066`、`ReportingPanel`、`reporting-catalog.ts` |
| Release status | `release-gate.mjs`、`release-evidence.mjs`、`README.md` |

<!-- SYSTEM-GUIDE:GENERATED:END -->

<!-- SYSTEM-GUIDE:MANUAL:START -->

## 人工交接補充

可在此記錄非敏感的當班維運事項、待 review 分支或外部 ticket ID。不要放 secret、正式資料、未遮罩 log 或可直接登入的連線資訊。

<!-- SYSTEM-GUIDE:MANUAL:END -->
