# 制服管理系統

本儲存庫保存經 50 題需求訪談及庫存、決策、架構三輪交叉稽核後的第一版規格。實作前先以這些文件作為共同基準。

## 第一個可執行切片

目前已接上 Next.js／TypeScript 試算介面、員工明細／品號彙總工作台、Supabase 登入面板、員工 CSV 安全預覽與主檔 CSV／JSON 匯入／匯出工作台；HR、需求窗口、CEO、採購與倉庫各自的受保護操作入口也已接到對應 RPC：

- `npm install` 安裝依賴。
- `npm test` 執行 F/I/R/T/D 庫存規則與人資需求明細彙總測試。
- `npm run typecheck` 執行 TypeScript 檢查。
- `npm run build` 建立 Next.js production bundle。
- `npm run dev` 啟動本機介面；沒有 Supabase env 時仍可使用預覽試算。

Supabase migrations 位於 `supabase/migrations/`：`0001_uniform_foundation.sql` 涵蓋核心主檔、供應商條件、兩倉餘額、受 RLS 保護的 HR 草稿、人資需求、歷史快照、冪等 `operation_commands`、品號鎖與合計預留 `submit_hr_request` RPC；`0002_warehouse_shipping.sql` 新增倉庫發貨草稿、固定鎖序的 `post_warehouse_shipment` RPC、總倉調出／人資倉調入／發放流水及 POSTED 鎖單；`0003_replenishment.sql` 新增不建立預留的補庫送出與 POST；`0004_stocktake.sql` 新增依 balance version fencing 的盤點 POST 與 `STALE_COUNT`；`0005_returns.sql` 新增原始發放明細同源驗證的退回 POST；`0006_employee_import.sql` 新增整批驗證後原子 upsert 員工主檔的匯入 RPC；`0007_seasonal_procurement.sql` 建立含季別、精確開放／截止時間、凍結員工／品號範圍、窗口需求、核准快照、供應商 MOQ、採購單與分批驗收的 RLS 資料基線；`0008_seasonal_procurement_rpc.sql` 新增活動建立／範圍設定／開放／關閉、送核、帶 revision/hash 的 CEO 核准或退回、不可覆寫的 MOQ 決策、採購上限調整、採購下單、驗收草稿與總倉入庫 POST；`0009_purchase_receipt_corrections.sql` 新增同源採購入庫更正草稿與 POST、有效到貨／合格／拒收重算、總倉合格數量 delta 與 PO `REOPENED` 狀態；`0010_purchase_order_lifecycle.sql` 新增訂購量具理由調整、`REOPENED`、取消與 `CLOSED_SHORT` 終止交易；`0011_erp_export_snapshot.sql` 新增日期＋機構的不可變 ERP 邏輯批次、來源追溯、artifact revision／render attempt 基線與批次／artifact request RPC；`0012_document_artifacts.sql` 新增各類單據 PDF family、不可變 artifact revision、render attempt 與受權限保護的 PDF request RPC，現有需求工作台提供瀏覽器 A4 列印預覽；`0013_opening_balance_cutover.sql` 新增 SYSTEM_ADMIN 專用期初批次、全域 PRE_CUTOVER／LIVE singleton、opening ledger 與非 LIVE 過帳的資料庫 gate；`0014_master_data_import_export.sql` 新增機構、部門、制服、供應商與供應商 MOQ 的整批驗證／原子 upsert，以及角色限制的 JSON 匯出 RPC；`0076_inventory_report_export_audit.sql` 新增庫存管理 CSV 匯出的 metadata 稽核 RPC，不保存匯出資料列；`0077_uniform_item_manager_read_inactive.sql` 保留一般帳號只讀啟用品號，並讓具制服品號維護權限的 HR 可讀取停用品號以重新啟用；`0078_organization_manager_read_inactive.sql` 保留既有組織啟用資料讀取規則，並讓 HR 可在組織管理清單讀取停用機構／部門以修改或重新啟用。`src/domain/erp-export.ts` 僅提供已驗證的示範格式版本；鼎新正式格式仍需成功匯入樣本。領域測試固定 MOQ／配置上限／驗收與 ERP 彙總規則。PDF／ERP renderer runner、lease-fenced Storage proxy/finalize 與 disposable-staging active smoke harness 已納入版本庫；正式上線前仍需在受保護 staging credentials 下實際執行 renderer／Storage、RLS／signed URL／並行交易驗收，並完成期初真實資料演練、Supabase project secrets、鼎新欄位映射與角色初始資料。

`0079_employee_master_management.sql` 補上 HR-only 員工單筆新增／修改／停用與匯出稽核 RPC：新增與修改以員工 UUID 明確分流，工號建立後不可變，停用保留所有需求與發放歷史；正式站使用前須由使用者在 Supabase SQL Editor 執行該檔。

## 正式應用接手狀態（2026-08-31）

