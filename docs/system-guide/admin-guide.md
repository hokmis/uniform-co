# 管理者設定說明

<!-- SYSTEM-GUIDE:GENERATED:START -->

## 1. 管理範圍與安全界線

管理者負責帳號、角色、需求窗口範圍、主檔匯入、期初切換、部署環境、背景工作、備份還原與上線證據。`SYSTEM_ADMIN` 不是萬用業務角色；需要執行人資、倉庫、採購或執行長流程時，帳號仍須另具對應角色。

正式環境不要直接執行以下操作：

- 不要把 Supabase service-role、secret key、DB URL、Storage Admin key 放進 `NEXT_PUBLIC_*` 或瀏覽器 bundle。
- 不要直接 UPDATE／DELETE `inventory_balances`、庫存流水、artifact、匯入證據或 `audit_events`。
- 不要把正式帳號、密碼、員工、供應商、庫存、備份明文或 secret commit 到 Git。
- 不要把 repository-local 測試成功當成 production cutover 已核准。

## 2. 平台與環境

| 平台 | 用途 | 主要管理事項 |
| --- | --- | --- |
| GitHub | `main` 程式來源、CI、手動 migration workflow、dry-run 維運 workflow | owner／backup owner、branch 保護、Environment approvals、Secrets |
| Vercel | Next.js 正式網站與 server API | Git 整合、正式網域、環境變數、部署紀錄 |
| Supabase | Auth、PostgreSQL、RLS、RPC、private Storage | 專案 owner、migration、角色、bucket、備份、quota |
| 受保護 Worker 環境 | Durable import、PDF／ERP renderer、Storage proxy、cleanup、retention | 專用 DB LOGIN、actor binding、最小權限 secret、監控與排程 |

