# GitHub＋Vercel Hobby＋Supabase Free 限制研究

研究基準日：2026-08-12  
適用情境：20 家機構共用的員工制服管理系統，包含員工與制服主檔、兩倉庫存、發放／調庫／採購／盤點、更正／退回、Excel 匯入匯出、A4 PDF 與鼎新 ERP 銷貨匯出。

本文只引用 Vercel、Supabase 與 GitHub 的官方資料。方案與限制會變動，上線前仍應逐項重查。文中的「官方事實」是來源明載內容；「建議」是依本系統情境做出的設計或營運判斷，不是供應商承諾。依本案範圍，商業授權、方案使用資格與法律適用性刻意不納入評估。

## 結論

這套免費組合可用來開發、驗證及低關鍵度試行，但若它要成為取代紙本、Excel 與 Google Sheet 的唯一正式帳冊，則必須先接受以下風險並完成補強：

1. **Vercel Hobby 無法連接 GitHub Organization 擁有的 repository。**若堅持免費 Git 自動部署，repository 必須由個人 GitHub 帳號擁有；若公司要求組織持有程式碼，現行 Hobby Git 整合不符合需求。[Vercel Limits](https://vercel.com/docs/limits#connecting-a-project-to-a-git-repository)
2. **Supabase Free 不是 always-on 層級。**低活動量專案可能因過去 7 天活動不足而暫停；Free 也沒有自動備份、PITR、正常運作時間 SLA 或電子郵件支援。[Supabase Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)、[Supabase Pricing](https://supabase.com/pricing)
3. **免費方案沒有可直接依賴的資料復原鏈。**Supabase 明確建議 Free 專案自行定期執行 `supabase db dump` 並保留異地備份，而且資料庫 dump 不包含 Storage 物件。[Supabase Database Backups](https://supabase.com/docs/guides/platform/backups)
4. **技術容量可望足以支撐小型內部系統，但尚不能只靠員工數推定。**500 MB 資料庫是否足夠，取決於交易年限、索引、稽核紀錄及附件策略；必須以真實樣本做容量測試後才能下結論。

因此，本研究的建議判定是：**可做免費版試行；正式上線須把 GitHub repository 整合、備份還原、暫停風險、容量監控與故障應變列為上線門檻。**若業務無法接受數小時以上停機、遺失最近一次備份後的交易，或沒有人工恢復程序，便不應以 Free 作唯一正式環境。

## 1. Vercel Hobby

### 1.1 用量、暫停與維運可見度

官方事實：

- Fluid Compute 的 Hobby 內含量為 4 小時 Active CPU、360 GB-hours Provisioned Memory 與 100 萬次函式呼叫；平台另列 100 GB Fast Data Transfer。Hobby 無法購買超額用量。[Vercel Function Pricing](https://vercel.com/docs/functions/usage-and-pricing)、[Vercel Limits](https://vercel.com/docs/limits#included-usage)
- Hobby 接近或超過限制時會收到通知；超限可使專案暫停，而官方表示多數情況須等待 30 天後才能再次使用該功能。[Vercel Plans](https://vercel.com/docs/plans)、[Vercel Hobby Plan](https://vercel.com/docs/plans/hobby#hobby-billing-cycle)
- 每日最多建立 100 個 deployment、同時只能執行 1 個 build、單次 build 上限 45 分鐘；Hobby runtime logs 只保留 1 小時。[Vercel Limits](https://vercel.com/docs/limits)
- 自 2026-04-29 起，Hobby deployment retention 最長 30 天；最近 10 個 production deployments 與仍有 alias 的 deployment 不受該清除規則影響。這只是程式部署保留，不能還原 Supabase 業務資料。[Vercel Changelog](https://vercel.com/changelog/hobby-projects-now-default-to-30-day-deployment-retention)

建議：

- 在 Vercel 與 Supabase 使用量達 60%、70%、85% 時分級告警；70% 啟動改善／升級決策，85% 時停止非必要批次、圖片與大型匯出。百分比是本專案的操作門檻，不是官方門檻。
- 不把 Vercel runtime logs 當稽核紀錄。發放、庫存、採購、權限與匯出批次的異動紀錄應寫入應用程式自己的 append-only 稽核資料表，並避免把密碼、token 或完整個資寫入日誌。
- production 發布至少保留「目前版」與「前一可用版」的快速回復步驟；Vercel Hobby 的 production rollback 只能直接回到上一版。[Vercel Rollback](https://vercel.com/docs/deployments/rollback-production-deployment)

### 1.2 Serverless runtime 限制

官方事實：

- 新專案預設使用 Fluid Compute。啟用時，Hobby 的 Node.js／Python 函式預設及最長執行時間都是 300 秒；未啟用的舊專案預設 10 秒、最多 60 秒。Hobby 標準記憶體為 2 GB／1 vCPU。[Vercel Function Limits](https://vercel.com/docs/functions/limitations#max-duration)
- 函式 request body 與 response body 各有 4.5 MB 上限；超過會回傳 `FUNCTION_PAYLOAD_TOO_LARGE`。標準函式 bundle 上限為 250 MB，檔案系統除最多 500 MB 的暫存 `/tmp` 外為唯讀，暫存不能當持久儲存。[Vercel Function Limits](https://vercel.com/docs/functions/limitations#request-body-size)、[Vercel Runtimes](https://vercel.com/docs/functions/runtimes#features)
- Vercel Function 預設在 Washington, D.C. (`iad1`) 執行，但可設定單一適合的區域；官方建議函式靠近資料來源。多區域部署屬較高方案能力。[Vercel Function Regions](https://vercel.com/docs/functions/configuring-functions/region)
- Hobby 每個專案可有 100 個 cron jobs，但每個排程最低只能每日一次，執行時間可能在指定小時內偏移最多 59 分鐘。Vercel 不會自動重試失敗的 cron，且官方提醒事件可能重複送達，工作需具冪等性。[Vercel Cron Pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)、[Vercel Cron Management](https://vercel.com/docs/cron-jobs/manage-cron-jobs#cron-job-error-handling)

對本系統的影響與建議：

- **Excel 匯入：**瀏覽器送進 Vercel API 的檔案若可能超過 4.5 MB，不得經 Vercel Function 轉送。可在瀏覽器端解析並分批提交，或由已驗證使用者直接上傳到 private Supabase Storage，再由背景流程解析。Supabase Free 單檔仍不得超過 50 MB。
- **PDF 與鼎新匯出：**小檔可直接回傳；可能超過 4.5 MB 的正式 PDF／大型匯出應先寫入 Storage，再以短效 signed URL 下載，或使用串流回應。正式單據的資料快照、版號與雜湊應留在資料庫，不能只依賴可被刪除的暫存檔。
- **批次工作：**大量換季彙整、PDF 批次產生、Excel 驗證與 ERP 匯出應拆成可重跑的小批次；每批保存狀態、idempotency key 與錯誤原因，不能假設一個 HTTP request 必然跑完。
- **區域：**建立 Supabase production 專案前先選定區域，再把 Vercel Function 配到相同或鄰近區域。Supabase 目前列有 Singapore、Tokyo、Seoul 等 APAC 區域；台灣實際選擇應以延遲測試決定。[Supabase Regions](https://supabase.com/docs/guides/platform/regions)

## 2. Supabase Free

### 2.1 核心配額

| 項目 | 官方事實 | 本系統的操作意義 |
|---|---|---|
| 專案數 | 每位 Owner／Admin 跨 organizations 合計 2 個 active Free projects；paused projects 不計入。[Billing on Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase#free-plan) | 建議固定為 production 與 staging 各一；開發者使用 local Supabase。不可再假設另有免費 UAT／DR 專案。 |
| Database | 每專案 500 MB；Free Nano 為 shared CPU、最多 0.5 GB RAM。超過 500 MB database size 會進 read-only mode。[Database Size](https://supabase.com/docs/guides/platform/database-size#free-plan-behavior)、[Compute and Disk](https://supabase.com/docs/guides/platform/compute-and-disk#compute) | 附件不得放 bytea；稽核資料需設容量預算，但不可為省空間刪除仍受保存要求的帳務歷史。 |
| Connections | Nano 建議最多 60 個 direct database connections、200 個 pooler clients。[Compute and Disk](https://supabase.com/docs/guides/platform/compute-and-disk#postgres-replication-slots-wal-senders-and-connections) | Vercel 等短生命週期環境不可為每次請求建立長駐 direct connection。 |
| Egress | Free 內含 5 GB egress；Storage 另有 5 GB cached egress。除 database size 明列為 per-project 外，用量型 quota 是 organization 彙總。[Billing on Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase#variable-usage-fees-and-quotas)、[Supabase Pricing](https://supabase.com/pricing) | production 與 staging 若在同一 organization，會共享多數用量額度；測試資料下載也會吃配額。 |
| Storage | 1 GB；Free 的 global max file size 最多 50 MB；image transformations 不含在 Free。[Storage File Limits](https://supabase.com/docs/guides/storage/uploads/file-limits)、[Supabase Pricing](https://supabase.com/pricing) | 儲存正式附件與必要的不可變匯出即可；能由結構化資料重建的臨時 PDF 不宜無限保存。 |
| Auth | 50,000 MAU；basic MFA 可用；SAML SSO、single-session enforcement、session timeouts 與 leaked-password protection 不含在 Free。[Supabase Pricing](https://supabase.com/pricing) | 人數額度不是瓶頸，但企業登入整合與部分帳號安全控制不可假設存在。角色權限仍須由本系統＋RLS 實作。 |
| Realtime | 200 peak connections、每月 200 萬 messages、每訊息 256 KB。[Supabase Pricing](https://supabase.com/pricing) | 庫存正確性不可依賴畫面即時更新；Realtime 只改善 UX，提交時仍要在資料庫交易內重驗。 |
| Edge Functions | 每月 500,000 invocations；Free 最多 100 個 functions。每個 worker 256 MB、Free wall-clock 150 秒、每 request CPU time 2 秒。[Edge Function Pricing](https://supabase.com/docs/guides/functions/pricing)、[Edge Function Limits](https://supabase.com/docs/guides/functions/limits) | 不適合在單次 Edge Function 內完成大型 Excel／PDF CPU 工作；應分批或放在 Vercel Node runtime／用戶端。 |
| Logs／Support | API 與 database logs 保留 1 天，Auth Audit Logs 1 小時；Platform Audit Logs、Log Drains、uptime SLA 與 email support 不含在 Free。[Supabase Pricing](https://supabase.com/pricing) | 必須自己保存業務稽核與工作失敗狀態；事故若隔天才被發現，平台 log 可能已不存在。 |

「Unlimited API requests」只表示沒有按 API 次數計費的固定上限，不代表 shared compute、database size、egress 或公平使用限制不存在。[Supabase Billing FAQ](https://supabase.com/docs/guides/platform/billing-faq#fair-use-policy)

### 2.2 暫停與恢復

官方事實：

- Supabase 會暫停在 7 天觀察期內資料庫活動不足的 Free project；並非只有完全零流量才可能被判定為低活動。官方通常會在暫停前約一週寄警告信，暫停時再寄確認信。[Supabase Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing#how-automatic-pausing-works)
- 暫停後可在 Studio 一鍵恢復，期限為 1 年；超過一年後不能一鍵恢復，但官方文件說仍可下載備份與 Storage 物件，再遷移到新 project。[Supabase Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing#restoring-a-paused-project)、[Supabase Restore After One Year](https://supabase.com/docs/guides/troubleshooting/restore-project-after-90-days-pause)

建議：

- 不以製造假流量作為可用性保證。指定至少兩位 Supabase organization owners，讓警告信進入共同維運信箱，並建立「收到 pause warning 當日處理」程序。
- 前端應能辨識後端不可用並顯示維護訊息；不得在網路錯誤時假裝庫存交易成功。人工應變表只用於停機期間的臨時紀錄，恢復後須由授權人員補登並產生明確的補登稽核。
- 若「不能被 inactivity pause」是正式 SLA，升級 Supabase 是必要條件，不是程式碼能保證的功能。

### 2.3 備份與復原

官方事實：

- Automatic backups 與 PITR 不含在 Free；Supabase 官方建議 Free project 定期以 CLI `db dump` 匯出並維持 off-site backups。[Supabase Pricing](https://supabase.com/pricing)、[Supabase Database Backups](https://supabase.com/docs/guides/platform/backups)
- Database backup 只包含資料庫與 Storage metadata，不包含 Storage 中的實際檔案；刪除 project 會永久刪除關聯資料及 Supabase 端備份。[Supabase Database Backups](https://supabase.com/docs/guides/platform/backups#types-of-backups)
- 官方 CLI 指南可分別匯出 roles、schema 與 data，並說明如何還原到另一個 project。[Supabase CLI Backup and Restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

建議的最低控制：

1. 每日執行 logical database dump；另行備份 private Storage objects。兩者都加密後放到與 Supabase 不同故障域的組織控管儲存位置。
2. 保存 7 份每日、4 份每週及 12 份每月備份；這是建議政策，可依個資與公司保存規範調整。
3. 每月至少將最新備份還原到 local 或 staging，驗證登入關聯、庫存餘額、單據、稽核與 Storage 檔案可讀；只看到「備份 job 成功」不等於可還原。
4. 在系統管理頁顯示最後成功備份時間、檔案校驗值及最近一次 restore drill 日期。
5. 若每日備份確實成功，理論 RPO 約為 24 小時；實際 RTO 取決於人工取得備份、建立 project、還原、切換環境變數及驗證時間，Free 沒有官方 RTO／SLA。

可用 GitHub Actions 排程執行 dump，但不應把它當成無監督保證：GitHub 官方指出 scheduled workflow 可能延遲，負載高時甚至可能被丟棄；因此要提供手動重跑與失敗通知。[GitHub Scheduled Workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

### 2.4 Auth 與授權

官方事實：

- Supabase 預設 SMTP 是 best-effort、供測試與非關鍵用途，現行速率為每小時 2 封，且預設只寄給 project organization 成員的地址；官方要求其他情境設定 custom SMTP。[Supabase Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- Supabase Auth 可與 PostgreSQL Row Level Security 結合；官方 production checklist 要求所有暴露資料表啟用合宜的 RLS，並建議帳號與 Supabase 管理帳號使用 MFA。[Supabase Auth](https://supabase.com/docs/guides/auth)、[Supabase Production Checklist](https://supabase.com/docs/guides/deployment/going-into-prod#security)
- TOTP MFA API 免費且所有 Supabase projects 預設可用。[Supabase TOTP MFA](https://supabase.com/docs/guides/auth/auth-mfa/totp)

建議：

- 禁止公開自助註冊。由系統管理員建立帳號，採 email＋password；password reset／invite 若需要可靠寄送，必須接 custom SMTP。custom SMTP 本身可能是另一個外部服務與額度，不能假設由 Supabase Free 免費提供郵件傳送。
- 角色採本系統定義的系統管理員、人資、倉庫、採購、執行長、需求窗口；不要把 Supabase Dashboard 的 Owner／Admin／Developer 當業務角色。
- 所有暴露的 tables 與 `storage.objects` 都啟用 RLS；暴露的 views 使用 `security_invoker` 或經同等安全審查。需求窗口的「機構＋部門」授權、人資／倉庫職責分離及倉庫發貨後鎖單，必須在 database policy 或受控 RPC 中再驗證，不能只隱藏前端按鈕。
- `service_role` secret 只能存在 server-side environment；瀏覽器只使用 publishable key 與使用者 JWT。高權限角色建議強制 TOTP，並在 RLS／server action 檢查 `aal2`，否則 MFA 只有畫面流程而沒有授權效果。
- 由於 Free 不提供 SAML SSO、single-session 與 server-side session timeout 功能，若公司政策要求與既有身分提供者整合、單一有效登入或管理員強制閒置登出，需升級或另採身分方案。

### 2.5 Database 與 Vercel 的連線方式

官方事實：

- Supabase 建議 frontend 使用 Data API；長生命週期工具如 migrations／`pg_dump` 使用 direct connection；serverless／edge functions 使用 Shared Pooler (Supavisor) transaction mode，port `6543`。transaction mode 不支援 prepared statements。[Supabase Database Connections](https://supabase.com/docs/guides/database/connecting-to-postgres)

建議：

- 一般查詢優先使用 `supabase-js`／Data API＋RLS。若 Vercel server function 使用 PostgreSQL driver 或 ORM，採 Supavisor transaction mode 並依 library 關閉 prepared statements。
- 「兩倉合計可申請量檢查＋預留」、「調庫／發貨」、「入庫」、「盤點調整」、「更正／退回」都應封裝成單一 database transaction 或受控 PostgreSQL RPC，使用 row lock、constraint 與唯一鍵防止競爭條件。前端顯示的最大值只改善操作體驗，提交時仍須原子重驗。
- 不把長交易跨越多個 HTTP requests；不把尚未提交的庫存狀態保存在 Vercel `/tmp` 或記憶體。

## 3. GitHub Free

官方事實：

- GitHub Free 個人與 organization 帳號都可使用不限數量的 private repositories 與 collaborators，但 private repository 的進階控制較有限；官方將 required reviewers、protected branches 等列為 Pro／Team 的進階 private-repository 功能。[GitHub Plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)
- private repositories 的 GitHub-hosted Actions 免費額度為每月 2,000 分鐘，Actions artifact storage 為 500 MB；沒有付款方式時，超過免費額度後使用會被阻擋。[GitHub Actions Billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions#free-use-of-github-actions)
- workflow artifacts 與 logs 預設保留 90 天；private repositories 可設定 1 至 400 天，但保留時間不會增加 500 MB 免費 artifact 額度。有 repository read access 的人即可下載 artifacts。[GitHub Artifact Retention](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)、[GitHub Artifact Download](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)

建議：

- Repository 必須是 private，且只存程式碼、schema migrations、測試與不含個資的文件；不得 commit `.env`、Supabase database password、`service_role` key、SMTP credential、備份 dump、員工 Excel 或正式 PDF。
- 若維持 Vercel Hobby Git 整合，只能用個人帳號持有 repository；把 repository 至少加一位受控的備援 collaborator。若公司要求 organization ownership 與強制 branch protection，應把 Vercel／GitHub 方案升級列入治理決策，不以共用個人帳號規避。
- Actions 用於 lint、test、migration dry-run 與可監控的備份排程。由於 500 MB artifact quota 可能連一份接近上限的 database dump 都無法長期容納，備份應上傳到加密 off-site destination，而非把 Actions artifact 當正式備份庫。
- 備份 workflow 加上 `workflow_dispatch`、非整點排程、concurrency lock、成功校驗與失敗通知；只把最少權限的 credential 放在 GitHub Actions Secrets。[GitHub Actions Secrets](https://docs.github.com/en/actions/concepts/security/secrets)

## 4. 建議的免費版部署邊界

### 環境配置

- Supabase project A：production；project B：staging。local development 不連 production。
- Vercel Production environment 只指向 Supabase production；Preview／Development 只指向 staging 或 local。migration 先在 staging 驗證，再以版本化 SQL 套到 production。
- 不把 production 員工資料複製到 staging；需要測試時使用合成或去識別資料。
- Region 在建立 Supabase project 時先定案，Vercel functions 隨後設定到同區或鄰近區域。

### 資料與檔案配置

- PostgreSQL：主檔、單據、明細、庫存 ledger、餘額、預留、稽核、採購與 ERP 匯出批次。
- Supabase Storage private buckets：必要的原始匯入檔、正式 PDF／ERP 檔及附件；以 RLS／signed URL 控制存取。
- Vercel：前端、短生命週期 API、頁面／PDF 組版與小型 orchestration；不做持久檔案儲存。
- GitHub：source of truth for code 與 migrations；不存業務資料或備份。

### 容量驗證

正式上線前以真實欄位與索引建立測試資料，至少模擬預期三年交易量及尖峰換季批次。建議通過以下門檻：

- 模擬資料、索引與稽核合計不超過 500 MB 的 60%。此 60% 是安全緩衝建議。
- production-like Excel 在限制內可完成預覽、驗證、錯誤回報與分批提交；大於 4.5 MB 的路徑確認未經 Vercel Function body。
- 100% 並行測試下，同品號競爭送單不會造成負庫存、超額預留或重複 ERP 匯出。
- PDF／鼎新檔可重複下載且內容固定；大型檔案使用 Storage／streaming 路徑。
- 備份可在全新 local 或 staging 環境還原，並完成庫存總額與 ledger 對帳。

## 5. 升級或停止上線的觸發條件

以下為專案建議，不是供應商自動門檻：

| 觸發條件 | 建議決策 |
|---|---|
| 程式碼必須由 GitHub Organization 持有並直接連接 Vercel | Vercel Hobby 不符合；升級或更換部署方式。 |
| 業務要求不得因低活動被暫停，或需要供應商 SLA／email support | Supabase Free 不符合；升級。 |
| 需要 automatic backups、PITR，或無法接受約 24 小時的自建備份 RPO | Supabase Free 不符合；升級並另驗證 Storage backup。 |
| Database size 達 350 MB、Storage 達 700 MB、任一月度 egress／function quota 達 70% | 啟動容量改善及升級評估；不得等到 read-only 或 service restriction 才處理。 |
| shared Nano 在換季批次、Excel 匯入或報表時無法達到驗收效能 | 先查詢／索引優化；仍不合格即升級 compute。 |
| 事故需要超過 Free 的 1 天 API／DB log 或 1 小時 Auth Audit Log 才能追查 | 導入外部觀測或升級；業務稽核仍由應用層永久保存。 |
| private repository 需要 required reviewers／protected branches，或 Actions 長期接近 2,000 分鐘／500 MB | 升級 GitHub，或縮減 Actions 並使用獨立備份儲存。 |

## 6. 正式上線門檻清單

- [ ] GitHub repository ownership 與 Vercel Hobby Git 整合方式已確認。
- [ ] Vercel Fluid Compute、function region、4.5 MB 大檔替代路徑與 cron 冪等性已驗證。
- [ ] production／staging 完全隔離，Preview 不可能取得 production secrets。
- [ ] 全部資料表與 private Storage buckets 的 RLS 已以六種業務角色做正反向測試。
- [ ] 庫存、預留、發貨、盤點、更正、退回及 ERP 批次均以 database transaction／constraint 防止競爭。
- [ ] custom SMTP 或不依賴郵件的受控帳號復原程序已完成；高權限 MFA 已驗證。
- [ ] 每日 database dump、Storage objects backup、加密、異地保存、失敗通知與手動重跑已運作。
- [ ] 已完成至少一次從零還原演練，並記錄實測 RPO／RTO。
- [ ] Vercel、Supabase、GitHub Actions 的用量 owner、告警門檻與每週檢查責任人已指定。
- [ ] Supabase pause warning、Vercel pause、資料庫 read-only、SMTP 故障及兩平台同時不可用的人工應變程序已演練。
