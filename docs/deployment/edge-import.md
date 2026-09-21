# Supabase Edge durable import

這個部署方式不需要常駐 worker 主機。瀏覽器仍只把 CSV／XLSX 直傳到 private uniform-imports bucket；上傳成功後，DurableImportPanel 呼叫 Supabase Edge Function import-worker。Edge Function 以同一個 job_import_worker database actor 執行既有 confirm_import_upload、PARSE／VALIDATE chunk 與 APPLY RPC，保留原本的 lease、idempotency、RLS 與 audit 邊界。

## 必要設定

Edge Function 只接受已登入使用者的 bearer JWT，並以 app_accounts.auth_user_id 確認該使用者就是批次建立者。它使用同一個使用者 JWT 讀取該使用者在 `uniform-imports` 的 exact object；現有 Storage RLS 已限制批次建立者／SYSTEM_ADMIN 的讀取範圍，因此不需要把 service-role key 放進這個 function。

在同一個 production Supabase project 的 Edge Function secrets 設定：

    IMPORT_EDGE_DATABASE_URL=<Supavisor transaction-mode connection URL for job_import_worker>
    IMPORT_EDGE_ALLOWED_ORIGIN=https://uniform-co.vercel.app

IMPORT_EDGE_DATABASE_URL 必須直接以同名 job_import_worker 登入，使用 Supavisor transaction mode（通常是 port 6543）並由連線 client 關閉 prepared statements。不要使用 postgres owner、service_role 或中央 Supabase project 的連線字串。

現有 migration 會建立 job_import_worker 為 NOLOGIN，正式啟用前由 DB owner 在受保護維運流程暫時設定同名 LOGIN／密碼及既有 private.job_actor_bindings；密碼只進 Edge Function secret，不能寫入 migration、repository、前端或 log。若既有常駐 worker 已使用同一個 role，Edge Function 可以與它共存，但同一批次的 lease／idempotency 會阻止重複套用。

同名 role 與 actor binding 的查核／設定範本在 [`supabase/manual/edge-import-setup.sql`](../../supabase/manual/edge-import-setup.sql)。該檔案只含查詢與註解範例，不含任何密碼；請不要把 placeholder 直接當成正式 secret。

## 部署

在已登入 Supabase CLI 且已選定目標 project 的受保護環境執行：

    supabase functions deploy import-worker
    supabase secrets set IMPORT_EDGE_DATABASE_URL="<secret value>" IMPORT_EDGE_ALLOWED_ORIGIN="https://uniform-co.vercel.app"

不要在 shell history 或 command output 留下實際連線字串。Edge Function 每次請求最多連續處理四個同階段 chunk，並重用同一請求內的解析預覽；每一個 chunk 仍是可重跑且由 DB lease／cursor fencing 保護。前台每次先觸發 Edge 再立即讀回狀態，處理中以 2.5 秒間隔重新觸發；重新開啟頁面也會恢復同一批次。使用者關閉頁面不會遺失 durable evidence，但不會再產生新的即時觸發，下一次開啟或按「重新查詢批次」即可繼續。

## 驗收

1. Edge Function deployment status 為 ACTIVE，且沒有將 secret 放進 function response 或 log。
2. 使用既有 HR／SYSTEM_ADMIN session 上傳小型 CSV，狀態依序經過 AWAITING_UPLOAD、UPLOADED、PARSING、VALIDATING、VALIDATED。
3. 逐列差異確認後，使用者確認發布，狀態進入 APPLYING、APPLIED。
4. 使用同一批次重複觸發，資料庫只保留一套 row／diff／apply 結果。
5. 用無權限登入者呼叫 function，回安全的 edge_import_access_denied，不回傳資料庫錯誤、Storage key、JWT、cookie 或檔案內容。

Supabase Edge Function 是 worker 的 serverless implementation，不是瀏覽器解析器；若未設定 IMPORT_EDGE_DATABASE_URL 或 actor binding，畫面會保留在等待狀態並提示稍後重試，不會假稱匯入完成。這個 function 不需要 SUPABASE_SERVICE_ROLE_KEY。
同名 role 與 actor binding 的查核／設定範本在 [`supabase/manual/edge-import-setup.sql`](../../supabase/manual/edge-import-setup.sql)。該檔案只含查詢與註解範例，不含任何密碼；請不要把 placeholder 直接當成正式 secret。