正式 App 最少需要 Vercel 設定：

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY 或 SUPABASE_SECRET_KEY
```

前兩項供登入與 caller-scoped RLS；最後一項只供 server-side 帳號 Auth 管理，絕不可設成 `NEXT_PUBLIC_*`。其他 worker、renderer、backup、restore、cleanup 與 retention secret 依 `docs/deployment/secret-inventory.md` 放在各自受保護環境，不集中到前台部署。

## 3. 帳號、角色與需求窗口

### 第一位系統管理員

第一位 `SYSTEM_ADMIN` 必須由 DB owner 依公司核准名單建立並綁定 Supabase Auth user。完成後，後續帳號與角色使用「帳號管理」模組，不要直接把 service-role 交給瀏覽器。

### 日常帳號管理

1. 使用有效 `SYSTEM_ADMIN` 登入。
2. 進入「帳號管理 → 帳號與權限管理」。
3. 建立帳號時填 2–50 個小寫英數字登入帳號、至少 6 字元密碼、顯示名稱及一個以上角色；聯絡 Email 選填且不作登入。
4. 每次異動填寫原因。建立、改密碼、啟停、刪除 Auth、角色與 scope 都由 server-side API、受保護 RPC 與冪等鍵處理。
5. `DEMAND_COORDINATOR` 必須另外設定一組或多組「機構＋部門」scope。
6. 停用或刪除登入身份不等於刪除業務歷史；不得刪除最後一位有效 `SYSTEM_ADMIN`，也不得讓目前登入管理員自我鎖定。

角色允許清單固定為：

```text
SYSTEM_ADMIN
HR
WAREHOUSE
PROCUREMENT
CEO
DEMAND_COORDINATOR
```

### System Guide 權限

「系統說明」入口暫時只提供 `SYSTEM_ADMIN`。前台使用登入者可由 RLS 讀取的 `user_roles` 快速判斷並在目前分頁快取顯示狀態；真正的文件內容仍由 `/api/system-guide` 重新驗證 bearer session、有效業務帳號與 `SYSTEM_ADMIN` 角色。移除角色後，即使舊分頁短暫保留入口，受保護 API 仍會拒絕內容並清除該分頁的顯示快取。

## 4. Migration 管理

Migration 正式來源為 `supabase/migrations/`，目前版本到 `0079_employee_master_management.sql`。Migration 須按版本順序套用，並在受保護環境記錄 `supabase_migrations.schema_migrations`。

建議使用 GitHub Actions 的「Supabase migrations (manual)」workflow：

1. 選擇 `staging` 或 `production`。
2. 分別輸入 `STAGING_MIGRATION` 或 `PRODUCTION_MIGRATION`。
3. 由對應 GitHub Environment 的核准者放行。
4. workflow 使用受保護的 access token、project ref 與 DB password 執行 `supabase db push`。

若公司暫時要求在 Supabase SQL Editor 手動執行，仍須按順序、保存核准與結果，並在完成後使用只讀 readiness 查核，不要因 SQL 顯示「Success. No rows returned」就跳過版本與函式驗證。

## 5. 正式資料建立順序

### 帳號與主檔

1. 核准第一批正式帳號、角色與需求窗口 scope。
2. 匯入機構。
3. 匯入部門。
4. 匯入制服品號。
5. 匯入供應商。
6. 匯入供應商品號／MOQ。
7. 匯入員工。
8. 確認只有一個啟用中的 `purpose = 'HR'` 人資倉與一個啟用中的 `purpose = 'GENERAL'` 總倉。

正式採購前，系統管理員另需在「採購與入庫 → 採購決策 → 採購差異原因碼」建立公司核准的原因碼。新增後從清單按「編輯」調整名稱或狀態；原因碼本身是穩定識別，不可用改名取代新建，停用也不會刪除既有採購歷史。

CSV 範本位於 `docs/deployment/onboarding/templates/`。正式資料不要覆寫版本化空白範本；可放到已被 `.gitignore` 排除的 `docs/deployment/onboarding/private/`，或直接透過受保護 UI 匯入。

### 期初庫存切換

`OPENING_BALANCE` 是期初庫存。必須先完成全部主檔與倉庫核對，再由 `SYSTEM_ADMIN` 在 `PRE_CUTOVER` 狀態執行：

1. 上傳「倉庫代碼＋制服品號＋非負整數數量」。
2. 等待 worker 驗證檔案、列資料與 SHA-256。
3. 確認所有 preview 差異與錯誤。
4. 核准後發布唯一一次 opening batch。
5. 確認同一交易建立 opening posting、兩倉餘額並切到 `LIVE`。

進入 `LIVE` 後不可發布第二批，也不可把狀態手動改回 `PRE_CUTOVER`。需要重跑演練時建立全新的 disposable staging generation。

## 6. Durable import 與 Storage

前台只取得資料庫產生的固定 private object key，檔案直接上傳 Supabase Storage，不經 Vercel request。`scripts/import/import-worker.ts` 是持續背景 worker；`npm run import:worker -- --once` 只跑一輪，移除 `--once` 才會持續輪詢。

管理重點：

- `job_import_worker` 必須是獨立 LOGIN／NOINHERIT，並有 active `private.job_actor_bindings`。
- Worker 只透過 `list_import_work` 與受保護 PARSE／VALIDATE／APPLY RPC，不取得前台 session。
- 匯入檔、staging payload、批次 evidence 與 audit evidence 的保存責任不同，不可用同一 cleanup job 混刪。
- FAILED／CANCELLED source object 的 Storage eligibility 與 90-day staging payload retention 由 DB RPC 決定，runner 不自行推論。

## 7. PDF、ERP 與 Renderer

PDF 與 ERP 由不同 worker 處理 immutable snapshot、artifact revision 與 render attempt。Renderer 不直接寫 `storage.objects`，只取得短效、generation-specific capability 經 private Storage proxy 上傳。

正式啟用前確認：

- `job_document_renderer`、`job_erp_renderer`、`job_renderer_storage_proxy` 為獨立最小權限 LOGIN。
- 五個允許 bucket 存在且保持 private。
- finalize 會核對 generation、object key、bytes 與 SHA-256。
- 下載使用短效 grant 並再經 RLS 判斷來源與角色。
- `UNIFORM-ERP-SALES-v0` 只算內部 smoke；收到鼎新成功匯入樣本並完成 golden-file 前不得稱正式 mapping 完成。

## 8. 備份、還原、清理與保存

### 備份與從零還原

備份 generation 必須包含 manifest、完整 DB／Auth／private Storage 集合、SHA-256，以及八個關鍵 application table counts 和 Auth users／identities／MFA counts。異地交付前要確認敏感明文已加密且來源 generation 未變。

還原只對全新 staging target 執行：先確認目標為空，再解密、還原 DB／Auth／Storage；Storage 每個物件 POST 後必須 GET read-back，重新比對長度與 SHA-256。任何 409、缺檔、重複 target、unsafe path 或 count drift 都要停止。

### Storage cleanup

每日 workflow 目前只 dry-run。真正刪除只在受保護 disposable staging 設定 Storage Admin credentials 與：

```text
CLEANUP_EXECUTE_CONFIRM=DELETE_ELIGIBLE_STORAGE
```

Runner 必須在 DELETE 前重新呼叫 DB eligibility，保留 24 小時下限、READY／APPLIED 保護、404 冪等與 append-only cleanup event。

### Import staging retention

每日 workflow 同樣只 dry-run。真正 scrub 90 天 terminal staging payload 時必須由 `job_import_retention` 執行並設定：

```text
IMPORT_RETENTION_EXECUTE_CONFIRM=PURGE_ELIGIBLE_IMPORT_STAGING
```

只清 `raw_values`、`normalized_values`、`validation_errors`，保留 batch／row shell／chunk／diff evidence，設定 `staging_purged_at` 後不可 restart。

## 9. Staging 驗收與上線 Gate

建議順序：

1. `npm run deployment:preflight` 檢查受保護設定形狀，不輸出 secret。
2. `npm run deployment:smoke` 執行 read-only migration／LOGIN／ACL／bucket readiness。
3. 以真實 Supabase Auth 跑六角色 RLS allow／deny matrix 與帳號管理。
4. 在 disposable staging 跑 durable import active smoke。
5. 最後跑一次性 opening balance smoke。
6. 跑 renderer／Storage active smoke、PDF／ERP revision、response-loss 與下載角色矩陣。
7. 分別跑 Storage destructive cleanup 與 DB 90-day staging retention smoke。
8. 完成正式 PDF、鼎新、外部 monitoring、備份還原、RPO／RTO 與三年容量 evidence。
9. 由 business／platform owner 完成 production cutover approval。

Production evidence 必須存於 Git ignored 的 `docs/deployment/onboarding/private/release-evidence.json`，使用：

```text
npm run deployment:release-evidence -- init --release-id release/<release-id>
npm run deployment:release-evidence -- record --gate <gate-id> --source <approved-source> --evidence-reference <non-secret-reference>
npm run deployment:release-gate -- --input docs/deployment/onboarding/private/release-evidence.json
```

只有 17 個 required gate 全部通過才會得到 `READY`。目前專案狀態必須維持 `NOT_READY`。

## 10. 故障處理

| 現象 | 管理檢查 |
| --- | --- |
| 全站只有登入或設定畫面 | Vercel public Supabase URL／anon key、Supabase Auth、部署環境 |
| 登入成功但資料為空 | `app_accounts` 綁定、帳號啟用狀態、角色與 scope、來源表 RLS |
| 帳號管理 503 | server-only service role／secret key 是否存在，且沒有放入 public env |
| 單筆員工保存或匯出找不到 RPC | 是否已套用 `0079` 並重新載入 PostgREST schema |
| Durable import 卡住 | Worker 是否持續執行、LOGIN／actor binding、lease、Storage object、batch status |
| PDF／ERP 卡在處理中 | 對應 renderer、Storage proxy、attempt lease、active artifact pointer、finalize metadata |
| Migration drift | 對照 repository versions 與 `schema_migrations`，不要補假 PASS evidence |
| Cleanup／retention 無候選 | 先接受 dry-run 結果；不要放寬 24 小時或 90 天 DB 下限 |

## 11. 尚未完成的外部設定

- 第一批正式帳號、角色、需求窗口 scope 與公司核准名單。
- GitHub、Vercel、Supabase、backup 與 worker 的 primary／backup owner。
- 鼎新正式 mapping 與成功匯入樣本。
- 公司抬頭、Logo、正式 PDF 版面、字型與簽名欄位。
- 外部 error monitoring provider、alerts 與 incident smoke。
- Production-sized DB＋Auth＋Storage 從零還原與 RPO／RTO 實測。
- 三年 synthetic/staging 容量與正式保存年限。
- 最終 production cutover approval。

<!-- SYSTEM-GUIDE:GENERATED:END -->

<!-- SYSTEM-GUIDE:MANUAL:START -->

## 公司管理補充

可在此記錄非敏感的值班窗口、核准流程、維護時段與 evidence 保存位置。請勿記錄 secret 值、完整連線字串、密碼或 2FA recovery code。

<!-- SYSTEM-GUIDE:MANUAL:END -->