正式 Next.js 應用已部署至 [uniform-co.vercel.app](https://uniform-co.vercel.app/)，程式碼由 GitHub `Kevin72333/uniform-co` 的 `main` 分支提供，資料與登入由 Supabase project 提供。正式操作必須先登入；未設定 Supabase env 或未有有效 session 時只顯示登入／設定畫面，不載入工作區資料。

### 2026-08-31 repository-local 收尾快照

目前版本庫內能以程式、migration、測試與文件完成的安全防線已收尾；這不等於 production cutover 已通過。下一位 AI agent 接手時，先讀 [`agents.md`](./agents.md)，再執行 `git status --short` 與 `git log -5 --oneline`。目前 `main` 已包含已完成修改，預期只保留未追蹤 `prototype/`；除非需求明確指向 prototype，否則不要加入提交。使用者已要求每次修改驗證完成後自動推送 GitHub，推送前須 fetch／比較 `origin/main` 並只 stage 本次檔案。

- Durable import 已有真正的背景 worker：`npm run import:worker -- --once` 只跑單輪 claim／處理；移除 `--once` 時會依 `IMPORT_POLL_MS` 持續輪詢 `list_import_work`，接續 PARSE／VALIDATE／APPLY。瀏覽器關閉不會讓耐久 chunk 必然停住；真實常駐 staging 部署仍待驗收。
- Storage cleanup 已由 `0071_storage_cleanup_contract.sql`／`0072_import_terminal_retention.sql` 提供 DB 權威 eligibility、24 小時下限、FAILED／CANCELLED import 90 天 terminal retention、append-only cleanup audit，以及 fail-closed dry-run／execute runner。每日 workflow 目前只 dry-run；destructive cron 尚未核准啟用。
- Import staging payload retention 已由 `0073_import_staging_audit_minimization.sql`／`0074_import_staging_payload_retention.sql` 分離永久 evidence 與可清除 payload；`job_import_retention` 只 scrub 已 terminal 90 天的 `raw_values`／`normalized_values`／`validation_errors`，保留 batch／row shell／chunk／diff evidence，設定 `staging_purged_at` 後禁止 restart。每日 workflow 同樣只 dry-run。
- 備份／還原已補齊 generation manifest lock、來源檔穩定性、run-id/path 防線、DB/Auth/Storage 分階段完整性、明文 offsite handoff 阻擋、空目標 preflight、Auth users／identities／MFA count 驗證與八個關鍵 application table count 驗證。Storage restore 除本地 bytes／SHA-256 外，每個 POST 2xx 後都會從目標 private Storage GET read-back，再核對 byte length 與 SHA-256；任何 drift、409 conflict 或 read-back 失敗都 fail closed。
- Staging preflight／read-only smoke／disposable active smoke／renderer smoke harness 已在版本庫內；PDF／ERP smoke adapter、Storage proxy、lease/generation/key fencing 與 response-loss recovery contract 已具備，但真實 Supabase Auth／RLS／Storage／signed URL／並行 SQL evidence 仍需受保護 staging 執行。
- Error monitoring 已有 Next.js `instrumentation.ts`、server-side 結構化最小事件與通用 `src/app/error.tsx`；事件刻意不記錄 raw error message、stack、request body、header、cookie、token、query 或 DB URL。正式外部 monitoring provider、alert 與 incident smoke 尚未完成。
- 三年容量已有 fail-closed `npm run capacity:plan` 與 60%／70%／85% gate；模型估算不能代替 `STAGING_SYNTHETIC` 實測，未有真實三年資料／檔案、尖峰效能、備份還原及 quota 證據時保持 `NOT_VALIDATED`。
- Production release 已集中到 17 個 gate 的 `npm run deployment:release-gate`；正式 evidence 使用 ignored 的 `docs/deployment/onboarding/private/release-evidence.json`，由 `npm run deployment:release-evidence` 初始化／record／block。版本化 template 永遠是 `NOT_READY`，repository-local 測試成功不能自動轉成 production evidence。
- 商品管理採獨立清單、商品表單、供應商／MOQ 與匯入／匯出頁籤：清單支援分類、搜尋、狀態、排序、分頁及逐列編輯／停用；新增與修改走單列 `apply_master_import`，刪除採停用以保留交易歷史。`0077_uniform_item_manager_read_inactive.sql` 套用後，HR 可在清單檢視停用品號並重新啟用。
- 組織主檔採機構／部門合併清單、獨立新增／修改／停用表單與匯入／匯出頁籤；清單支援類型、搜尋、狀態、排序與分頁，保存沿用 `apply_master_import`。`0078_organization_manager_read_inactive.sql` 套用後，HR 可檢視停用資料並重新啟用。
- 員工主檔已從人資更正中獨立為清單／表單與批次匯入工作台；清單支援搜尋、機構／狀態篩選、排序、分頁、逐列編輯／停用與稽核 CSV 匯出，完整表單可維護歸屬、職稱、到離職日與備註。`0079_employee_master_management.sql` 套用後，單筆保存與匯出才會啟用。
- 庫存管理已集中為兩倉可用量、期初庫存耐久匯入、發貨／盤點／採購入庫／更正操作入口、庫存／流水 CSV 匯出與本機規則試算；兩倉清單支援商品分類／庫存狀態篩選、數量排序、摘要、欄位設定、密度及完整分頁。`0076_inventory_report_export_audit.sql` 只記錄匯出 metadata，庫存數字仍由流水與 view 推導。
- 營運報表的九張 security-invoker view 已集中到 `reporting-catalog` 顯示 seam：正式畫面使用對應中文欄名與常用狀態，並支援報表說明、即時搜尋、欄位排序、欄位顯示、密度、25／50／100 筆完整分頁及重新整理；原始 view 欄位與 RLS 不變。維護規則見 [`docs/architecture/reporting-catalog.md`](./docs/architecture/reporting-catalog.md)。
- `ModuleWorkbench` 已成為正式 UI 的子功能 seam：商品、組織、帳號、庫存、人資需求／更正、倉庫盤點、採購決策／入庫、換季活動與正式文件都使用一致的工具列與任務頁籤。下層 `RetainedPanelSet` 同時管理七個 workspace、workspace module 與工作台子頁籤：預設首次開啟才掛載，之後保留未送出的 panel 狀態，避免未造訪模組在登入時同步查詢 Supabase。完整盤點、mount policy 與不拆分理由見 [`docs/architecture/module-workbench.md`](./docs/architecture/module-workbench.md)。
- SPSV29 的大型清單操作已轉成正式共用 `ManagementCatalogTable` module，而未移植其全域狀態：帳號、商品、組織、員工、兩倉庫存、營運報表、採購差異原因碼、五種更正歷史、CEO 待核版本、換季採購決策品項、換季需求登記與待發貨需求現在共用欄位顯示、舒適／緊湊密度、可調每頁筆數、目前資料範圍與第一／上一／下一／最後頁導覽。員工的離職日／備註、庫存的有效預留及帳號的登入綁定可按需顯示；原因碼提供明確新增／修改模式；更正歷史由 `CorrectionHistoryTable` 提供單號／狀態／差額／原因搜尋、狀態篩選與過帳時間欄位；CEO 清單提供活動／revision／snapshot hash 搜尋與選取後的審核明細；採購清單提供品號／品名／尺寸／數量／決策狀態搜尋與選取後的採購工作區；需求登記清單提供員工／品號／數量／HR 修改狀態搜尋與排序，選取後在右側工作區修改；待發貨需求清單提供需求單／日期／草稿狀態搜尋與排序，選取後在右側理貨工作區建立或恢復草稿。畫面設定不改 RLS、匯出集合或 mutation 契約。interface 與維護規則見 [`docs/architecture/management-catalog.md`](./docs/architecture/management-catalog.md)。
- System Guide 已整合至正式站 [`/system-guide`](https://uniform-co.vercel.app/system-guide)：`SYSTEM_ADMIN` 可在原 `WorkspaceShell` 左側或 topbar 開啟，原工作區導航保留，三份文件顯示在右側。文件按鈕使用固定 allowlist metadata 首屏建立，入口可見性使用本人 RLS `user_roles` 與同分頁 session cache 加速，文件內容仍由受保護 API 每次重新驗證 bearer session、有效帳號與 SYSTEM_ADMIN；頁面只渲染安全 typed blocks，不使用 `dangerouslySetInnerHTML`。同源文件與維護摘要位於 [`docs/system-guide/`](./docs/system-guide/README.md)。
- 最新完整本機驗證：71 個 test files、287/287 tests 全數通過，`npm run lint`、`npm run typecheck`、`npm run build` 與 System Guide parser tests 全部成功；`git diff --check` 沒有內容錯誤。正式狀態仍不因 repository-local 驗證轉為 READY。

目前正式狀態仍是 **`NOT_READY`**。剩餘項目需要真實外部證據：第一批正式帳號／角色／需求窗口範圍、GitHub／Vercel owner 與 backup owner 移交、鼎新正式 mapping 與成功匯入樣本、正式 PDF 版面核准、Supabase migration／RLS／Auth／Storage／signed URL／並行 smoke、durable import worker 與 renderer 真實 staging integration、Storage destructive cleanup、DB 90-day retention destructive smoke、外部 error monitoring、production-sized DB＋Auth＋Storage 從零還原、RPO／RTO 實測、三年容量實測，以及最後 production cutover approval。

### 已完成的正式介面

- `WorkspaceShell` 集中處理登入 gate、session refresh、左側工作區導航、網址 hash 切換與共用 topbar；正式工作區為「總覽、帳號管理、人資需求、倉庫作業、採購與入庫、換季活動、報表」七個 workspace。總覽內的「商品管理」集中品號／供應商／MOQ 的新增、修改、停用、匯入與匯出；倉庫作業內的「庫存管理」集中兩倉可用量、期初匯入、異動入口、歷史匯出與規則試算。
- `WorkspaceShell initialSystemGuide` 也是 System Guide 的正式外殼：`src/app/system-guide/page.tsx` 不建立第二套全頁導航，右側內容由 `src/app/system-guide/SystemGuidePageClient.tsx` 顯示；`src/app/use-system-guide-access.ts` 只負責入口顯示與背景預取，最終權限在 `src/app/api/system-guide/route.ts` 與 `src/server/system-guide.ts`。三份 Markdown 的固定檔名、標題與讀者集中在 `src/domain/system-guide.ts`，前後端共用同一 allowlist。
- 每個 workspace 的功能由 `src/app/workspaces/*Workspace.tsx` 組裝，模組定義、頁籤名稱與搜尋索引集中在 `src/app/workspaces/workspace-config.ts`；功能頁籤是 tab 切換，不是按鈕把畫面往下捲動。
- topbar 已包含 workspace 搜尋、通知中心、日期／資料狀態、帳號操作與風格下拉選單；手機版改用工作區下拉選單，桌面版使用左側導航。
- `AccountAdminPanel` 已獨立在左側「帳號管理」workspace。2–50 個小寫英數字的登入帳號與至少 6 字元密碼必填，聯絡 Email 選填且不作登入用途；建立與編輯時可一次管理多個業務角色（`SYSTEM_ADMIN`、`HR`、`WAREHOUSE`、`PROCUREMENT`、`CEO`、`DEMAND_COORDINATOR`），並支援啟用／停用、需求窗口的機構／部門範圍、Auth 綁定重設／解除，以及保留業務歷史的刪除操作。管理 API 位於 `src/app/api/admin/accounts/route.ts`，server-side 實作位於 `src/server/account-admin.ts`，權限與稽核契約以 `0036_account_role_scope_admin.sql`、`0067_account_admin_profile_and_auth_audit.sql`、`0068_account_login_and_bulk_roles.sql`、`0069_account_login_alphanumeric_only.sql`、`0070_account_login_minimum_two.sql` 為準。
- 風格下拉選單與 localStorage key `uniform:appearance-theme` 已提供五套可切換樣式：`AP`（目前 Apple-inspired）、`MX`（修改前 Prototype）、`GS`（GSAP motion；程式 id 保留為 `ga`）、`MB`（product workspace）、`SH`（shadcn/ui-inspired neutral dashboard）。SH 是現有 CSS token adapter，不額外引入 shadcn runtime dependency；樣式集中在 `src/app/globals.css`，選項集中在 `src/app/use-appearance-theme.ts`。
- 版面基線為 commit `3059723`；若後續只調整視覺，優先沿用 appearance seam，不要把某一套風格的 CSS 寫回共用 base rule，也不要改變 workspace／domain data flow。

### 正式應用的接手順序

1. 先讀 [`agents.md`](./agents.md) 的「最新 AI 接手快照」，再讀本節與 `CONTEXT.md`；依需求範圍再讀 `docs/spec/`、`docs/architecture/`、`docs/implementation/`。若修改前台說明、角色可見性或交接文件，再讀 [`docs/system-guide/README.md`](./docs/system-guide/README.md)。
2. UI／版面需求先搜尋現有 workspace、panel、theme selector 與 CSS token；功能需求先搜尋對應 domain function、panel 與 migration，再做最小 patch。
3. 所有帳號、角色與範圍異動都必須經 server-side API／Supabase 受保護 RPC，不能從瀏覽器直接使用 service role 或寫入 Auth 管理資料。
4. Prototype 與正式 App 是兩個不同驗收面：prototype 只驗證內容與流程；正式功能要驗證 Supabase Auth、RLS、Storage、RPC、並行鎖與 staging smoke。

## 文件索引

`0015_draft_creation_rpc.sql` 將人資需求、補庫與倉庫發貨的草稿建立接到受保護、冪等 RPC；`0016_employee_import_guard.sql` 將員工匯入的大小、欄數與儲存格限制移到資料庫端；`0017_seasonal_scope_guard.sql` 阻擋沒有員工/品號範圍的換季活動開放；`0018_seasonal_snapshot_at_open.sql` 在開放瞬間刷新並凍結員工歸屬快照；`0019_seasonal_demand_rpc.sql` 與 `0020_seasonal_demand_integrity.sql` 讓需求窗口只能透過鎖定活動、使用凍結範圍快照的伺服器 RPC 登記需求，並撤銷 direct DML；`0021_seasonal_hr_correction.sql` 提供 HR 待核修正 RPC 與快照範圍讀取；`0022_procurement_reason_codes.sql` 加入可維護採購差異原因碼、SYSTEM_ADMIN 維護 RPC、停用供應商防線與採購決策 RPC 的 active supplier 驗證；`0023_receipt_draft_validation.sql` 允許採購入庫草稿先保存未完成分類，並將完整分類與拒收理由檢查放在 POST 交易；`0024_receipt_draft_update.sql` 讓入庫草稿可依固定鎖序修改；`0025_stocktake_draft_rpcs.sql` 將盤點草稿建立／更新改由受保護 RPC 在交易內擷取帳面量與 balance version，前端新增盤點工作台並保留 `STALE_COUNT` 版本 fencing；`0026_return_draft_rpc.sql` 將退回草稿建立改由原始發放明細推導身份與快照，前端新增退回草稿／POST 工作台；`0027_stocktake_conflict_forward.sql` 將兩倉合計預留衝突與需求轉 `INVENTORY_REVIEW_REQUIRED` 的盤點 POST 修正套用到已完成初始 migration 的環境；`0028_stocktake_update_forward.sql` 將盤點更新 RPC 的重盤簽章與確認防線套用到舊環境；`0029_return_schema_forward.sql` 將退回明細的 line_no 與唯一約束補到舊環境。盤點調減會以兩倉合計檢查有效預留，必要時同交易標記需求需重新檢查；前端也提供 CEO 待核版本的 revision/hash 核准或退回入口、採購決策／採購單、採購入庫、庫存盤點、員工制服退回與 A4 PDF artifact 請求／狀態入口；入庫草稿可先暫存，POST 後才把合格量寫入總倉。人資工作台在 Supabase 環境會載入正式主檔並可建立草稿後送出預留，員工 CSV 匯入工作台也可確認後原子套用員工主檔；換季工作台可建立活動並凍結員工/品號範圍、需求窗口可在授權範圍登記數量，再呼叫受保護 RPC 開放需求窗口。

`0030_pdf_erp_provenance_forward.sql` 是已部署環境的 forward migration：PDF request 會鎖定來源並由資料庫推導 snapshot hash/version，區分 `FORMAL`／`DRAFT_WATERMARK`；ERP 在 `GENERATION_FAILED`／`IMPORT_FAILED` 重試時會受控回到 `PREPARING`，且 fingerprint 必須帶 frozen source snapshot。`0031_audit_archive_controls.sql` 新增 append-only audit／archive／lifecycle 資料表與主要業務寫入稽核 trigger，並建立預設 `NOLOGIN` 的 `job_storage_cleanup` role；`0032_durable_import_foundation.sql` 新增預設 `NOLOGIN` 的 `job_import_worker` role、固定 private Storage key 的匯入批次、chunk、逐列差異資料與 `AWAITING_UPLOAD → UPLOADED` 確認邊界；`0033_worker_role_archive_import_forward.sql` 會修正已部署 role 的 NOLOGIN 狀態並把 durable `import_batches` 接到封存／稽核；`0034_worker_audit_identity.sql` 會以受保護 `job_actor_bindings` 綁定 worker audit actor，並讓 archive/lifecycle RPC 伺服器推導 actor/fingerprint；`0035_durable_import_worker_rpcs.sql` 新增 batch→chunk 固定鎖序、lease/generation/cursor CAS、重試退避、解析／驗證 chunk 完成、取消與受角色限制的 EMPLOYEES／主檔／期初 APPLY；`0036_account_role_scope_admin.sql` 提供 SYSTEM_ADMIN 專用的業務帳號建立、停用／啟用、六角色指派、需求窗口機構／部門範圍設定、Auth 綁定重設或解除，並以冪等 command、最後一位 SYSTEM_ADMIN 防線及 append-only 綁定／稽核事件保護管理操作；`0037_durable_import_storage.sql` 建立 private `uniform-imports` bucket 與固定 key 直傳 policy，新增檔名／MIME 配對約束；`0038_durable_import_recovery.sql` 提供瀏覽器重開後依原匯入冪等鍵查回上傳批次，並阻擋同一匯入冪等鍵跨類型重用；`0039_renderer_artifacts.sql` 建立 PDF／ERP artifact 的 lease-fenced claim、heartbeat、retry、finalize、歷史 revision 下載與 renderer payload DTO；`0040_renderer_storage_key_fence.sql` 再把 renderer 角色的 Storage 讀寫限制在未逾期 lease 所保留的 attempt key，並補 ERP snapshot／attempt 的刪除不可變保護；`0044_import_worker_forward.sql` 將 APPLY claim 的耐久確認、preview action、錯誤列與 max-attempt 檢查放在 worker 交易邊界；`0045_import_worker_snapshot_and_storage.sql` 提供 worker work polling、依匯入類型的主檔比對 snapshot，以及固定 `uniform-imports` object 的受控 proxy read capability。`src/domain/import-worker-parser.ts` 與 `src/domain/import-worker.ts` 提供 bounded parser、識別碼型別防線、EMPLOYEES／主檔的 INSERT／UPDATE／SKIP／ERROR preview 與 durable chunk range；`npm run import:worker -- --once` 可執行單輪 claim／smoke，移除 `--once` 則依 `IMPORT_POLL_MS` 持續輪詢並接續 parse／validate／apply。兩種模式都必須使用受保護的同名 worker role、Storage proxy 與 Supabase 環境；實際常駐部署、credentials、並行 SQL/RLS 與 Storage smoke 仍須在受保護 staging worker 環境驗收，不能由瀏覽器繞過。

- [業務詞彙](./CONTEXT.md)
- [產品需求規格](./docs/spec/product-requirements.md)
- [流程與權限](./docs/spec/workflows-and-permissions.md)
- [資料模型](./docs/spec/data-model.md)
- [匯入、匯出與鼎新 ERP](./docs/spec/import-export.md)
- [驗收條件](./docs/spec/acceptance-criteria.md)
- [系統架構](./docs/architecture/system-architecture.md)
- [管理清單介面](./docs/architecture/management-catalog.md)
- [資料保存、封存與容量政策](./docs/architecture/data-retention.md)
- [免費方案官方限制查核](./docs/research/free-tier-constraints.md)
- [實作路線圖](./docs/implementation/roadmap.md)
- [ADR：第一版只支援線上](./docs/adr/0001-online-only-first-release.md)
- [ADR：以期初庫存切換](./docs/adr/0002-cut-over-with-opening-balances.md)
- [ADR：人資送單預留、倉庫發貨過帳](./docs/adr/0003-reserve-before-warehouse-posting.md)
- [部署與同步 Runbook](./docs/deployment/runbook.md)
- [System Guide 索引](./docs/system-guide/README.md)
- [使用者操作說明](./docs/system-guide/user-guide.md)
- [管理者設定說明](./docs/system-guide/admin-guide.md)
- [AI Agent 深入交接說明](./docs/system-guide/agent-guide.md)
- [AI agent 接手指南](./agents.md)

Durable import worker 的 forward migration 順序為 `0045` → `0046` → `0047` → `0048` → `0056` → `0058` → `0061`：先建立 immutable reference snapshot，再拆分 bounded parse chunks，分離 worker／uploader actor，提供 definitive parser failure 狀態轉換，最後讓受控 `job_import_worker` 確認由使用者上傳的 object（保留原 uploader attribution）並進入解析；`0058` 也會在 worker batch lock 內修復 0046 以前遺留的 oversized PARSE chunk，`0061` 保留單檔 10MB 上限但容納 JSONB chunk envelope 的編碼膨脹。部署時不可只套用 `0045`；完整 SQL/RLS/Storage smoke 仍須在受保護 staging worker 環境執行。

## 尚待提供

下列正式帳號、主檔、期初庫存、外部驗收資料與維運責任，都可先使用 [`docs/deployment/onboarding/`](./docs/deployment/onboarding/) 的空白上線範本整理；填妥後的真實資料不可提交到 Git。

Staging 憑證就緒後，先依 [`docs/deployment/staging-preflight.md`](./docs/deployment/staging-preflight.md) 執行 `npm run deployment:preflight`，再進入實際 migration／RLS／worker／renderer smoke；preflight 本身不會連線或輸出 secret。

1. 鼎新 ERP 成功匯入樣本及欄位規格。
2. 主檔與期初庫存樣本。
3. 公司抬頭、Logo、正式列印樣式與簽名角色／欄位名稱。
4. 第一批帳號、角色及需求窗口權限清單。
5. 異地備份目的地、兩位金鑰保管人、維運信箱，以及暫定 RPO／RTO 的業務接受人。
6. 三年員工、交易、匯入、PDF／ERP 檔案量預估與公司正式保存年限。
7. 連接 Vercel Hobby 的個人 GitHub repository owner 與帳號移交／備援負責人。

第 4 項的界線：帳號管理介面、server-side 管理 API、六角色與需求窗口範圍控制已完成；目前仍待提供的是正式第一批帳號、角色指派、需求窗口機構／部門範圍與移交責任人清單。GitHub → Vercel → Supabase 的免費方案部署鏈已可運作，但正式交接仍需補上 owner、備援聯絡人與環境設定清單。

可立即依[實作路線圖](./docs/implementation/roadmap.md)開始第 0 階段蒐集與技術驗證。鼎新樣本阻擋第 4 階段驗收；主檔與期初樣本阻擋第 5 階段切換；列印樣式、帳號清單、備份還原與三年容量 gate 則分別阻擋文件、使用者及正式上線驗收。

Durable import worker 的 forward migrations 為 `0045`–`0048`、`0056`、`0058`、`0061`：reference snapshot、bounded chunks、worker/uploader actor separation、malformed-upload failure、受控 worker 對上傳物件的確認、legacy oversized chunk repair，以及 JSONB chunk payload headroom 都已納入；實際 Supabase/RLS/Storage smoke 仍需受保護 staging worker 執行。

`0049_receipt_correction_reconciliation.sql` 是採購入庫更正的 forward fix：更正 POST 會以本次 delta 過帳、在鎖內重算有效數量與採購配置，必要時將不足預留轉為衝突並記錄 PO 重開原因；更正狀態查詢 RPC 支援瀏覽器回應遺失後恢復。實際 Supabase 交易／鎖序仍需 staging smoke 驗證。

`0050_return_correction.sql` 補齊退回更正：以原退回明細與原發放明細為不可變來源，於共同品號／來源鎖內重算有效退回量，調整人資倉、處理預留衝突並提供 draft／POST／狀態查回 RPC；退回更正工作台保留歷史與 response-loss recovery。實際 SQL／RLS／並行交易仍需 staging smoke 驗證。

`0051_hr_issue_correction.sql` 補齊 HR_ISSUE 更正：以已 SHIPPED 的原發放明細為唯一來源，保存不可變員工／品號快照，正負差額只透過 HR 倉庫受保護 RPC 過帳；POST 會在共同品號、需求、原明細與兩倉餘額鎖內重算有效發放／退回上限、拒絕突破有效預留與負庫存，並提供狀態查回與 HR 工作台。實際 SQL／RLS／並行交易仍需 staging smoke 驗證。

`0052_correction_source_advisory.sql` 將 HR_ISSUE、RETURN 與 RETURN correction 對同一人資需求的來源更正共用 advisory fence，避免不同品號更正各自持有 item mutex 後互等需求列；staging 必須以同一需求的不同品號並行 POST 驗證可重試且不死結。

`0053_return_reason_codes.sql` 建立可維護的退回原因碼、退回業務日期，撤銷無原因碼的舊建立 RPC，並由 `ReturnPanel` 使用 active reason code 與 Asia/Taipei 業務日期建立新草稿；`LEGACY` 僅供歷史資料相容且停用。

`0054_warehouse_transfer_correction.sql` 補齊 WAREHOUSE_TRANSFER 更正：已 POST 發貨／補庫明細可建立 signed transfer delta，POST 在品號、來源文件／明細與兩倉餘額鎖內重算有效調撥上限，原子新增 GENERAL 出庫與 HR 入庫流水，並提供狀態查回與 WAREHOUSE 工作台。

`0055_stocktake_correction.sql` 補齊 STOCKTAKE 更正：以已 POST 盤點明細為不可變基線，保存 signed counted delta，於盤點倉／兩倉餘額與 active reservations 鎖內重算有效實盤；若更正使預留失去覆蓋，仍完成盤點更正流水並同交易標記相關需求 `INVENTORY_REVIEW_REQUIRED`。

`0057_correction_source_immutability_forward.sql` 將更正來源不可變 trigger forward-fix 到已套用 0055 的環境，納入盤點更正的 `original_stocktake_id`，避免已部署資料庫只套用舊 trigger 而漏掉盤點來源欄位。

`0059_receipt_correction_lockset_forward.sql` 在採購入庫更正調整庫存／預留前再次核對完整需求 reservation lock set；若並行交易在 item mutex 後新增其他品項預留，交易以 40001 重試而不使用部分集合。`0061_import_chunk_payload_bound.sql` 將解析 chunk 的 JSONB payload guard 提高至 25MB，保留單檔 10MB 上限但容納 JSON escaping／差異欄位的膨脹，不改寫既有匯入歷史。

`0060_pdf_document_type_coverage.sql` 將同一個 snapshot／revision／renderer payload state machine 擴展到發貨、補庫、換季核准、採購單與採購入庫，並同步各角色的 request、payload、下載與 Storage read policy；`0062_renderer_metadata_null_guard.sql` 讓 PDF／ERP finalize 對缺失或空白 Storage hash／size metadata fail closed；`0063_reporting_views.sql` 建立 security-invoker 的即時計算報表 views（庫存可用量、需求／發貨、流水、員工發放、換季、採購入庫、ERP 候選與稽核），前端「報表」面板只讀取 views 並沿用底層 RLS，不保存第二份數字；`0064_reporting_receipt_aggregation.sql` 修正分批入庫與更正的 PO line 聚合粒度，避免同一明細多張入庫單造成進度倍增；`0065_inventory_history_source_number.sql` 補上庫存流水對應的來源單號，同時保留 UUID source identity；`0066_inventory_history_source_acl.sql` 以 HR／WAREHOUSE 讀取 policy 補上來源映射表的最小 SELECT 邊界，讓 security-invoker 流水報表能解析來源單號；正式公司版面與字型仍依待提供樣本調整。

`0067_account_admin_profile_and_auth_audit.sql` 補齊帳號基本資料與 Auth Admin 安全事件稽核；`0068_account_login_and_bulk_roles.sql` 將登入帳號與選填聯絡 Email 分離，新增唯一 `login_name`，並讓建立帳號與多角色指派在同一資料庫交易完成；`0069_account_login_alphanumeric_only.sql` 將登入帳號限制為小寫英數字，`0070_account_login_minimum_two.sql` 再將最短長度調整為 2 個字元。既有 Email 登入在管理員指派登入帳號前仍可相容使用。

`0071_storage_cleanup_contract.sql` 建立 Storage cleanup 的資料庫權威判定與 append-only `storage_cleanup_events`；`0072_import_terminal_retention.sql` 為 durable import 增加可靠 `terminal_at`，FAILED／CANCELLED source object 只有在目前 terminal episode 滿 90 天後才會成為 `TERMINAL_IMPORT_90D` 候選，既有 terminal rows 則從套用 0072 當下保守地重新起算完整 90 天；`0073_import_staging_audit_minimization.sql` 再把 `import_rows` 的永久 audit 改為 metadata-only allowlist，避免 raw／normalized／validation payload 被 append-only audit 永久複製，且不追溯改寫既有 audit history；`0074_import_staging_payload_retention.sql` 新增專用 `job_import_retention` 與 `staging_purged_at`，只讓 FAILED／CANCELLED 且目前 terminal episode 已滿 90 天的 batch scrub `raw_values`／`normalized_values`／`validation_errors`，永久保留 batch header、row shell、chunk metadata 與 `import_field_diffs`，purge 後亦禁止 restart。`npm run retention:import-staging` 已提供獨立 runner：預設只列出候選，`--execute` 還必須搭配 `IMPORT_RETENTION_EXECUTE_CONFIRM=PURGE_ELIGIBLE_IMPORT_STAGING`，且 DB URL username 必須精確為 `job_import_retention`；`.github/workflows/import-staging-retention.yml` 每日只跑 dry-run，手動 execute 才允許真正 scrub。Storage cleanup 仍只允許同名 `job_storage_cleanup` LOGIN／active execution actor 列出、重新確認及記錄 Storage 候選，固定 bucket/key allowlist 為 `uniform-imports`、`uniform-pdf`、`uniform-erp`，且 Storage object 至少需滿 24 小時；不要把 `job_storage_cleanup` 擴張成 DB staging purge worker。`npm run cleanup:storage` 預設只做 dry-run；真正 DELETE 必須同時使用 `npm run cleanup:storage -- --execute` 與 `CLEANUP_EXECUTE_CONFIRM=DELETE_ELIGIBLE_STORAGE`，並提供受保護的 `CLEANUP_SUPABASE_URL`／`CLEANUP_STORAGE_ADMIN_KEY`。runner 不接受任意 bucket/path，且每個 DELETE 前都再次呼叫 DB `confirm_storage_cleanup_candidate`；READY／仍被 artifact 引用、APPLIED 或仍在進行中的資料不會被清除，也不會重設 lease 或刪除 import batch／row／diff 等 DB evidence。兩個 destructive 模式都仍需在真實受保護 staging credentials 下完成 integration smoke 後，才可考慮改成自動 destructive cron。

## Prototype 交接狀態（2026-08-22）

目前可直接開啟的單檔介面位於 [`prototype/uniform-management-prototype.html`](./prototype/uniform-management-prototype.html)。這是用來確認資訊架構、操作流程與內容命名的 throwaway prototype，不是正式 Next.js／Supabase runtime；狀態只存在瀏覽器記憶體，重新整理會重設資料。

### 開啟與互動

- 直接雙擊 HTML 即可開啟；也可用 `?variant=A`、`?variant=B` 或 `?variant=C` 切換「控制塔／工作佇列／營運地圖」首頁版本。
- 左側工作區包含「總覽、人資需求、倉庫作業、採購與入庫、換季活動、報表」；表格支援搜尋、排序、分頁、狀態篩選與點擊詳情。
- 人資需求詳情可依狀態推進「送出申請 → 主管核准 → HR 備貨 → 預留完成 → 已發放」，也可退回補件；新需求建立後會同步產生工作佇列項目。
- Prototype 目前沒有正式 API、RLS、Storage 或資料庫寫入；需要把流程落地時，請回到 `src/`、`supabase/migrations/` 與 `docs/spec/` 對照實作。

### 目前已確認的內容契約

- 倉庫只有兩個：`人資倉`、`總倉`。庫存資料、倉庫地圖、發放批次與入庫草稿都只能使用這兩個名稱。
- 人資需求目前只保留：員工姓名、員工編號、機構、需求品項、狀態、更新時間與備註。
- 人資需求目前不顯示也不保存部門或負責人；後續若要補部門，需先更新資料契約與表單／列表／詳情的整體呈現，不要只在單一畫面加欄位。
- 人資需求詳情的流程狀態與工作佇列狀態需同步；新建、核准、備貨、預留、發放、退回都應更新兩處顯示。
- 機構下拉選單順序固定為：

  `8C清福`、`7C清氣`、`6C清心`、`5C清平`、`3C清安`、`8D清春`、`7D清日`、`6D清照`、`5D清風`、`3D清景`、`8E青山`、`7E清泉`、`6E清水`、`5E清清`、`3E清涼`、`2CD清護`、`清福法人`、`一館`、`三館`、`二館`、`清田法人`、`清福幼兒園`、`含笑`、`其他`

### 接手時的最小驗證

從 repository root 執行：

```cmd
node -e "const fs=require('fs'),vm=require('vm'); const h=fs.readFileSync('prototype/uniform-management-prototype.html','utf8'); new vm.Script(h.split('<script>')[1].split('</script>')[0]); console.log('prototype syntax: ok')"
npm run lint
npm test
npm run typecheck
npm run build
git diff --check
```

修改 prototype 後至少確認：六個工作區可以渲染、需求詳情可以開啟、人資需求可建立與推進、倉庫仍只有兩個名稱、機構清單未被改成示例地名。正式功能修改仍需另外跑 Supabase／RLS／Storage staging smoke，不能只以 HTML prototype 驗收。
