# 制服管理系統

本儲存庫保存經 50 題需求訪談及庫存、決策、架構三輪交叉稽核後的第一版規格。實作前先以這些文件作為共同基準。

## 第一個可執行切片

目前已接上 Next.js／TypeScript 試算介面、員工明細／品號彙總工作台、Supabase 登入面板、員工 CSV 安全預覽與主檔 CSV／JSON 匯入／匯出工作台；HR、需求窗口、CEO、採購與倉庫各自的受保護操作入口也已接到對應 RPC：

倉庫作業的「發貨作業」現在同時接收已送出的人資需求與額外補庫單；補庫單透過 `0096_replenishment_post_ui.sql` 的 `post_replenishment_request_with_lines` 受保護 RPC，在資料庫交易內重新鎖定總倉庫存並完成兩倉調庫，瀏覽器不直接修改已送出的補庫明細。`0097_replenishment_post_lock_order.sql` 再把公開補庫 POST 入口的品號互斥鎖提前到來源單鎖定前，與人資送出／取消及一般發貨共用鎖序，避免並行操作死結。

倉庫清單刷新時會保留仍存在的選取來源；尚未載入明細的列不會被誤標為目前作業，若來源已消失也會清空右側舊明細，避免使用者在錯誤單據上繼續操作。

- `npm install` 安裝依賴。
- `npm test` 執行 F/I/R/T/D 庫存規則與人資需求明細彙總測試。
- `npm run typecheck` 執行 TypeScript 檢查。
- `npm run build` 建立 Next.js production bundle。
- `npm run dev` 啟動本機介面；沒有 Supabase env 時仍可使用預覽試算。

Supabase migrations 位於 `supabase/migrations/`：`0001_uniform_foundation.sql` 涵蓋核心主檔、供應商條件、兩倉餘額、受 RLS 保護的 HR 草稿、人資需求、歷史快照、冪等 `operation_commands`、品號鎖與合計預留 `submit_hr_request` RPC；`0002_warehouse_shipping.sql` 新增倉庫發貨草稿、固定鎖序的 `post_warehouse_shipment` RPC、總倉調出／人資倉調入／發放流水及 POSTED 鎖單；`0003_replenishment.sql` 新增不建立預留的補庫送出與 POST；`0004_stocktake.sql` 新增依 balance version fencing 的盤點 POST 與 `STALE_COUNT`；`0005_returns.sql` 新增原始發放明細同源驗證的退回 POST；`0006_employee_import.sql` 新增整批驗證後原子 upsert 員工主檔的匯入 RPC；`0007_seasonal_procurement.sql` 建立含季別、精確開放／截止時間、凍結員工／品號範圍、窗口需求、核准快照、供應商 MOQ、採購單與分批驗收的 RLS 資料基線；`0008_seasonal_procurement_rpc.sql` 新增活動建立／範圍設定／開放／關閉、送核、帶 revision/hash 的 CEO 核准或退回、不可覆寫的 MOQ 決策、採購上限調整、採購下單、驗收草稿與總倉入庫 POST；`0009_purchase_receipt_corrections.sql` 新增同源採購入庫更正草稿與 POST、有效到貨／合格／拒收重算、總倉合格數量 delta 與 PO `REOPENED` 狀態；`0010_purchase_order_lifecycle.sql` 新增訂購量具理由調整、`REOPENED`、取消與 `CLOSED_SHORT` 終止交易；`0011_erp_export_snapshot.sql` 新增日期＋機構的不可變 ERP 邏輯批次、來源追溯、artifact revision／render attempt 基線與批次／artifact request RPC；`0012_document_artifacts.sql` 新增各類單據 PDF family、不可變 artifact revision、render attempt 與受權限保護的 PDF request RPC，現有需求工作台提供瀏覽器 A4 列印預覽；`0013_opening_balance_cutover.sql` 新增 SYSTEM_ADMIN 專用期初批次、全域 PRE_CUTOVER／LIVE singleton、opening ledger 與非 LIVE 過帳的資料庫 gate；`0014_master_data_import_export.sql` 新增機構、部門、制服、供應商與供應商 MOQ 的整批驗證／原子 upsert，以及角色限制的 JSON 匯出 RPC；`0076_inventory_report_export_audit.sql` 新增庫存管理 CSV 匯出的 metadata 稽核 RPC，不保存匯出資料列；`0077_uniform_item_manager_read_inactive.sql` 保留一般帳號只讀啟用品號，並讓具制服品號維護權限的 HR 可讀取停用品號以重新啟用；`0078_organization_manager_read_inactive.sql` 保留既有組織啟用資料讀取規則，並讓 HR 可在組織管理清單讀取停用機構／部門以修改或重新啟用。`src/domain/erp-export.ts` 僅提供已驗證的示範格式版本；鼎新正式格式仍需成功匯入樣本。領域測試固定 MOQ／配置上限／驗收與 ERP 彙總規則。PDF／ERP renderer runner、lease-fenced Storage proxy/finalize 與 disposable-staging active smoke harness 已納入版本庫；正式上線前仍需在受保護 staging credentials 下實際執行 renderer／Storage、RLS／signed URL／並行交易驗收，並完成期初真實資料演練、Supabase project secrets、鼎新欄位映射與角色初始資料。

`0079_employee_master_management.sql` 補上 HR-only 員工單筆新增／修改／停用與匯出稽核 RPC：新增與修改以員工 UUID 明確分流，工號建立後不可變，停用保留所有需求與發放歷史；正式站使用前須由使用者在 Supabase SQL Editor 執行該檔。`0080_master_data_system_admin_access.sql` 修正主檔管理角色契約：允許 `SYSTEM_ADMIN` 新增／修改／停用／匯出所有主檔，並同步商品與供應商主檔讀取 policy；`0081_jsonb_object_length_compatibility.sql` 補上 PostgreSQL JSONB 物件長度相容 bridge，修正主檔 RPC 執行時的函式錯誤；`0082_master_data_item_code_qualification.sql` 修正主檔 RPC 內 `item_code`／`supplier_code` 的 PL/pgSQL 欄位歧義；`0083_master_data_conflict_targets.sql` 補回主檔 RPC 所需的完整唯一索引，修正 `ON CONFLICT` 找不到唯一／排除約束的錯誤，並在既有重複資料時 fail-closed；`0085_uniform_item_delete.sql` 新增受保護的商品硬刪除 RPC：有 `inventory_balances` 或 `inventory_ledger_entries` 紀錄時必定拒絕，其他業務外鍵關聯也會安全阻擋，刪除前保留稽核快照；`0087_department_parent_resolution.sql` 修正部門保存的父機構解析，從目前選取的機構 UUID＋代碼解析 `institution_id`，並在解析失敗時於寫入前中止；`0090_employee_parent_active_guard.sql` 禁止停用仍有在職員工的機構／部門，避免人資需求畫面出現可選但送出必敗的資料；`0122_remove_redundant_master_conflict_indexes.sql` 在確認 0084 named constraints 與 `apply_master_import` 已全部使用 `ON CONFLICT ON CONSTRAINT` 後，移除 0083 遺留的六個重複唯一索引，降低主檔寫入／vacuum 成本；示範資料既有異常可依 `supabase/manual/repair-demo-hr-employee-organizations.sql` 限定 DEMO 代碼修復。這些 forward migration 必須在 Supabase SQL Editor 依序執行；0122 也可使用 `supabase/manual/0122_remove_redundant_master_conflict_indexes.sql`，且會在前置條件不符時整批停止。若手動執行後仍出錯，可用唯讀的 `supabase/manual/verify-master-data-conflict-targets.sql` 查核實際 project、索引與 `apply_master_import` signature；若查核通過但登入後仍回傳 `42P10`，先執行 `supabase/manual/rebuild-master-import-rpc.sql`，仍失敗再執行 `supabase/manual/0084_master_data_constraint_targets.sql` 將 RPC 改用已存在的 named constraints。

商品、組織與員工清單的成功讀取快照均綁定目前 `accountId`；同一帳號的暫時 JWT 同步錯誤保留可用快照，切換帳號、首次尚未完成讀取或權限／Schema 失敗時隱藏舊資料並停止相依操作，員工匯出也只允許使用目前帳號的完整快照。這只收斂前端讀取與操作邊界，不改主檔 RPC、RLS、唯一鍵或匯出稽核契約。

`0091_hr_request_submit_alias_fix.sql` 修正 `submit_hr_request` 的 PostgreSQL `UPDATE ... FROM` 別名作用域；正式函式雖已查核具備 `cross join` 修正，正式環境仍重現 `invalid reference to FROM-clause entry for table "l"` 時，需再執行 `0094_hr_request_submit_scope_hardening.sql`。0094 將快照更新改成獨立來源子查詢＋主鍵更新，並同步把送出驗證 trigger 與送出 RPC 的短別名改成描述性別名，從根源移除本流程的 `l` 參照歧義。

`0092_hr_request_active_master_guard.sql` 在需求由 `DRAFT` 轉為 `SUBMITTED` 的資料庫狀態轉移上，再次確認員工仍在職且所屬機構／部門仍啟用，避免草稿建立後主檔停用造成送出快照不完整。`HrRequestHistoryPanel` 新增 HR／倉庫可讀的需求單查詢、明細、有效預留與發貨狀態；倉庫發貨 POST 與人資取消也沿用相同冪等鍵，網路結果未知時可安全重試。

`0093_hr_request_cancel_draft_shipment_cleanup.sql` 在人資需求進入 `CANCELLED`，或送出後修改而退回 `DRAFT` 時，清理由該需求建立、尚未過帳的倉庫 DRAFT 發貨單與明細，避免取消／修改後留下不可見、來源版本過期且佔用唯一來源鍵的孤兒草稿；已 `POSTED` 的發貨單維持 immutable，不會被清理。正式 Supabase project 已查核存在 `hr_request_cancel_draft_shipment_cleanup` trigger。
`0094_hr_request_submit_scope_hardening.sql` 是正式資料庫仍回報 `invalid reference to FROM-clause entry for table "l"` 時的必要 forward migration；正式 Supabase project 已查核 `submit_hr_request` 與送出驗證 trigger 均使用 scope 修正版，並已以正式測試草稿完成「建立→送出→預留→發貨草稿→POST」驗證。
`supabase/manual/verify-hr-request-flow.sql` 是人資請領流程的唯讀驗收查詢，會檢查 0094 函式／trigger、兩倉設定，以及需求單、預留、發貨單與庫存過帳的矛盾狀態；所有 `violation_count` 應為 0。

`0096_replenishment_post_ui.sql` 將補庫明細的實際調庫量與短發原因收斂到受保護 POST RPC；`0097_replenishment_post_lock_order.sql` 是其後續 forward migration，先取得品號互斥鎖再鎖補庫來源單，避免補庫 POST 與送出／取消並行時形成反向鎖序。正式 Supabase project 尚未套用 0097 前，請勿以本機測試代替並行交易驗收。

2026-09-18 正式站人資請領流程已完成一筆端到端交易驗收：人資建立並送出需求後，查詢畫面可讀取需求與預留；倉庫建立發貨草稿並成功 POST；POST 後待發貨清單為 0，需求為 `SHIPPED`、發貨為 `POSTED`、有效預留為 0，兩倉庫存畫面與資料庫讀回一致。此次驗收保留正式交易與稽核紀錄，未另外建立退回交易。

## 正式應用接手狀態（2026-09-21）

正式 Next.js 應用已部署至 [uniform-co.vercel.app](https://uniform-co.vercel.app/)，程式碼由 GitHub `Kevin72333/uniform-co` 的 `main` 分支提供，資料與登入由 Supabase project 提供。正式操作必須先登入；未設定 Supabase env 或未有有效 session 時只顯示登入／設定畫面，不載入工作區資料。

### 2026-09-21 repository-local 最新快照

目前版本庫內能以程式、migration、測試與文件完成的安全防線已收尾；這不等於 production cutover 已通過。下一位 AI agent 接手時，先讀 [`agents.md`](./agents.md)，再執行 `git status --short` 與 `git log -5 --oneline`。目前工作樹保留使用者既有的 `package.json`／`package-lock.json` 修改與未追蹤 `prototype/`；除非需求明確指向這些項目，否則不要納入提交。使用者已要求每次修改驗證完成後自動推送 GitHub，推送前須 fetch／比較 `origin/main` 並只 stage 本次檔案。

目前唯讀操作的共通原則是：資料讀取可在既有快照上背景重試，不把 `dataLoading` 當成 mutation busy。耐久匯入的「重新查詢批次」也沿用此原則，按鈕在讀取期間仍可再次觸發；最新讀取 token 與手動重查序號會丟棄晚到結果，只有「確認後匯入」仍等待完整逐列差異。匯入逐列預覽只在 `VALIDATED`／`FAILED` 載入；`APPLYING`／`APPLIED` 輪詢只更新批次狀態，不再每 2.5 秒重載最多 10,000 列及差異；預覽統計每份快照只掃描一次，仍計算完整未確認差異數並只顯示前 10 筆，後端逐列 APPLY 防線不變。這只改善自助恢復與操作回饋，不代表 Supabase migration、Edge Function、Storage/RLS 或正式 cutover 已完成。

2026-09-20 公開匿名 HTTP 取樣（各 5 次）中，`/app`、`/login`、`/api/sso-health` 的回應中位數約 101／109／98 ms；`/` 中位數約 165 ms 並導向 `/app`。單次約 1.68 秒的首頁慢樣本未能重現；這是 HTTP 量測，不是瀏覽器 FCP、登入後資料庫查詢或真實使用者 RUM，不能據此推定已登入工作區延遲已解決。

2026-09-21 以 linked target Supabase project 重跑最新版 `supabase/manual/verify-application-read-models.sql` 唯讀正式查核，結果與 9/20 相同：source relations `47/47`、repair prerequisites base functions `28/28` 均就緒；security-invoker views `0/19`、read indexes `0/24`、authenticated callable workflow RPCs `0/13`，`v_overview_core.account_id` 尚未啟用，仍有 6 個冗餘索引。正式 UI 因此仍會走較多查詢／RPC fallback，部分工作流目前依賴舊路徑；新版程式部署本身不會建立這些 DB objects。修復 bundle 已涵蓋 migrations `0099`–`0132`，含 prerequisite／postflight 與單一 schema-only transaction；正式執行前仍須先在隔離 staging 驗證，並安排低流量維護時段。SQL Editor 不會自動對帳 `schema_migrations`，完成實際 schema 與 migration ledger reconciliation 前，不可對正式環境執行 `supabase db push`。目前只完成唯讀查核，未對正式資料庫套用修復。

入庫與退回的來源明細也遵循相同的狀態邊界：清空或切換來源時立即清除舊明細並釋放明細讀取狀態，避免被已取消的相依查詢永久卡在載入中；新來源的讀取再由 effect 重新接手。這不會放寬交易來源、POST、RLS 或冪等驗證。

盤點帳面餘額的讀取狀態則綁定目前倉別與有效畫面範圍；切換倉別／帳號或離開工作區後，已取消的舊查詢不會把 loading 留在新畫面。尚未取得與目前倉別相符的餘額快照時，新增／送出仍會安全停用，不會放寬盤點 RPC、帳面版本或 RLS 防線。

退回面板在同帳號已有需求快照時，背景刷新不再鎖住「已發貨需求」選擇器；相依發放明細會隨選擇重新載入。退回原因碼也綁定目前帳號：同帳號快照可在背景更新時繼續選用，首次載入／帳號不符／權限失效時隱藏並停止新建；建立退回草稿仍由資料庫 RPC 重驗原因碼是否啟用。建立／完成仍等待必要來源與明細，權限與庫存正確性防線不變。

目前 repository-local 完整驗證（2026-09-21）為 181 個 Vitest files、770/770 tests 通過，另有 production read-model generator 的 6 個 Node tests 通過；`npm run lint`、`npm run typecheck`、`npm run build` 與 `git diff --check` 本輪均通過。資料庫修復產生器與唯讀 verifier 現已涵蓋 migrations `0099`–`0132`、19 個 views、24 個 indexes、13 個 app-facing workflow RPCs 及 28 個 prerequisite functions，並一併檢查 `v_overview_core.account_id`；CI 直接執行 Node generator tests，防止來源 migration 與手動 SQL 產物漂移。正式 Supabase schema／migration ledger 對帳及修復 SQL staging 驗收仍待維運流程完成。登入路由此次改由輕量 `AuthLanding` 呈現，不再載入整個 `WorkspaceShell`；Supabase browser SDK 延遲至帳號欄位取得焦點才載入，本機 build `/login` First Load JS 為 107 kB，bundle budget 為 362,279 bytes／5 chunks（修改前 653,322 bytes）。這是 bundle 尺寸量測，不代表正式站 FCP 已驗收。PDF／ERP 匯出恢復會先查已保存的 artifact／batch ID，只有查不到才回退到同一筆冪等鍵，減少返回頁面或重整時的重複請求；ERP 機構選擇現在沿用帳號範圍快照，同帳號背景刷新不再鎖住建立批次，切換帳號時舊機構選項不會沿用。帳號／角色、匯入錯誤列、ERP 輪詢、耐久匯入與各類更正恢復也共用一次性 session retry／可重試輪詢 seam。原子交易 RPC 的部署缺漏現在共用每個 Supabase client／RPC 60 秒的負向能力快取，避免每次操作都重打一趟確定不存在的 RPC；僅明確缺少函式才採舊流程，網路、權限與交易結果未知仍保留冪等保護。理貨相容路徑只保存確實變動的明細並確認資料庫回傳列 ID；HR 發貨 read-view 缺漏時優先用複合外鍵 embedded read 降為一次查詢，僅關聯解析失敗才保留舊雙查詢。理貨完成另驗證回傳單號與終態，避免把不完整回應當成功。這些是前端往返最佳化，不會移除後端冪等、RLS 或稽核防線。

- Durable import 同時支援受控常駐 worker 與 Supabase Edge serverless adapter：`supabase/functions/import-worker` 會由登入頁面上傳後按需觸發，使用同一個 `job_import_worker` actor、RPC、lease、idempotency 與 Storage／SHA-256 邊界，不需要維持 worker 主機；Edge 每次請求最多連續處理四個同階段 chunk，並在同一請求內重用解析預覽，前台每次先觸發 Edge 再立即讀回狀態，輪詢間隔降為 2.5 秒，但不改變資料庫 lease／cursor／APPLY fencing。`npm run import:worker -- --once` 仍可供受保護 staging smoke，移除 `--once` 則持續輪詢。前台支援上傳衝突自動續傳（409 conflict 視為已存在並接續驗證）、worker 觸發後立即讀回批次狀態、友善中文狀態標籤與確認後立即執行 APPLY；若已進入 `VALIDATED`，直接顯示預覽確認，不再讓使用者只看到「正在準備」。Edge 部署設定見 [`docs/deployment/edge-import.md`](./docs/deployment/edge-import.md)；推送 repository 不代表 Supabase Function 已自動部署。
- 耐久匯入的取消理由不再在一般處理畫面常駐；只有按下「取消批次」才展開取消欄位，取消 RPC、冪等鍵、固定 Storage object 與清理政策不變。
- 耐久匯入的處理狀態改與 PDF／ERP artifact 共用 `useWorkflowStatusPoll`；仍維持 2.5 秒串行觸發 Edge／讀回批次，遇到暫時例外會在下一個間隔重試，進入 `VALIDATED` 或終態即停止，避免各面板各自維護容易卡住的輪詢迴圈。
- 一般 CSV／XLSX 選取後會立即開始建立批次、直傳與檔案檢查，範例檔仍須先完成 disposable staging 確認；正式資料套用前的「確認後匯入」不變，恢復同一批次時仍沿用原檔案與冪等鍵。
- Storage cleanup 已由 `0071_storage_cleanup_contract.sql`／`0072_import_terminal_retention.sql` 提供 DB 權威 eligibility、24 小時下限、FAILED／CANCELLED import 90 天 terminal retention、append-only cleanup audit，以及 fail-closed dry-run／execute runner。每日 workflow 目前只 dry-run；destructive cron 尚未核准啟用。
- Import staging payload retention 已由 `0073_import_staging_audit_minimization.sql`／`0074_import_staging_payload_retention.sql` 分離永久 evidence 與可清除 payload；`job_import_retention` 只 scrub 已 terminal 90 天的 `raw_values`／`normalized_values`／`validation_errors`，保留 batch／row shell／chunk／diff evidence，設定 `staging_purged_at` 後禁止 restart。每日 workflow 同樣只 dry-run。
- 備份／還原已補齊 generation manifest lock、來源檔穩定性、run-id/path 防線、DB/Auth/Storage 分階段完整性、明文 offsite handoff 阻擋、空目標 preflight、Auth users／identities／MFA count 驗證與八個關鍵 application table count 驗證。Storage restore 除本地 bytes／SHA-256 外，每個 POST 2xx 後都會從目標 private Storage GET read-back，再核對 byte length 與 SHA-256；任何 drift、409 conflict 或 read-back 失敗都 fail closed。
- Staging preflight／read-only smoke／disposable active smoke／renderer smoke harness 已在版本庫內；PDF／ERP smoke adapter、Storage proxy、lease/generation/key fencing 與 response-loss recovery contract 已具備，但真實 Supabase Auth／RLS／Storage／signed URL／並行 SQL evidence 仍需受保護 staging 執行。
- Error monitoring 已有 Next.js `instrumentation.ts`、server-side 結構化最小事件與通用 `src/app/error.tsx`；事件刻意不記錄 raw error message、stack、request body、header、cookie、token、query 或 DB URL。正式外部 monitoring provider、alert 與 incident smoke 尚未完成。
- 三年容量已有 fail-closed `npm run capacity:plan` 與 60%／70%／85% gate；模型估算不能代替 `STAGING_SYNTHETIC` 實測，未有真實三年資料／檔案、尖峰效能、備份還原及 quota 證據時保持 `NOT_VALIDATED`。
- Production release 已集中到 17 個 gate 的 `npm run deployment:release-gate`；正式 evidence 使用 ignored 的 `docs/deployment/onboarding/private/release-evidence.json`，由 `npm run deployment:release-evidence` 初始化／record／block。版本化 template 永遠是 `NOT_READY`，repository-local 測試成功不能自動轉成 production evidence。
- 商品管理採獨立清單、商品表單、供應商／MOQ 與匯入／匯出頁籤：清單支援分類、搜尋、狀態、排序、分頁及逐列編輯／停用／刪除；新增、修改與停用走單列 `apply_master_import`，刪除走 `delete_uniform_item`，有庫存餘額或庫存流水時拒絕硬刪除，無庫存但仍有其他業務關聯時也由外鍵安全阻擋。`0077_uniform_item_manager_read_inactive.sql` 套用後，HR 可在清單檢視停用品號並重新啟用；`0080_master_data_system_admin_access.sql` 套用後，SYSTEM_ADMIN 也可完整維護與讀取主檔；`0085_uniform_item_delete.sql` 套用後才會啟用商品刪除按鈕的正式 RPC。
- 組織主檔採機構／部門合併清單、獨立新增／修改／停用表單與匯入／匯出頁籤；清單支援類型、搜尋、狀態、排序與分頁，保存沿用 `apply_master_import`。部門表單會同時送出目前機構 UUID 與代碼，`0087_department_parent_resolution.sql` 套用後由 RPC 以已啟用且代碼一致的機構解析 `institution_id`，避免空父鍵寫入。`0078_organization_manager_read_inactive.sql` 套用後，HR 可檢視停用資料並重新啟用。
- 商品與組織清單的唯讀刷新使用獨立 `dataLoading`；已有資料時保留快照、搜尋與篩選不因重新查詢而清空，重新整理會防止重複請求，並以 `aria-busy`／`aria-live` 呈現讀取狀態，不再把主檔讀取誤當成 mutation `busy`。
- 員工編輯器的既有歸屬代碼不再因機構／部門選項背景讀取而鎖住選單；只有新增且尚未填入機構時才等待必要選項，姓名、職稱、日期與備註仍可先編輯，最終保存仍由 `save_employee_master` RPC 驗證機構／部門關聯。
- 員工主檔已從人資更正中獨立為清單／表單與批次匯入工作台；清單支援搜尋、機構／狀態篩選、排序、分頁、逐列編輯／停用與稽核 CSV 匯出，完整表單可維護歸屬、職稱、到離職日與備註。`0079_employee_master_management.sql` 套用後，單筆保存與匯出才會啟用。
- 庫存管理已集中為兩倉可用量、期初庫存耐久匯入、發貨／盤點／採購入庫／更正操作入口、庫存／流水 CSV 匯出與本機規則試算；兩倉清單支援商品分類／庫存狀態篩選、數量排序、摘要、欄位設定、密度及完整分頁。`0076_inventory_report_export_audit.sql` 只記錄匯出 metadata，庫存數字仍由流水與 view 推導。
- 兩倉可用量清單的成功快照現在綁定目前 `accountId`；切換帳號或不可恢復的權限／Schema 讀取錯誤時先隱藏舊庫存摘要與列，暫時 JWT 同步錯誤仍保留上次成功快照。篩選、排序、分頁與 `v_item_availability` 讀取契約不變。
- 倉庫發貨清單現在只在目前理貨明細有未保存的數量／短發原因變更時阻止切換；已載入但未修改的草稿可直接切換到其他需求，回來仍可由同一草稿恢復。重新整理在進行中的草稿或未保存變更時仍停用，避免清單刷新造成來源與編輯器不一致。
- 倉庫處理 HR 發貨時，若尚未有理貨草稿，主要操作可一次完成「建立並完成發貨」；需要先核對或調整數量時仍可單獨建立草稿。補庫單送出後也能在同一畫面直接建立下一筆，連續作業不必切換工作區。
- HR 發貨若已載入可編輯草稿，`0114_warehouse_post_with_lines.sql` 讓明細更新與 `post_warehouse_shipment` 在同一個伺服器交易完成；前端不再為每筆明細各發一次 UPDATE。未套用 0114 的 project 會暫時 fallback 到既有明細更新流程，但只更新相對保存快照確有變動的列，並確認 `UPDATE ... RETURNING id` 後才 POST；新建且未修改的草稿直接 POST，不逐列重寫。
- 庫存盤點的「確認並完成」優先使用 `complete_stocktake`，在單一資料庫交易內委派既有建立／更新與 `post_stocktake`，把原本的草稿寫入、明細讀回與 POST 串行往返收斂為一次 RPC；角色、稽核、冪等、預留衝突與 balance-version fencing 仍由既有 RPC 負責。`0127_atomic_stocktake_completion.sql` 尚未套用時，只在 PostgREST 明確回報該函式不存在後使用相容舊流程，並快取缺少此 RPC 的能力結果；若回應未知，畫面鎖住同一份輸入，只能以同一組冪等鍵重試。「先建立盤點草稿」、「保存盤點草稿」與 `STALE_COUNT` 重盤仍保留。`0113_stocktake_server_recapture.sql` 維持伺服器端重盤；Git／Vercel 部署不會代替 Supabase migration。
- 人資需求單的新建／草稿修改後送出，優先以 `submit_hr_request_with_lines` 在同一資料庫交易內呼叫既有草稿 RPC 與 `submit_hr_request`，將兩次串行 client 往返降為一次；庫存鎖定、可用量重算、reservation、稽核與冪等仍由既有函式執行。只有明確缺少新 RPC 才回退舊流程並快取能力；結果未知時保留同一輸入／冪等鍵、暫鎖欄位供重試。`0128_atomic_hr_request_submission.sql` 尚須由既有 Supabase migration workflow 套用；Git／Vercel 部署不會更新資料庫。正式單據修改仍使用既有單一 `update_hr_request` RPC。
- 補庫新建／既有草稿修改後送出，優先以 `submit_replenishment_request_with_lines` 在同一資料庫交易委派既有 create/update 與 `submit_replenishment_request`，將兩次串行 RPC 往返降為一次；HR 權限、品號鎖定、資料驗證、稽核與冪等仍由既有函式執行。只有明確缺少新 RPC 才回退相容舊流程並快取能力；結果未知時鎖住原輸入，使用同一組冪等鍵確認結果。`0130_atomic_replenishment_submission.sql` 尚須依既有 Supabase migration workflow 套用；Git／Vercel 部署不會更新資料庫。
- 五個庫存更正面板的「確認並完成」改優先呼叫 `complete_*_correction` 原子 wrapper，以單一資料庫交易委派既有建立草稿與 POST RPC，將兩次串行往返降為一次；角色、來源驗證、鎖定、稽核、冪等與不可變 POST 邊界仍由原 RPC 負責。只在明確缺少 wrapper 時回退舊流程；未知結果保留同一組操作鍵與可重建、且不含表單內容的 POST 指紋。結果查詢若確認沒有建立更正，會清除過期暫存並解鎖表單。`0131_atomic_correction_completion.sql` 尚未套用時不會啟用單次往返，Git／Vercel 部署不會更新 Supabase。
- 營運報表的九張 security-invoker view 已集中到 `reporting-catalog` 顯示 seam：正式畫面使用對應中文欄名與常用狀態，並支援報表說明、即時搜尋、欄位排序、欄位顯示、密度、25／50／100 筆完整分頁及重新整理；報表讀取遇到暫時 JWT 不同步時沿用共用 session retry，切換報表期間保留上一份欄位一致的成功快照，直到新報表成功讀回，不把舊資料套到新欄位。原始 view 欄位與 RLS 不變。維護規則見 [`docs/architecture/reporting-catalog.md`](./docs/architecture/reporting-catalog.md)。
- 營運報表的成功快照也綁定目前 `accountId`；同一帳號切換報表時仍保留上一份完整結果，切換帳號、首次未完成讀取或權限／Schema 失敗時隱藏舊列，避免跨帳號顯示報表資料。報表欄位 allowlist、security-invoker view 與讀取權限不變。
- `ModuleWorkbench` 已成為正式 UI 的子功能 seam：商品、組織、帳號、庫存、人資需求／更正、倉庫盤點、採購決策／入庫、換季活動與正式文件都使用一致的工具列與任務頁籤。下層 `RetainedPanelSet` 同時管理七個 workspace、workspace module 與工作台子頁籤：預設首次開啟才掛載，之後保留未送出的 panel 狀態，避免未造訪模組在登入時同步查詢 Supabase。完整盤點、mount policy 與不拆分理由見 [`docs/architecture/module-workbench.md`](./docs/architecture/module-workbench.md)。
- 帳號管理的清單／新增／設定分頁現在也經由 `RetainedPanelSet` 按需掛載；未造訪的表格與大型表單不再只是用 `hidden` 留在 DOM，已訪問分頁仍保留草稿狀態，切回時不必重建資料。契約測試見 `src/domain/account-admin-workbench-contract.test.ts`。
- 隱藏頁籤讀取 gate 已套用到 17 個保留型資料 panel：`usePanelActivity()` 會在保留未送出表單狀態的同時，停止隱藏 panel 的 Supabase 查詢、恢復讀取與 workflow event refresh；重新切回可見時才重新載入。契約測試見 `src/domain/retained-query-panel-contract.test.ts`，不得只依賴 `hidden` 屬性阻止背景讀取。
- 工作區載入已切成兩層 `next/dynamic` seam：`WorkspaceShell` 只載入目前使用中的 workspace；各 `*Workspace.tsx` 再讓次要面板於第一次切換時載入，主要入口維持立即可操作。左側工作區按鈕在使用者 pointer 指向或鍵盤聚焦時，會只預取該工作區 chunk，讓明確意圖先暖好程式碼但不提前查資料；未造訪的商品、庫存、報表與匯入模組不會先進入 `/app` 首屏 bundle，切換期間由 workspace／panel 共用的 `WorkspacePanelLoading` 顯示簡潔骨架與可及載入狀態，不再呈現 lazy-loading 實作細節，並支援 `prefers-reduced-motion`。repository build 的 `/app` First Load JS 目前為 187 kB，workspace chunk 約 20–39 kB；這是 bundle 基準，不取代正式瀏覽器 RUM。
- 主檔讀取已收斂到 `src/lib/master-data-cache.ts`：商品、組織與員工清單／編輯器、員工匯入、換季活動、帳號管理與採購決策共用同一登入 client 的進行中查詢與 30 秒短 TTL；商品／組織／員工 catalog、editor 與整批主檔面板的讀取及保存入口也先通過 `useWorkspaceSession` identity readiness，避免登入初期只因 browser client 已建立就發出受保護請求。採購決策的供應商／MOQ／差異原因碼也由同一個 procurement option adapter 提供，換季活動只讀在職員工的最小選項欄位，主檔保存／批次套用後明確失效。權限或 Schema 讀取失敗不會被快取，避免錯誤狀態卡住後續重試；機構、商品與員工的穩定清單讀取也統一經過單次 session refresh/retry。人資請領仍保留一次 session refresh/retry，避免快取遮蔽登入同步問題。
- 人資請領的選項讀取也已收斂到同一個 `loadHrRequestMasterData` seam：套用 `0104_hr_request_option_views.sql` 時，兩個 security-invoker view 提供符合啟用隸屬規則的員工，以及含目前兩倉可用量快照的啟用品號，正常路徑只需兩組查詢。若正式 DB 尚無指定 view，只有明確的 `PGRST205`／`42P01` missing-view 回應才退回既有 RLS 保護的主檔／`v_item_availability` 查詢，權限錯誤仍 fail-closed；負向 capability 最多快取 30 秒並自動重新探測。主檔保存／停用／匯入會一併失效請領選項快取，送出 RPC 仍會在交易內重新驗證數量。
- 調撥更正的初始來源清單改由 `0105_warehouse_transfer_correction_source_view.sql` 的 `v_warehouse_transfer_correction_sources` 一次提供已完成發貨／補庫明細；瀏覽器不再先查兩種來源單、再查兩種明細並自行合併，降低切換面板時的往返與等待。更正建立、過帳、鎖定、歷史查詢與 RLS 仍維持原 RPC／資料表契約。
- 盤點更正的初始來源清單改由 `0106_stocktake_correction_source_view.sql` 的 `v_stocktake_correction_sources` 一次提供啟用倉庫的已完成盤點明細；瀏覽器不再分段查盤點單、倉庫與明細。前端仍依 HR／WAREHOUSE 角色篩選可操作倉別，盤點更正過帳與版本 fencing 不變。
- 入庫更正與退回更正的初始來源清單改由 `0107_receipt_return_correction_source_views.sql` 的兩個 security-invoker view 一次提供已完成主單與明細；瀏覽器不再先查主單、再查明細並維持兩組相依狀態。更正 RPC、歷史查詢與不可變交易規則不變。
- 人資發放更正的初始來源清單改由 `0108_hr_issue_correction_source_view.sql` 的 `v_hr_issue_correction_sources` 一次提供已發放需求與明細；瀏覽器不再先查需求、再查發放明細並以 `find()` 組合。更正 RPC、歷史查詢、庫存重算與稽核規則不變。
- 五個更正工作台的來源查詢使用獨立 `dataLoading`、`sourceSnapshotReady` 與 `aria-live` 狀態；首次尚未取得來源時只鎖定來源選擇與提交，不鎖住單號／差額／原因欄位，已有完整來源快照的背景刷新也不會阻塞目前操作。暫時 JWT 同步錯誤保留快照並提示重試，權限／Schema 錯誤則清空快照並 fail-closed；更正建立、過帳、冪等鍵與歷史讀取契約不變。
- 換季採購決策的核准品項與既有決策改由 `0109_seasonal_procurement_queue_view.sql` 的 `v_seasonal_procurement_queue` 一次提供；供應商／MOQ／差異原因碼仍走共用採購主檔快取，採購決策與建立採購單 RPC 不變。右側工作區只在使用者按「選取」後載入；刷新後若原品項已不在佇列，會清空過期的供應商／採購欄位，不自動改選第一筆。
- 換季採購編輯器將成功讀回的核准品項、供應商、MOQ、差異原因碼與既有決策快照綁定目前帳號；同一帳號背景刷新時保留使用者正在輸入的 draft，只有品項／供應商失效或外部決策版本改變才校正欄位。切換帳號、首次尚未取得快照或讀取權限／Schema 失敗時，先隱藏舊快照並停止保存，避免誤用上一個帳號的採購資料。
- 換季需求登記的活動員工、活動品號與既有需求改由 `0110_seasonal_demand_workspace_view.sql` 的 tagged `v_seasonal_demand_workspace` 一次提供；以 `UNION ALL` 避免員工×品號笛卡兒積，前端只做類型分流，需求保存仍走原 `upsert_seasonal_demand_line` RPC。
- 換季需求編輯器將讀取鎖縮小到真正依賴最新 scope 的員工／品號選擇與送出；背景載入時仍可切換活動、清除表單及編輯數量／備註，活動切換會以讀取序號丟棄舊回應，避免非同步查詢覆蓋目前編輯內容。保存仍在 `dataLoading` 期間停用，確保送出使用完整且最新的選項快照。
- CEO 換季審核的 PENDING 版本與活動名稱改由 `0111_seasonal_approval_queue_view.sql` 的 `v_seasonal_approval_queue` 一次提供；審核明細仍在選取後載入，首次讀取與刷新不自動標記第一筆，核准／退回仍重驗 revision、snapshot hash 與既有 RPC。已有待核快照時，背景刷新不再鎖住清單選取或清空目前仍存在的明細；快照現在也綁定目前 `accountId`，切換帳號、首次尚未完成讀取或權限／Schema 錯誤時會隱藏舊待核版本並停止審核，避免誤用上一個帳號的核准資料。
- 人資需求查詢的選取明細改由 `0112_hr_request_history_detail_view.sql` 的 tagged `v_hr_request_history_detail` 一次提供品號彙總、員工發放與預留紀錄；不做三組瀏覽器查詢或笛卡兒積，唯讀明細與既有取消／發貨流程不變。
- 人資需求查詢刷新時保留既有清單與同一需求的明細快照；清單／明細各自使用讀取序號 fencing，快速切換需求或工作流事件不會讓較慢的舊回應覆蓋新資料。身份失效、權限或 schema 錯誤仍安全清空，短暫 Session 同步錯誤則提供重試提示。
- 人資需求查詢清單的成功快照現在綁定目前 `accountId`；同一帳號的暫時 JWT 同步錯誤可保留既有清單，切換帳號、首次尚未完成讀取或權限／Schema 失敗時隱藏舊清單並停止明細讀取。首次載入不再自動選取第一張需求單，因此不會為了首屏額外查詢明細；使用者明確選取後才讀取 `v_hr_request_history_detail`。
- 人資需求表單重新取得主檔／庫存時只補足空白表單的第一筆預設值，不會覆蓋使用者正在編輯的員工明細與增庫量；同一帳號已有完整員工／品號快照時，暫時 JWT 同步錯誤只顯示背景同步提示並保留草稿，初次載入、帳號切換或非暫時性錯誤才停止送出。
- 人資需求表單在主檔／庫存讀取失敗時提供同面板「重新載入資料」按鈕；重試只重新執行目前的讀取 seam，不需整頁刷新，且沿用草稿保留規則，避免使用者為了恢復資料而遺失已填內容。
- 人資需求表單重新整理資料時保留目前仍可用的員工／品號選項、已填明細與增庫量；同一帳號背景刷新不再因 `loadingData` 鎖住送出，只有沒有可用快照、帳號切換或權限／Schema 錯誤才 fail-closed 並提供重試。
- 人資需求表單在刷新主檔快照時仍可編輯日期、備註、既有明細與增庫量；送出 RPC 仍在伺服器端重新鎖定／重算庫存，既有「已送出且尚未進入修改」狀態維持唯讀，避免低風險讀取把輸入整段卡住。
- 商品、組織、員工與兩倉庫存清單沿用 `src/domain/read-refresh.ts` 的快照規則：短暫 JWT 同步失敗時保留上次可用資料並提示重新整理，權限／schema／資料錯誤仍清空並安全失敗，避免畫面在正常重試期間閃成空清單，也不會以 stale rows 掩蓋權限撤銷。
- Supabase 讀取 retry adapter 以每個登入 client 的 in-flight refresh flight 去重並行 `auth.refreshSession()`；多個 panel 同時遇到暫時 JWT 不同步時共用一次刷新後再各自重試，權限／Schema 錯誤不會被誤當成 session refresh。
- 人資需求送出後會在同一畫面提供「建立下一筆需求」，保留原單據與預留結果不變，直接重設為乾淨的新增表單，不必手動清空欄位或切換工作區。
- 換季活動、需求窗口、CEO 待核與採購決策四個面板都提供同面板重新載入；直接資料查詢沿用 `retrySupabaseQueriesAfterSessionRefresh`，重試會保留目前活動／需求列／核准品項選取，不因 JWT 暫時不同步而要求整頁刷新。CEO 待核與採購決策已有完整快照時，刷新期間仍可選取清單列；採購決策若正在編輯供應商、採購量或採購單欄位，背景成功刷新只更新唯讀選項與版本，會保留目前 draft，只有品項消失或外部決策版本改變才重新校正表單。非暫時性讀取錯誤會清除不可再信任的快照，避免畫面卡住或誤用舊資料。活動主檔仍透過 `master-data-cache` 的既有選項 adapter 讀取，沒有新增第二套 Session refresh 機制。
- 營運總覽保留核心摘要優先與活動摘要延後的讀取順序；初次載入與局部 workflow／庫存事件都經由 `loadOverviewCore` 一次取得核心摘要，局部刷新只投影本次 scope 需要的 JSON 欄位，0118 尚未套用時只 fallback 本次 scope 所需的舊 view，活動／稽核仍經過共用 session retry 背景補齊，並提供「重新整理總覽」而不需要整頁刷新。
- 入庫、退回與盤點在正式 POSTED 後保留不可修改的完成紀錄，但同一個 panel 立即提供「處理下一筆／建立下一張盤點」；前端會清除表單草稿與操作冪等鍵，盤點則保留目前倉別並產生新的單號，不必離開頁籤或重新整理才能繼續作業。契約測試集中在 `src/domain/warehouse-operation-contract.test.ts`。
- 採購入庫在到貨／合格／拒收數量已平衡且必要欄位完整時，「確認並完成入庫」優先使用 `complete_purchase_receipt` 單一 RPC，在同一資料庫交易內依 item→PO 鎖序委派既有冪等草稿建立與 POST，省下一次瀏覽器往返；資料尚未完整時仍可使用「先保存入庫草稿」，不移除分批到貨、稽核與 POSTED 鎖定防線。`0126_atomic_purchase_receipt_completion.sql` 尚未套用的 project 只在明確回報新函式不存在時使用舊雙 RPC 相容流程；Git／Vercel 部署不會代替 Supabase migration。
- 制服退回在已選擇發放明細、退回單號、原因與數量完整時，優先以 `complete_return_note` 單一 transaction RPC 委派既有冪等草稿建立與退回 POST，省下一次瀏覽器往返；若 `0132_atomic_return_completion.sql` 尚未套用，僅在明確確認函式不存在時相容回退舊流程，未知結果不會再開第二條寫入。資料尚未完整時仍可先保存退回草稿，POSTED 鎖定、原發放明細／庫存鎖與稽核防線不變；套用 SQL 後重新載入網站，讓目前分頁重新探測 RPC。
- 人資發放、退回、採購入庫、倉庫調撥與盤點更正，在來源明細、單號、差額與理由完整時都提供「確認並完成」的一鍵路徑；仍保留「先建立更正草稿」及結果未知後沿用同一冪等鍵重試，已 POSTED 更正不可修改。
- 補庫、盤點、盤點更正、換季活動與 ERP 匯出共用 `loadActiveItemOptions`、`loadActiveWarehouseOptions`、`loadActiveInstitutionOptions`；穩定選項以同一登入 client 去重並短暫快取，主檔異動會失效對應快取，庫存餘額與正式過帳仍維持即時／受保護流程。
- 帳號管理的保存／狀態／角色／範圍異動會直接套用 server-side 已重新查核的結果到目前清單，不再每次成功後重新查詢帳號、角色、範圍、機構與部門五組資料；`src/domain/account-admin-local-state.ts` 保持角色與範圍同步規則純函式化，手動重新整理仍保留完整讀取入口。
- 帳號管理首次進入只讀取 `app_accounts`／`user_roles` 建立清單；`coordinator_scopes` 與機構／部門選項延後到選取帳號並進入「帳號設定」時才載入。兩組設定資料各自顯示讀取狀態：已有機構／部門快照時，背景重讀不鎖選項或窗口設定；保存只等待目前帳號的 scope 讀取完成，不必等無關的機構／部門重讀。首次尚無有效選項時，才停用相依選擇與保存並保留同頁狀態。這些受保護讀取還會先等待 `useWorkspaceSession` 的唯一帳號身份，窗口範圍查詢固定以目前選取的 `account_id` 過濾，不再把所有帳號的 scope 一次載入瀏覽器。
- 帳號管理的兩組低頻設定查詢共用遞增序號，只採用目前選取帳號的最新回應，避免快速切換帳號時舊 scope／機構／部門結果覆蓋新表單；`directoryLoading`、`scopeDataLoading` 與 `organizationOptionsLoading` 各自管理其讀取狀態，避免互不相依的選項刷新延後窗口操作。
- 換季活動重新載入選項時保留使用者已選的員工／品號範圍，只移除已失效的選項；首次載入才預設全選，且以讀取序號丟棄較慢的舊回應。ERP 匯出則將機構選項讀取與 artifact 狀態查詢拆成兩個 read seam，讀取機構時仍可先填發放日期，查詢 artifact 狀態時不會把未相關的建立批次流程誤判為同一個 loading 狀態。
- 倉庫待發貨清單改由 `0103_warehouse_shipment_queue_view.sql` 的 security-invoker view 合併人資需求、補庫單與既有草稿；前端由原本四組併行查詢降為清單 view＋短發原因碼兩組查詢，明細載入、冪等鍵、庫存鎖序與正式過帳不變。此 migration 必須依既有 Supabase workflow 套用，Git push 不會自動更新資料庫。
- 若 `v_warehouse_shipment_queue` 尚未部署，`src/lib/warehouse-shipment-queue-read.ts` 會在明確 missing-view 時改讀受 RLS 保護的需求／補庫來源，優先透過發貨外鍵同查草稿；只有 PostgREST 關聯 metadata 缺漏才分開查 draft shipment。權限或其他 schema 錯誤不 fallback，任何一個來源失敗也不顯示部分清單。2026-09-21 唯讀 verifier 仍顯示 19 個 read-model view 全缺，因此此 fallback 是目前正式資料庫的相容路徑；套用 migration 後回到單 view 讀取。
- 總覽儀表板改用可合併的局部刷新：初次進入才讀取全部摘要，庫存異動與人資需求／發貨異動依 scope 從 `v_overview_core` 取得核心摘要，且只投影本次 scope 需要的 JSON 欄位，活動／稽核背景補齊；同一操作同時發出兩類事件時合併成一次讀取，避免資料過期或重複查詢六張 reporting view。0118 尚未套用時的 fallback 也只執行本次 scope 需要的舊 view。
- 總覽儀表板再分成 `overviewReadPlanForScope` 的核心／延後讀取：待辦、可用量、發貨與入庫先完成首屏摘要，發放歷史與稽核活動在背景補齊；活動摘要載入中會明確顯示，不讓低優先 reporting view 阻塞使用者開始工作。
- 總覽摘要快照現在綁定目前 `accountId`；帳號切換或身份重新就緒時會強制完整讀取，切換期間先隱藏上一個帳號的數字與工作佇列。同一帳號的暫時 JWT 同步錯誤保留既有摘要並顯示可重試提示，權限／Schema 錯誤仍清除失效來源；不改變既有 reporting view、RLS 或事件刷新 scope。
- 工作區 Session 讀取已與短效 JWT 更新解耦：`useWorkspaceIdentity` 只以穩定的 Auth user id 查詢 `app_accounts`／角色，庫存、需求、倉庫、更正與 durable import panel 不再因每次 access token rotation 重新執行整批讀取；真正的登入／登出、身份變更、面板重新整理與 workflow event 仍會觸發必要更新，單次查詢仍保留 session sync retry。
- 退回作業的原因碼只在面板啟用時讀取一次，選擇不同原因不會重複查詢 `return_reason_codes`；讀取失敗會提供可理解的重新整理提示。
- 本輪讀取效能整理：`RetainedPanelSet` 的 `PanelActivityContext` 會讓已隱藏但保留狀態的頁籤停止事件刷新與背景查詢；`HrRequestWorkbench` 優先透過 `0104_hr_request_option_views.sql` 以兩組查詢取得員工／品號與即時庫存快照，唯讀查核確認正式 DB 尚無這兩個 view 時，程式只在明確 missing-view 回應下改走既有 RLS 主檔／`v_item_availability` fallback，權限錯誤仍 fail-closed；需求查詢改用 `0099_hr_request_history_view.sql` 的 security-invoker view，一次取得需求、發貨與有效預留摘要，明細仍在選取單據後才載入；`0100_reporting_join_indexes.sql` 補上可用量、請領明細、採購入庫與稽核活動 feed 的反向／聚合 join 索引，`0101_transaction_read_indexes.sql` 補上入庫／退回／更正工作台實際使用的狀態與來源索引，`0102_correction_history_read_indexes.sql` 補上人資／盤點／調撥更正歷史的來源索引，`0115_sso_account_email_read_index.sql` 補上本地 SSO email 對應索引，`0116_correction_history_view.sql` 再以單一 security-invoker view 統一五個更正模組的六種來源明細讀取，前端由 `loadCorrectionHistory` 優先一次查完；migration 尚未套用時，先透過來源專屬複合外鍵將更正主單與明細合成一次 embedded read，只有 PostgREST 關聯快取缺漏才退回舊兩段查詢。總覽最近活動也固定依時間排序。這些 migration 的索引／view 必須依既有 Supabase migration workflow 套用，repository push 不等於正式資料庫已更新。
- 狀態與資料傳輸也已收斂：`src/domain/workflow-status.ts` 統一把內部狀態轉成中文操作語言；PDF／ERP／員工匯入不再把 raw error 或 `PREPARING`／artifact 等內部術語直接顯示；報表與庫存歷史匯出依 `reporting-catalog` 欄位白名單查詢，不再使用 `select("*")`。此調整不移除冪等、稽核、RLS 或正式過帳防線。
- 非同步檔案狀態已改為可見頁籤自動更新：`src/app/use-workflow-status-poll.ts` 讓 PDF／ERP artifact 在頁籤可見且尚未到終態時，以不重疊的 4 秒輪詢更新畫面；PDF 的恢復、單據清單與狀態查詢也沿用共用 session retry。離開頁籤、完成或失敗後自動停止，仍保留手動重新查詢與既有冪等／稽核／RLS 防線，減少使用者反覆按查詢造成的卡頓感。若背景查詢暫時被網路／Session 例外拒絕，hook 會在下一個間隔以同一串行輪詢重試，不會讓非終態檔案卡在處理中；前景重新查詢仍負責顯示可執行錯誤。
- PDF／ERP 的手動狀態查詢現在與共用背景輪詢共享同一個 in-flight request；使用者按下「重新查詢」不會再和背景輪詢重疊打同一個 status RPC，仍保留前景錯誤提示與原有下載／產檔冪等流程。
- PDF／ERP 不因唯讀狀態查詢鎖住終態操作：READY 可下載，ERP 的 FAILED 可同批重試，READY／FAILED 都可開始下一份；PREPARING 等非終態仍不能另開同類 revision。切換或重試會作廢舊查詢，避免晚到回應覆蓋新工作。
- 匯入與主檔前台錯誤已收斂為安全、可重試的操作提示：耐久匯入在檔案處理中只於前一次查詢完成後再排下一次，進入「已驗證、等待確認」就停止背景重抓；主檔清單／編輯／批次匯入不再把資料庫 raw error、details、hint 或批次內部訊息直接顯示給使用者，已知權限／migration 情境仍提供對應處理方向。
- 業務操作錯誤提示也已沿用同一個安全 adapter：帳號、理貨、入庫、補庫、退回、盤點、採購、換季、員工、各類更正與報表 panel 的 RPC／讀取失敗只顯示可執行的中文下一步，不把 PostgreSQL／Supabase raw message 放進畫面；只有使用者可直接修正的本機表單／CSV 格式錯誤保留具體提示。報表頁籤離開後不再因重新整理 token 或身份變更觸發隱藏查詢。
- 耐久匯入狀態判斷已集中在 `src/domain/durable-import-ui.ts`：處理中、等待確認、終態與等待上傳各有單一 helper，避免前台散落重複狀態清單；處理中才會背景更新，`VALIDATED` 只等待使用者確認。背景 Edge 輪詢使用獨立 read seam，不再讓整個面板顯示 mutation「處理中」；批次讀取不再無條件鎖住終態批次的匯入類型／建立新批次，恢復中的操作另以 `recoveryLoading` 控制，檔案／批次切換會遞增 read generation 並以 `createReadRequestController` 同時丟棄晚到的資料與 loading 回應，避免舊 poll 提前關閉新查詢狀態；上傳、取消與確認套用仍使用 `busy`，正式預覽／APPLY 邊界不變。
- SPSV29 的大型清單操作已轉成正式共用 `ManagementCatalogTable` module，而未移植其全域狀態：帳號、商品、組織、員工、兩倉庫存、營運報表、採購差異原因碼、五種更正歷史、CEO 待核版本、換季採購決策品項、換季需求登記與待發貨需求現在共用欄位顯示、舒適／緊湊密度、可調每頁筆數、目前資料範圍與第一／上一／下一／最後頁導覽。員工的離職日／備註、庫存的有效預留及帳號的登入綁定可按需顯示；原因碼提供明確新增／修改模式；更正歷史由 `CorrectionHistoryTable` 提供單號／狀態／差額／原因搜尋、狀態篩選與過帳時間欄位；CEO 清單提供活動／revision／snapshot hash 搜尋與選取後的審核明細；採購清單提供品號／品名／尺寸／數量／決策狀態搜尋與選取後的採購工作區；需求登記清單提供員工／品號／數量／HR 修改狀態搜尋與排序，選取後在右側工作區修改；待發貨需求清單提供需求單／日期／草稿狀態搜尋與排序，選取後在右側理貨工作區建立或恢復草稿。畫面設定不改 RLS、匯出集合或 mutation 契約。interface 與維護規則見 [`docs/architecture/management-catalog.md`](./docs/architecture/management-catalog.md)。
- 帳號管理的角色清單由 `src/domain/account-directory.ts` 先建立 account→roles 索引，再交給畫面做搜尋／排序；不在每次清單 render 時對每個帳號重掃整份 `user_roles`，且仍由共用 `effectiveAccountRoles` 展開 `SYSTEM_ADMIN` 的所有有效角色。
- 帳號設定的需求窗口範圍將 scope 與機構／部門選項讀取分開追蹤；已有選項快照時，背景刷新不會鎖住選擇或操作，保存只等目前帳號 scope 查詢完成，不再等無關的選項刷新；首次尚未取得選項才停用相依控制，server-side API／RPC 仍負責最終驗證。
- System Guide 已整合至正式站 [`/system-guide`](https://uniform-co.vercel.app/system-guide)：`SYSTEM_ADMIN` 可在原 `WorkspaceShell` 左側或 topbar 開啟，原工作區導航保留，三份文件顯示在右側。文件按鈕使用固定 allowlist metadata 首屏建立，登入後預取 route bundle，文件 API 與本人 RLS `user_roles` 權限檢查並行，入口可見性仍由 server-side API 每次重新驗證 bearer session、有效帳號與 SYSTEM_ADMIN；頁面只渲染安全 typed blocks，不使用 `dangerouslySetInnerHTML`。同源文件與維護摘要位於 [`docs/system-guide/`](./docs/system-guide/README.md)。
- 帳號管理已在 `AccountAdminPanel`、`src/server/account-admin.ts` 與 `0088_system_admin_all_roles.sql` 完善：個人資料、帳號啟用/停用與角色指派後皆進行資料庫重新讀取與精確比對（`sameAccountProfile` 與 `sameRoleSet`），確保真正持久化後才回傳成功；`0088` 讓 `SYSTEM_ADMIN` 具備全角色能力傘（Umbrella Capability），兼具所有業務角色的存取權限。
- SSO 已補上已驗證工作入口：根頁導向 `/app`；`/app` 由 server-side Supabase `auth.getUser()` 保護；匿名 `/app` 導向 `/login`，已有 Session 的 `/login` 直接導向 `/app`。一般 SSO callback 先把 ticket 寫入短效 server-side HttpOnly pending state，303 導向同源 `/login?sso_pending=1` 由 `src/app/SsoLoginPrompt.tsx` 顯示「SSO帳號登入中」確認視窗；只有按「繼續 SSO 登入」才由 callback 讀取 HttpOnly ticket、驗票、建立目標 Session 並導向 `/app`，取消只清除 pending state。若 pending state 缺失、過期或格式不完整，登入頁顯示安全階段 `sso_pending_state_missing` 並回到原有登入；視窗提供淡入／處理中 spinner、`aria-live` 與 reduced-motion 支援。`sso_flow=account_binding` 仍保留原登入表單並顯示「SSO帳號綁定中」。驗票後仍由 `src/server/sso-adapter.ts` 在 server-side 以 Admin `generateLink` 的短期 hash 呼叫 target `verifyOtp`，不把 magic-link action URL 或 token 導向瀏覽器。`/auth/callback` 僅保留給既有非 SSO implicit magic-link，明確拒絕 PKCE code／混合 flow，並在成功或失敗後以 `history.replaceState` 清除 callback URL。`/api/sso-health` 維持公開 200 `{ ok: true }`，`/api/sso-login` 與中央 verify／binding API 的呼叫仍只在 server-side。正式站的公開 health、匿名入口與 callback 基本 smoke 已通過；正式 Supabase Auth Redirect URLs 仍須確認包含 `https://uniform-co.vercel.app/auth/callback`，並以 Portal 新 ticket 驗收完整登入／綁定後瀏覽器最後進入工作入口。登入熱路徑已移除 Auth Admin `listUsers` 預檢，中央驗票與 target `auth/v1/user` 查詢並行；相同有效 target Session 直接沿用，只有 Session 不匹配或需建立新 Session 才查 Auth Admin。
- SSO 首屏載入不再等待 Server Component 或 `/app` 工作區資料後才顯示內容：`src/app/login/loading.tsx` 與 `src/app/app/loading.tsx` 共用 `SsoLoadingShell`，提供同頁「SSO帳號登入中／正在開啟工作區」、骨架列、spinner、`aria-busy`、動畫與 `prefers-reduced-motion` 支援。瀏覽器確認請求以 `Accept: application/json` 取得同源 `{ ok: true, redirectTo }` 後才切換頁面；若舊版 callback 仍回 303，則由 Fetch 正常 follow 並驗證 `response.redirected`／`response.url`，避免 manual redirect 被瀏覽器遮罩而誤判登入失敗。callback 與瀏覽器錯誤也使用 allowlist 階段（例如 `sso_configuration_failed`、`sso_callback_failed`、`sso_response_invalid`、`sso_client_request_failed`、`sso_redirect_invalid`），不得再以無法判斷原因的 `unexpected_error` 對外顯示。
- `/app` 的瀏覽器 Session、目前帳號與角色已收斂為 `useAuthSession` 加 `useWorkspaceIdentity`：以一次 `app_accounts`＋`user_roles` self-read 提供工作區與 System Guide 使用，並以目前 Auth user id 綁定身份結果；切換帳號時先清空舊 `accountId／roles`，確認新身份完成後才放行各 panel，避免舊身份短暫誤讀。這同時避免各 panel 重複呼叫 `auth.getUser()`／帳號查詢；未造訪模組仍維持 lazy mount。SSO 登入帳號解析只查本地 `app_accounts`（角色以同一次 embedded relationship 讀回），不再以 Auth Admin `listUsers` 掃描使用者；只有目標 Session 與本地綁定不一致或需要建立新 Session 時，才做單筆 `getUserById`。Vercel Function 已設定 `sin1`，正式 Supabase project 位於 `ap-southeast-1`；2026-09-21 公開 health endpoint 回應標頭顯示 request path `hkg1::sin1`。這確認 function 與 DB 區域相鄰，但不是登入後 API 的端到端 P95/FCP 量測；中央 SSO 服務區域仍待確認。工作區身份 context 與輪替 bearer token 的 render boundary 見 [`docs/architecture/ui-workspaces.md`](./docs/architecture/ui-workspaces.md)，並由 `src/domain/workspace-session-contract.test.ts` 保護。
- 業務讀取的短暫 Session 不同步已收斂到同一個一次性 retry seam：帳號／角色清單、員工匯入錯誤列、ERP 批次恢復、採購原因碼與各類更正恢復查詢不再各自直接重試；權限／schema 錯誤仍直接安全失敗，卸載後的延遲讀取也不會回寫已離開的面板。契約測試見 `src/domain/read-retry-boundary-contract.test.ts`。
- 採購入庫、制服退回、入庫更正與退回更正已接回 `useWorkspaceSession` readiness seam；只有同源 Session、唯一工作區身份與面板可見時才開始受保護查詢，再沿用一次性 session retry，避免登入初期先打無效查詢造成錯誤卡住。契約由 `warehouse-operation-contract.test.ts` 保護。
- 總覽、營運報表、員工匯入、ERP 匯出、PDF、採購原因碼、換季活動／審核／採購／需求登記、補庫、倉庫待發貨，以及商品、組織、員工與兩倉庫存清單也已接回同一 `useWorkspaceSession` readiness seam；只有身份就緒才讀取受保護 view／主檔、恢復冪等操作或啟動 artifact 輪詢，身份錯誤使用衍生訊息呈現，避免登入初期只因 browser client 已建立就提早查詢，也避免 effect 內同步更新狀態造成多餘 render。契約由 `reporting-read-path-contract.test.ts`、`seasonal-read-path-contract.test.ts`、`warehouse-operation-contract.test.ts` 與 `read-refresh-ui-contract.test.ts` 保護。
- 共用管理清單的非日常檢視控制已改為預設收合的「顯示設定」；每頁筆數、密度與欄位顯示仍可使用，排序／分頁／匯出資料集合不變，日常首屏不再被多組顯示按鈕佔滿。契約測試見 `src/domain/management-catalog-ui-contract.test.ts`。
- 共用管理清單的初次讀取與重新整理已分離呈現：`ManagementCatalogTable` 接收 `loading` seam，空列且正在查詢時顯示可存取的載入骨架；已有資料重新整理時保留目前列資料並標記 `aria-busy`，不再先閃成「尚無資料」。骨架動畫支援 `prefers-reduced-motion`，不改查詢、RLS、匯出集合或空結果語意。
- 換季需求／CEO 審核／採購決策與採購原因碼另把資料讀取狀態和保存／審核的 `busy` 分開；四個換季 panel 的手動重新載入只在 mutation `busy` 時停用，背景重新載入不再把操作入口鎖死，並保留既有編輯資料與工作流程狀態，避免把讀取延遲誤呈現為整個模組不可操作。換季需求再以帳號／活動範圍快照區分「可繼續保存」與「尚未取得依賴資料」，同一帳號的暫時 JWT 同步錯誤不會清空已選活動、員工、品號或草稿內容。
- 人資需求歷史是唯讀查詢；「重新整理」不再因清單讀取中而鎖住，使用者可在慢查詢或暫時失敗時立即重試。既有 `historyReadSequenceRef`／`detailReadSequenceRef` 只讓最新查詢發布資料並擁有 loading，晚到回應會被丟棄，不改需求查詢 view、RLS、預留或 mutation。
- 營運總覽重新整理只在工作區身份尚未就緒時停用；核心／延後摘要讀取中仍可再次按下，`queueReload` 會合併 scope，舊 effect cleanup 不會發布過期摘要。首頁新增 `aria-busy` 反映讀取狀態，不改 reporting view、RLS 或事件刷新。
- 商品、組織、員工、兩倉庫存、營運報表、採購原因碼與人資需求的唯讀重新整理也不再被 `dataLoading`／`loadingData` 鎖住；商品／組織／員工／庫存／報表／原因碼沿用共用讀取序號，HR 需求由 effect cleanup 丟棄舊回應，真正寫入仍只由 `busy` 控制。帳號目錄以 `directoryLoadSequence` 防止重複重整的舊結果覆蓋新結果。這只改善 UI 自助重試，不改資料庫交易與 RLS。
- 採購差異原因碼清單也綁定目前 `accountId`；同一帳號的暫時 JWT 同步錯誤保留既有設定，切換帳號、首次尚未取得快照或權限／Schema 失敗時隱藏舊原因碼。背景刷新只顯示同步狀態，不再把已有清單當成空表骨架；新增／修改／停用仍維持原 `maintain_procurement_difference_reason` RPC 與 SYSTEM_ADMIN 權限。
- 主檔編輯器與換季活動建立也把選項載入和 mutation `busy` 分開：商品的供應商／品號選擇、部門的所屬機構、員工的機構／部門與換季活動範圍載入時，只停用尚未可用的依賴控制；已有完整商品／機構快照時，背景刷新不再鎖住資料類型、既有資料與可用選項選擇，代碼、名稱、日期與備註等可先填欄位保持可操作，建立／保存按鈕會在必要選項完成後才可送出。面板以 `aria-busy`／`aria-live` 呈現讀取中，不改既有 RPC、RLS、冪等與資料庫驗證。
- 換季活動的員工／品號選項現在以帳號綁定的可用快照作為操作邊界：同一帳號的背景刷新遇到暫時 JWT 不同步時保留既有選項與範圍編輯，開放已完成凍結的活動也不再被無關的選項重讀阻塞；切換帳號、初次尚未完成載入或權限／Schema 失敗時清除不可再信任的選項並停用建立，仍由 `set_seasonal_campaign_scope`／`open_seasonal_campaign` 在伺服器端做最終驗證。
- 換季活動建立與員工／品號範圍凍結改由 `create_seasonal_campaign_with_scope` 一次 RPC、同一資料庫交易完成，避免正常情況下兩次瀏覽器往返與留下半成品活動；`0125_atomic_seasonal_campaign_setup.sql` 透過呼叫既有角色檢查、冪等與稽核 RPC 保留原規則。尚未套用 0125 的 Supabase project 仍只在明確的 missing-function 回應時退回相容流程，若舊流程只完成建立則可用同一活動 ID 單獨重試範圍；GitHub／Vercel 部署不會自動套用 migration。
- 主檔編輯器與換季活動建立也把選項載入和 mutation `busy` 分開：商品的供應商／品號選擇、部門的所屬機構、員工的機構／部門與換季活動範圍載入時，只停用尚未可用的依賴控制；代碼、名稱、日期與備註等可先填欄位保持可操作。若是已載入既有員工／部門且表單已有機構代碼，保存／停用不再等待選項清單，server-side RPC 仍會重新解析並驗證父機構；新增資料則在必要選項完成前維持受控。面板以 `aria-busy`／`aria-live` 呈現讀取中，不改既有 RPC、RLS、冪等與資料庫驗證。
- 退回與盤點也採用同一個交易讀取 seam：退回分開追蹤已發貨需求、原因碼與發放明細載入；盤點分開追蹤倉庫／品號主檔與指定倉庫帳面餘額，換倉庫時先清除舊帳面快照，直到新餘額完成才可加入品號或送出。盤點已有同倉別主檔／帳面快照時，背景重讀只顯示同步狀態，不再把單號、備註、既有明細或既有草稿整段鎖住；首次尚未取得快照、切換到新倉別或權限／Schema 讀取失敗時仍 fail-closed。退回的既有原因碼在背景重新讀取時不會阻擋已選明細的草稿／完成動作；只有尚未取得原因碼或交易來源時才受控，單號、日期、理由與備註也不因低頻讀取而整體鎖定。
- 人資需求、交易／更正、PDF 與 ERP 面板共用 `WorkflowActionBar`：首屏只保留目前唯一的主要下一步，修改本張、取消、暫存草稿、保存修改、重盤、查詢狀態、另建與下一筆收進「其他操作」；安全的草稿、冪等、版本 fencing、輪詢與 append-only 過帳流程不變。契約測試見 `src/domain/workflow-action-bar-contract.test.ts`。
- 交易型表單的來源選擇已改為顯式操作：入庫、退回、盤點、ERP 匯出、補庫、人資請領、換季需求、PDF 與五個更正工作台不再靜默選第一筆；只有目前選擇仍在清單中才保留，否則顯示「請選擇」。更正恢復只接受有效的既有草稿來源；建立另一筆更正會清除舊來源，必須重新選擇。使用者選定採購單／發貨需求／倉庫／活動／單據前，不會先查相依明細或帳面庫存；人資請領新增明細與補庫也先要求選員工／品號，避免首筆資料誤送。這只改善前台狀態與讀取時機，不放寬 RLS、冪等、版本 fencing 或正式過帳檢查。
- 最新完整本機驗證（2026-09-21）：181 個 Vitest files、770/770 tests 全數通過，另有 6 個 production read-model generator Node tests 通過；`npm run lint`、`npm run typecheck`、`npm run build` 與 `git diff --check` 全部成功。`0098`–`0112` 的讀取路徑 migration（含 `0103_warehouse_shipment_queue_view.sql`、`0104_hr_request_option_views.sql`、`0105_warehouse_transfer_correction_source_view.sql`、`0106_stocktake_correction_source_view.sql`、`0107_receipt_return_correction_source_views.sql`、`0108_hr_issue_correction_source_view.sql`、`0109_seasonal_procurement_queue_view.sql`、`0110_seasonal_demand_workspace_view.sql`、`0111_seasonal_approval_queue_view.sql` 與 `0112_hr_request_history_detail_view.sql`），以及新增的 `0115_sso_account_email_read_index.sql`、`0116_correction_history_view.sql`、`0117_replenishment_shipment_lines_view.sql`、`0118_overview_core_view.sql`、`0119_warehouse_shipment_lines_view.sql`、`0120_employee_directory_view.sql`、`0121_account_directory_view.sql`、`0122_remove_redundant_master_conflict_indexes.sql`、`0123_correction_history_line_indexes.sql`、交易重盤／發貨的 `0113_stocktake_server_recapture.sql`／`0114_warehouse_post_with_lines.sql`、換季活動原子建立的 `0125_atomic_seasonal_campaign_setup.sql` 與採購入庫原子完成的 `0126_atomic_purchase_receipt_completion.sql`，都必須依既有 migration workflow 在目標 Supabase project 套用，不能把 Git push 視為正式資料庫已更新。`0127_atomic_stocktake_completion.sql`、`0128_atomic_hr_request_submission.sql`、`0130_atomic_replenishment_submission.sql` 與 `0131_atomic_correction_completion.sql` 屬於獨立 mutation migration，須依既有流程套用並做 staging 驗證。Edge durable import adapter 沿用既有 GitHub→Vercel 流程，Supabase Function 仍需另外部署與 staging smoke，正式狀態仍不因 repository-local 或 read-only smoke 驗證轉為 READY。

- `0118_overview_core_view.sql` 將總覽可操作的可用量、需求、待發貨與入庫摘要收斂成單次 security-invoker read view；`src/lib/overview-dashboard-read.ts` 讓初次載入與局部刷新共用同一個 read adapter，局部刷新只投影本次 scope 需要的 JSON 欄位，尚未套用 migration 時才 fallback，且只查本次 scope 需要的舊 view，權限／schema 錯誤不會被誤當成 rollout fallback。活動歷史與稽核仍維持背景延後讀取，沒有改變任何 mutation 或過帳權限。
- `0119_warehouse_shipment_lines_view.sql` 將 HR 發貨草稿的發貨明細與需求品項快照收斂成單次 security-invoker read view；`src/lib/warehouse-shipment-read.ts` 尚未套用時優先以既有複合外鍵 embedded read 單次取回，只有 PostgREST 關聯解析錯誤才退回原本兩次讀取。`0114_warehouse_post_with_lines.sql` 未套用時只寫確有變動的明細並確認回傳列 ID，正式 POST 仍由原 RPC 負責。這兩個 migration 都必須在目標 Supabase project 依既有 workflow 執行，GitHub 部署不會自動套用 SQL。
- `0120_employee_directory_view.sql` 將員工清單／匯入需要的員工、機構與部門快照收斂成單次 security-invoker read view；`src/lib/employee-directory-read.ts` 由兩個模組共用，同一 client 的並行／短時間重複讀取會去重並快取最多 30 秒，員工或機構／部門 mutation 成功後明確失效；未套用時才 fallback 到既有快取查詢。員工保存、停用與匯入 RPC 不變，migration 仍須在目標 Supabase project 手動套用。
- `0121_account_directory_view.sql` 將帳號管理首屏的 `app_accounts` 與 `user_roles` 聚合成單次 security-invoker read view；`src/lib/account-directory-read.ts` 尚未套用時才 fallback 到原本兩次查詢。帳號新增、角色／狀態／綁定異動仍由既有 `/api/admin/accounts` server-side API 處理。
- 帳號設定的機構／部門範圍查詢只會鎖定範圍控制；密碼、角色、狀態、Auth 綁定與刪除不再等待低頻主檔查詢，仍由同一個 server-side 管理 API、理由與 idempotency key 授權。
- 倉庫待發貨清單的重新整理只在清單讀取、選取來源明細讀取、交易進行中或有未保存的本地理貨變更時停用；清單搜尋仍可操作，已保存的草稿可保留在右側工作區並直接刷新左側清單。純明細讀取不再鎖住左側來源選擇，快速切換由 `detailsReadController` 丟棄晚到的舊回應；`detailsLoading` 只鎖定右側明細編輯與主要操作，和 mutation `busy` 分開，並在切換前清空舊明細，避免顯示或操作過期資料。
- 採購入庫分開追蹤 `ordersLoading` 與 `linesLoading`：採購單來源可先切換，明細選擇只在 `linesLoading` 或尚未有可用採購單時等待；採購單清單背景刷新不會鎖住仍有效的既有明細。effect cleanup 會丟棄晚到的舊明細查詢，文字欄位與已填草稿不因低頻讀取整體鎖定。
- 採購入庫的成功讀取快照現在綁定目前 `accountId`；同一帳號遇到暫時 JWT 同步錯誤時保留採購單清單，帳號切換、初次尚未取得快照或權限／Schema 失敗時隱藏舊採購單／入庫草稿並停止交易操作，避免跨帳號顯示或送出過期來源。既有草稿建立、修改、POST 與冪等鍵不變。
- 制服退回的已發貨需求／發放明細也綁定目前 `accountId`；同一帳號的暫時讀取錯誤保留可用來源，帳號切換或不可恢復的權限／Schema 錯誤會隱藏舊來源、退回草稿並停止保存／POST。原因碼仍是獨立選項讀取，不會因低頻原因碼同步把日期、單號與理由欄位整段鎖住。
- 補庫申請正式模式不再以 DEMO 品號作初始資料；只有預覽模式使用 DEMO，正式品號讀取期間使用帳號綁定的 `itemsReadBlocked`／`dataLoading` 邊界。首次載入、帳號切換或權限／Schema 失敗時會停用品號選擇、加列與送出並清空失效選項；同一帳號已有有效品號快照時，暫時 JWT 同步錯誤只顯示背景同步狀態，保留正在編輯的草稿。備註等非品號欄位仍可先填，正式送出仍由 RPC 重新驗證。
- 補庫的「建立並送出／保存修改並送出」優先使用 `submit_replenishment_request_with_lines`，避免前端等待草稿 RPC 後再等待送出 RPC；未部署 `0130_atomic_replenishment_submission.sql` 時，明確缺少 RPC 才回退舊流程。遇到結果未知會顯示「重試同一筆送出」並暫鎖欄位，直到以原冪等鍵確認狀態，避免使用者修改資料後建立第二張單。
- 補庫取消會在同一張草稿的結果未知重試中沿用固定 cancel idempotency key；只有修改取消原因才輪換該命令鍵，避免重試產生第二筆取消命令，成功後才清除操作狀態。
- 主檔快取 adapter 會在 30 秒快照有效期間投影共享資料：商品主檔已讀取時，補庫／盤點直接重用啟用品號；組織／員工主檔已讀取時，ERP／換季／人資選項直接重用啟用資料；採購決策會重用商品主檔的供應商／MOQ，只另讀原因碼。沒有完整快照時仍走原本的最小查詢，錯誤只在對應資源範圍內傳遞；`invalidateMasterDataCache` 集中維護來源快照與投影快取的依賴失效，不再要求每個 mutation 呼叫端自行記憶所有 sibling key。既有 mutation 成功後仍會明確失效相關快取。
- 營運報表是純唯讀讀取，改以 `dataLoading` 表示查詢／切換狀態；切換報表不再鎖住搜尋欄位與整個面板，重新整理按鈕與空表骨架只在必要讀取期間受控，上一份成功快照會保留到新報表完成或確認失敗。
- 商品、組織、員工、兩倉庫存、營運報表、採購原因碼與換季採購清單共用 `createReadRequestController` 讀取序號 seam；切換帳號／報表、手動重整或快速重複重新整理時，舊回應不會覆蓋新 rows、選取中的編輯器或提前關閉新讀取的 loading。這只改善前端讀取競速與狀態呈現，不改查詢欄位、RLS、匯出集合、mutation 或資料庫交易。
- `0124_durable_import_work_queue_index.sql` 為 `list_import_work()` 的 active status／`created_at,id` 順序補上部分索引，讓 Edge／worker 不必在 terminal import history 中反覆掃描；這是純讀取加速，必須依既有 Supabase migration workflow 套用，不能把 Git push 視為正式資料庫已更新。
- PDF／ERP 匯出的單據／機構選項與 artifact 狀態查詢改用各自獨立的 `documentLoading`／`institutionLoading` 與 `artifactLoading`；PDF 成品類型不再被單據清單讀取鎖住，前景重新查詢與背景 polling 共用 in-flight promise。READY artifact 可下載；ERP FAILED 可同批重試；兩者的 READY／FAILED 都可開始下一份，只有非終態 artifact 才禁止另開同類 revision。舊狀態查詢由 `createReadRequestController` fencing，建立／下載仍維持 mutation `busy`。
- 兩倉庫存清單的唯讀查詢改用 `dataLoading`，已有快照重新整理時保留資料、搜尋與篩選仍可使用；員工清單則分開 `dataLoading` 與匯出稽核的 `busy`，已有員工快照時即使背景刷新仍可匯出目前篩選結果，不再讓目錄查詢狀態誤顯示成匯出或寫入處理中。

- `0117_replenishment_shipment_lines_view.sql` 將補庫工作台的明細快照與總倉即時可用量收斂成一個 security-invoker read view，並補上 `(request_id, item_id)` 索引；`src/lib/replenishment-shipment-read.ts` 優先使用單次 view 查詢，rolling migration 尚未到位時才 fallback 到原本的明細＋可用量兩次讀取，權限錯誤不會被誤當成 migration fallback。這只改善讀取 latency，不改變補庫 POST RPC 的鎖定與庫存驗證。

目前正式狀態仍是 **`NOT_READY`**。剩餘項目需要真實外部證據：第一批正式帳號／角色／需求窗口範圍、GitHub／Vercel owner 與 backup owner 移交、鼎新正式 mapping 與成功匯入樣本、正式 PDF 版面核准、Supabase migration／RLS／Auth／Storage／signed URL／並行 smoke、durable import Edge／worker 與 renderer 真實 staging integration、Storage destructive cleanup、DB 90-day retention destructive smoke、外部 error monitoring、production-sized DB＋Auth＋Storage 從零還原、RPO／RTO 實測、三年容量實測，以及最後 production cutover approval。

### 已完成的正式介面

- `WorkspaceShell` 集中處理登入 gate、session refresh、左側工作區導航、網址 hash 切換與共用 topbar；正式工作區為「總覽、帳號管理、人資需求、倉庫作業、採購與入庫、換季活動、報表」七個 workspace。總覽內的「商品管理」集中品號／供應商／MOQ 的新增、修改、停用、匯入與匯出；倉庫作業內的「庫存管理」集中兩倉可用量、期初匯入、異動入口、歷史匯出與規則試算。
- `WorkspaceShell initialSystemGuide` 也是 System Guide 的正式外殼：`src/app/system-guide/page.tsx` 不建立第二套全頁導航，右側內容由 `src/app/system-guide/SystemGuidePageClient.tsx` 顯示；`src/app/use-system-guide-access.ts` 只負責入口顯示與背景預取，最終權限在 `src/app/api/system-guide/route.ts` 與 `src/server/system-guide.ts`。三份 Markdown 的固定檔名、標題與讀者集中在 `src/domain/system-guide.ts`，前後端共用同一 allowlist。
- 每個 workspace 的功能由 `src/app/workspaces/*Workspace.tsx` 組裝，模組定義、頁籤名稱與搜尋索引集中在 `src/app/workspaces/workspace-config.ts`；功能頁籤是 tab 切換，不是按鈕把畫面往下捲動。
- topbar 已包含 workspace 搜尋、通知中心、日期／資料狀態、帳號操作與風格下拉選單；手機版改用工作區下拉選單，桌面版使用左側導航。
- `AccountAdminPanel` 已獨立在左側「帳號管理」workspace。2–50 個小寫英數字的登入帳號與至少 6 字元密碼必填，聯絡 Email 選填且不作登入用途；建立與編輯時可一次管理多個業務角色（`SYSTEM_ADMIN`、`HR`、`WAREHOUSE`、`PROCUREMENT`、`CEO`、`DEMAND_COORDINATOR`），並支援啟用／停用、需求窗口的機構／部門範圍、Auth 綁定重設／解除，以及保留業務歷史的刪除操作。保存後會重新讀取 `app_accounts`／`user_roles` 驗證結果，避免 RPC 版本不一致時顯示假成功；`SYSTEM_ADMIN` 的有效權限由 `0088_system_admin_all_roles.sql` 統一授予所有角色。管理 API 位於 `src/app/api/admin/accounts/route.ts`，server-side 實作位於 `src/server/account-admin.ts`，權限與稽核契約以 `0036_account_role_scope_admin.sql`、`0067_account_admin_profile_and_auth_audit.sql`、`0068_account_login_and_bulk_roles.sql`、`0069_account_login_alphanumeric_only.sql`、`0070_account_login_minimum_two.sql`、`0088_system_admin_all_roles.sql` 為準。
- 帳號管理清單的成功快照現在綁定目前工作區 `accountId`；切換管理者、初次尚未完成讀取或目錄權限／Schema 失敗時先隱藏舊帳號與角色列，避免把上一個管理者看到的目錄留在畫面上。帳號 API、Auth Admin、角色授權、範圍設定與稽核流程不變。
- 風格下拉選單與 localStorage key `uniform:appearance-theme` 已提供五套可切換樣式：`AP`（目前 Apple-inspired）、`MX`（修改前 Prototype）、`GS`（CSS compositor motion；程式 id 保留為 `ga`）、`MB`（product workspace）、`SH`（shadcn/ui-inspired neutral dashboard）。SH 是現有 CSS token adapter，不額外引入 shadcn runtime dependency；樣式集中在 `src/app/globals.css`，選項集中在 `src/app/use-appearance-theme.ts`。
- 版面基線為 commit `3059723`；若後續只調整視覺，優先沿用 appearance seam，不要把某一套風格的 CSS 寫回共用 base rule，也不要改變 workspace／domain data flow。

### 正式應用的接手順序

1. 先讀 [`agents.md`](./agents.md) 的「最新 AI 接手快照」，再讀本節與 `CONTEXT.md`；依需求範圍再讀 `docs/spec/`、`docs/architecture/`、`docs/implementation/`。若修改前台說明、角色可見性或交接文件，再讀 [`docs/system-guide/README.md`](./docs/system-guide/README.md)。
2. UI／版面需求先搜尋現有 workspace、panel、theme selector 與 CSS token；功能需求先搜尋對應 domain function、panel 與 migration，再做最小 patch。
3. 所有帳號、角色與範圍異動都必須經 server-side API／Supabase 受保護 RPC，不能從瀏覽器直接使用 service role 或寫入 Auth 管理資料。
4. Prototype 與正式 App 是兩個不同驗收面：prototype 只驗證內容與流程；正式功能要驗證 Supabase Auth、RLS、Storage、RPC、並行鎖與 staging smoke。

## 文件索引

`0015_draft_creation_rpc.sql` 將人資需求、補庫與倉庫發貨的草稿建立接到受保護、冪等 RPC；`0016_employee_import_guard.sql` 將員工匯入的大小、欄數與儲存格限制移到資料庫端；`0017_seasonal_scope_guard.sql` 阻擋沒有員工/品號範圍的換季活動開放；`0018_seasonal_snapshot_at_open.sql` 在開放瞬間刷新並凍結員工歸屬快照；`0019_seasonal_demand_rpc.sql` 與 `0020_seasonal_demand_integrity.sql` 讓需求窗口只能透過鎖定活動、使用凍結範圍快照的伺服器 RPC 登記需求，並撤銷 direct DML；`0021_seasonal_hr_correction.sql` 提供 HR 待核修正 RPC 與快照範圍讀取；`0022_procurement_reason_codes.sql` 加入可維護採購差異原因碼、SYSTEM_ADMIN 維護 RPC、停用供應商防線與採購決策 RPC 的 active supplier 驗證；`0023_receipt_draft_validation.sql` 允許採購入庫草稿先保存未完成分類，並將完整分類與拒收理由檢查放在 POST 交易；`0024_receipt_draft_update.sql` 讓入庫草稿可依固定鎖序修改；`0025_stocktake_draft_rpcs.sql` 將盤點草稿建立／更新改由受保護 RPC 在交易內擷取帳面量與 balance version，前端新增盤點工作台並保留 `STALE_COUNT` 版本 fencing；`0026_return_draft_rpc.sql` 將退回草稿建立改由原始發放明細推導身份與快照，前端新增退回草稿／POST 工作台；`0027_stocktake_conflict_forward.sql` 將兩倉合計預留衝突與需求轉 `INVENTORY_REVIEW_REQUIRED` 的盤點 POST 修正套用到已完成初始 migration 的環境；`0028_stocktake_update_forward.sql` 將盤點更新 RPC 的重盤簽章與確認防線套用到舊環境；`0029_return_schema_forward.sql` 將退回明細的 line_no 與唯一約束補到舊環境；`0089_hr_request_workflow.sql` 補上人資需求的送出前／送出後修改與取消、補庫草稿的修改與取消、冪等鍵與固定庫存鎖序，保留已送出資料的歷史並釋放可取消需求的有效預留；`0090_employee_parent_active_guard.sql` 補上機構／部門停用前的在職員工防線；`0092_hr_request_active_master_guard.sql` 補上需求送出瞬間的員工、機構、部門啟用狀態防線。盤點調減會以兩倉合計檢查有效預留，必要時同交易標記需求需重新檢查；前端也提供 CEO 待核版本的 revision/hash 核准或退回入口、採購決策／採購單、採購入庫、庫存盤點、員工制服退回與 A4 PDF artifact 請求／狀態入口；入庫草稿可先暫存，POST 後才把合格量寫入總倉。人資工作台在 Supabase 環境會載入正式主檔並可建立、修改、取消草稿、查詢需求單明細與預留狀態，並支援發貨前修改已送出需求與重新驗證預留；員工 CSV 匯入工作台也可確認後原子套用員工主檔；換季工作台可建立活動並凍結員工/品號範圍、需求窗口可在授權範圍登記數量，再呼叫受保護 RPC 開放需求窗口。

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

Durable import worker 的 forward migration 順序為 `0045` → `0046` → `0047` → `0048` → `0056` → `0058` → `0061`：先建立 immutable reference snapshot，再拆分 bounded parse chunks，分離 worker／uploader actor，提供 definitive parser failure 狀態轉換，最後讓受控 `job_import_worker` 確認由使用者上傳的 object（保留原 uploader attribution）並進入解析；`0058` 也會在 worker batch lock 內修復 0046 以前遺留的 oversized PARSE chunk，`0061` 保留單檔 10MB 上限但容納 JSONB chunk envelope 的編碼膨脹。線上站可透過 `supabase/functions/import-worker` Edge adapter 使用同一套 migration／RPC；完整 SQL/RLS/Storage smoke 仍須在受保護 staging 驗證。

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

Durable import worker 的 forward migrations 為 `0045`–`0048`、`0056`、`0058`、`0061`：reference snapshot、bounded chunks、worker/uploader actor separation、malformed-upload failure、受控 worker 對上傳物件的確認、legacy oversized chunk repair，以及 JSONB chunk payload headroom 都已納入；正式線上可用 Edge adapter 或常駐 worker，實際 Supabase/RLS/Storage smoke 仍需受保護 staging 驗證。

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

`0067_account_admin_profile_and_auth_audit.sql` 補齊帳號基本資料與 Auth Admin 安全事件稽核；`0068_account_login_and_bulk_roles.sql` 將登入帳號與選填聯絡 Email 分離，新增唯一 `login_name`，並讓建立帳號與多角色指派在同一資料庫交易完成；`0069_account_login_alphanumeric_only.sql` 將登入帳號限制為小寫英數字，`0070_account_login_minimum_two.sql` 再將最短長度調整為 2 個字元；`0088_system_admin_all_roles.sql` 讓 `SYSTEM_ADMIN` 在所有既有 `private.has_role(...)` 判斷中視為具有被查詢的業務角色。既有 Email 登入在管理員指派登入帳號前仍可相容使用。

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
