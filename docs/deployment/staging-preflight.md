# Staging preflight

這個 preflight 只檢查目前受保護執行環境是否已注入必要的環境變數，以及少數可在本機安全驗證的格式；它不連線 Supabase、不執行 migration、不啟動 worker，也不輸出任何 secret 值。

先由公司的 secret manager 或受保護部署環境注入 staging credentials，再明確標記目標環境：

```powershell
$env:UNIFORM_DEPLOYMENT_ENV = "staging"
npm run deployment:preflight
```

預設 `smoke` scope 會檢查：

- Supabase migration 所需的 access token、project ref、DB password。
- Vercel／Next.js staging 的 public URL、anon key 與 server-only Auth admin key。
- durable import worker 的 DB connection、private storage proxy URL/token。
- PDF／ERP renderer 的 DB connection、private storage proxy URL/token 與 adapter command。
- renderer/import 共用 storage proxy 的 DB connection、Supabase Storage URL 與 Storage Admin key。
- 是否誤把疑似 privileged secret 放進 `NEXT_PUBLIC_*`。

備份與還原條件分開檢查，避免日常 smoke 必須攜帶不需要的高權限 credentials：

```powershell
npm run deployment:preflight -- --scope=cleanup
npm run deployment:preflight -- --scope=import-retention
npm run deployment:preflight -- --scope=backup
npm run deployment:preflight -- --scope=restore
npm run deployment:preflight -- --scope=all
```

`cleanup` scope 的 dry-run 最少只要求 `CLEANUP_DATABASE_URL`，且 URL username 必須精確為 `job_storage_cleanup`。若同時準備 execute credentials，`CLEANUP_SUPABASE_URL` 與 `CLEANUP_STORAGE_ADMIN_KEY` 必須成對存在；preflight 不要求、也不保存 destructive confirmation `CLEANUP_EXECUTE_CONFIRM=DELETE_ELIGIBLE_STORAGE`。`import-retention` scope 只要求 `IMPORT_RETENTION_DATABASE_URL`，且 username 必須精確為 `job_import_retention`；它同樣不要求或保存 execute confirmation `IMPORT_RETENTION_EXECUTE_CONFIRM=PURGE_ELIGIBLE_IMPORT_STAGING`。`all` scope 會同時包含 cleanup 與 import-retention。`backup` 會要求 DB／Storage credentials、backup root、完整 private bucket allowlist、加密命令與 offsite handoff 命令；兩個 command 都必須使用 `$1` 取得 backup generation directory、`$2` 取得已驗證的 `BACKUP_RUN_ID`，preflight 會在不輸出 command 內容的前提下檢查這個契約。`restore` 會要求已驗證的 backup generation、全新 staging target DB、雙人解密命令與 Storage restore credentials，且 `BACKUP_DECRYPT_COMMAND` 必須使用 `$1` 取得 generation directory；`CONFIRM_RESTORE=YES` 不由 preflight 要求或保存，只能在真正執行破壞性還原前明確設定。

實際執行 `scripts/restore/restore-from-zero.sh` 時，會在任何解密前先確認 `node`、`pg_restore`、`psql` 可用；缺少任一工具就停止，不得修改 backup generation。`BACKUP_DECRYPT_COMMAND` 由受保護環境提供，generation 路徑不拼入 shell command，而是以第一個位置參數傳入，因此解密命令必須使用 `$1` 取得 `BACKUP_RUN_DIR`。

Preflight 全綠只代表「可以開始實際 staging 驗收」，不代表 staging 已通過。接著仍必須依 `docs/deployment/runbook.md` 實際完成 migration、登入／RLS、durable import、renderer、download policy、retry/fencing、Storage cleanup、DB staging retention、報表與 correction concurrency 等 smoke。Storage cleanup 即使 `--scope=cleanup` 全綠，也只證明 credential 形狀與同名 DB username 可進入下一步；真實候選列出／recheck／DELETE／404 idempotency／audit event 尚需在受保護 staging credentials 下實跑。Import retention 即使 `--scope=import-retention` 全綠，也只證明專用登入格式正確；真實 90-day candidate、row lock/recheck、payload scrub、`staging_purged_at` 與 restart fence 仍需 PostgreSQL integration 驗證。

## 可執行的 staging DB readiness

Migration 已套用、worker LOGIN／actor binding 已由受保護維運程序建立後，可執行只讀 DB readiness：

```powershell
$env:UNIFORM_DEPLOYMENT_ENV = "staging"
$env:UNIFORM_STAGING_SMOKE_CONFIRM = "YES"
$env:STAGING_DATABASE_URL = "<protected-staging-owner-or-maintenance-url>"
npm run deployment:smoke
```

這個命令會先要求兩道 staging 明確 gate，缺一即在連線前 fail closed。連線後只開 `READ ONLY` transaction，且不輸出 connection string 或任何 secret 值。它會驗證：

- repository 內所有 migration version 都已出現在 `supabase_migrations.schema_migrations`。
- import／PDF renderer／ERP renderer／Storage proxy 的同名 staging LOGIN 已啟用，所有 job role 保持 `NOINHERIT`。
- worker／renderer／proxy／storage cleanup／`job_import_retention` 都有 active `private.job_actor_bindings`，且綁定的 app account 仍 active。
- durable import、renderer、download、private Storage capability 與 DB staging retention 的關鍵 RPC 存在，包含 `job_import_retention` 對 list/purge RPC 的允許以及 `authenticated` 的拒絕，EXECUTE 權限符合 fail-closed 邊界。
- PDF／ERP renderer 對 `storage.objects` 已沒有直接 DML，五個固定 bucket 都存在且保持 private。
- generation-specific object-key trigger、download grant RLS 與 `system_cutover_state` 的 PRE_CUTOVER baseline 正確。

`deployment:smoke` 是「真正情境 smoke 的前置 readiness」，不是完整驗收，也不會自動建立、修改或刪除 fixture。若 staging 已執行過 once-only opening balance 並進入 `LIVE`，這個 baseline check 會刻意 FAIL；請建立新的 staging generation／乾淨驗收環境重跑，不要把狀態手動改回 `PRE_CUTOVER`。

## Active durable-import fixture smoke

Readiness 全綠後，可在「可直接丟棄並重建」的 staging generation 執行 active fixture。這個命令會真的新增合成帳號、主檔、durable import、operation command 與 append-only audit evidence，因此不提供假清理流程，也不得對 production 執行：

```powershell
$env:UNIFORM_DEPLOYMENT_ENV = "staging"
$env:UNIFORM_STAGING_SMOKE_CONFIRM = "YES"
$env:UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM = "DISPOSABLE_STAGING_ONLY"
$env:STAGING_DATABASE_URL = "<protected-staging-owner-or-maintenance-url>"
$env:IMPORT_WORKER_DATABASE_URL = "<job_import_worker-login-url>"
npm run deployment:active-smoke -- --scope=import
```

`scope=import` 會先確認 `IMPORT_WORKER_DATABASE_URL` 的 `session_user` 真的是 `job_import_worker`，以及該 worker 的 audit actor binding 為 active 且具 HR。它接著只使用唯一 prefix 的合成資料驗證：

- 同一 claim idempotency key 回傳同一 lease、錯誤 fingerprint 以 `40001` 拒絕。
- 人工過期 synthetic lease 後可由同一 worker LOGIN takeover，舊 generation heartbeat 被 fencing。
- `max_attempts=1` 的 retryable failure 透過正式 `fail_import_chunk` 進入 `FAILED`。
- EMPLOYEES 的 INSERT／UPDATE／SKIP preview 經 PARSE → VALIDATE → confirm → APPLY，並驗證實際結果；ERROR preview 會使批次失敗。
- 即使完全沒有 field diff，`claim_import_apply` 在 `confirm_import_batch` 前仍以 `55000` 拒絕，確認後才可 APPLY。

authenticated confirmation 是在 maintenance DB session 內以 `SET LOCAL ROLE authenticated` 加「合成 JWT claims」驗證 DB/RLS 邊界；它不建立真實 Supabase Auth user，也不能取代另行執行的 login／六角色 RLS smoke。worker RPC 則沒有模擬：它仍必須由真正同名 `job_import_worker` LOGIN 連線，因為資料庫會檢查 `session_user`。

## Active renderer / Storage fixture smoke

Renderer／Storage 也有獨立 active smoke。它會真的建立 synthetic STOCKTAKE/PDF/ERP fixture、啟動真實 renderer worker 與 loopback Storage proxy、寫入 staging Storage，並保留 READY／FAILED artifact 與 audit evidence；因此只能在可直接丟棄重建的 staging generation 執行，且比一般 active smoke 多一道明確寫入 gate：

```powershell
$env:UNIFORM_DEPLOYMENT_ENV = "staging"
$env:UNIFORM_STAGING_SMOKE_CONFIRM = "YES"
$env:UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM = "DISPOSABLE_STAGING_ONLY"
$env:UNIFORM_STAGING_RENDERER_SMOKE_CONFIRM = "RENDERER_STORAGE_WRITE_OK"
$env:STAGING_DATABASE_URL = "<protected-staging-owner-or-maintenance-url>"
$env:DOCUMENT_RENDERER_DATABASE_URL = "<job_document_renderer-login-url>"
$env:ERP_RENDERER_DATABASE_URL = "<job_erp_renderer-login-url>"
$env:RENDER_STORAGE_PROXY_DATABASE_URL = "<job_renderer_storage_proxy-login-url>"
$env:SUPABASE_URL = "https://<staging-project-ref>.supabase.co"
$env:SUPABASE_STORAGE_ADMIN_KEY = "<protected-storage-admin-key>"
npm run deployment:renderer-smoke
```

此命令會在建立 DB client、socket 或 child process 前先驗證所有 gate／必要設定，並確認三個 protected connection 的 `session_user` 真的是 `job_document_renderer`、`job_erp_renderer`、`job_renderer_storage_proxy`，以及三者都有 active `private.job_actor_bindings`。它會驗證：

- PDF 與 ERP 的 claim → immutable payload → private proxy upload → finalize，且直接用 Storage Admin GET 重算 bytes／SHA-256 對照 artifact metadata。
- PDF lease 人工過期後，同一 attempt 的 generation 增加、token 與 object key 更換；舊 heartbeat／payload／finalize 與舊 Storage capability 全部被 fencing。
- 真實 ERP worker 第一次 renderer failure 後建立 retry attempt，再以成功 adapter 完成 READY；另一筆 `max_attempts=1` 會進入 terminal FAILED／`GENERATION_FAILED`。
- 對成功 ERP upload 刻意丟失一次 HTTP response，worker 必須透過 `/info` 查回已寫入物件並完成 finalize，而不是重寫未知 key。
- STOCKTAKE revision 1／2 都保留 READY 歷史，revision 2 正確 supersede revision 1 並成為 current；HR／WAREHOUSE 可 request/download，PROCUREMENT／CEO 以 `42501` 拒絕。

角色 request/download 驗證是在 maintenance session 內用合成 JWT claims + `SET LOCAL ROLE authenticated` 做 DB-side audited grant/RPC 測試；它不建立真實 Supabase Auth user，也不宣稱驗證 browser Storage RLS 或 signed URL。正式上線前仍需另跑真實 login／六角色 RLS 與 Supabase Auth Storage RLS 測試。`UNIFORM-ERP-SALES-v0` 仍只是 internal smoke，不能視為鼎新正式 mapping。

### Once-only opening balance smoke

期初庫存會把 singleton 從 `PRE_CUTOVER` 永久推進成 `LIVE`，所以再加一道獨立 gate，而且應放在同一 disposable generation 的最後：

```powershell
$env:UNIFORM_STAGING_CUTOVER_SMOKE_CONFIRM = "ONCE_ONLY_OPENING_BALANCE"
npm run deployment:active-smoke -- --scope=cutover
```

`scope=cutover` 會要求 `job_import_worker` 綁定 actor 具 `SYSTEM_ADMIN`，並要求尚無任何 inventory posting。它建立一個合成品號、使用現有 active staging warehouse，確認第一個 opening batch 成功建立 opening posting、inventory balance 並把 singleton 變成 `LIVE`，再確認第二個 opening batch 於 APPLY 被 `55000` 拒絕。成功後不得把 `LIVE` 手動改回 `PRE_CUTOVER`；要重跑只能建立新的 staging generation。

若同一個 disposable generation 要依序跑一般 import 與期初，可用 `--scope=all`，但 `job_import_worker` 的 audit actor 必須同時具 HR 與 SYSTEM_ADMIN，且必須先設定兩道 active/cutover gate。

## Staging smoke 執行順序

1. 確認目標是 staging project，migration 由 `0001` 到最新版本完整套用，並建立受保護同名 worker LOGIN／`private.job_actor_bindings`。
2. 驗證登入、六角色 RLS、帳號管理與 `system_cutover_state`；只使用合成測試資料。
3. Durable import：先以 `npm run deployment:active-smoke -- --scope=import` 跑 duplicate claim、expired lease takeover、wrong fingerprint、EMPLOYEES INSERT／UPDATE／SKIP／ERROR、批次確認 gate、zero-diff confirm 與 max-attempt FAILED；response-loss 的 Storage/object retry 仍由實際 worker/Storage smoke 驗證。
4. PRE_CUTOVER opening balance once-only 放最後，以 `npm run deployment:active-smoke -- --scope=cutover` 驗證第一次成功與第二次拒絕。
5. Renderer／Storage：以 `npm run deployment:renderer-smoke` 跑真實 protected LOGIN／actor binding、PDF/ERP claim → payload → proxy upload → finalize、Storage bytes/hash、generation-specific stale-worker fencing、ERP retry／terminal failure／response-loss recovery、historical READY revision 與 STOCKTAKE request/download role matrix。
6. Storage cleanup：先跑 `npm run deployment:preflight -- --scope=cleanup`，再以 `npm run cleanup:storage` 驗證 DB 候選；只有受保護 disposable staging 才設定 Storage Admin credentials 與 `CLEANUP_EXECUTE_CONFIRM=DELETE_ELIGIBLE_STORAGE` 後執行 `npm run cleanup:storage -- --execute`，確認 DELETE 前 DB recheck、24 小時下限、READY/APPLIED 保護、404 冪等與 append-only cleanup event。不要在 smoke 中重設 lease 或刪 evidence row。
7. DB staging retention：先跑 `npm run deployment:preflight -- --scope=import-retention` 與只讀 `npm run deployment:smoke` 確認同名 LOGIN／actor binding／RPC ACL，再於受保護 disposable staging 先 dry-run `npm run retention:import-staging`；只有準備好的 90 天 fixture 才設定 `IMPORT_RETENTION_EXECUTE_CONFIRM=PURGE_ELIGIBLE_IMPORT_STAGING` 後執行 `npm run retention:import-staging -- --execute`，驗證 batch row lock/recheck、payload scrub、row/chunk/diff evidence 保留、`staging_purged_at` 與 purge 後 restart fence。
8. ERP 只能用 `UNIFORM-ERP-SALES-v0` 做內部 smoke；未收到鼎新正式成功匯入樣本前，不得把它當成正式鼎新 mapping。
9. Smoke 完成後保留結果與失敗證據；未完成的 gate 不得帶到 production cutover。

下列 active fixture 情境目前仍必須實際執行並保存 PASS/FAIL 證據，不能用 readiness 取代：

- 登入與六角色 RLS allow/deny matrix、帳號管理／scope。
- Durable import duplicate claim、expired lease takeover、wrong fingerprint、EMPLOYEES INSERT／UPDATE／SKIP／ERROR、zero-diff confirm、response-loss retry、max-attempt FAILED。
- PRE_CUTOVER opening balance 第一次成功與第二次拒絕；此項只能在可丟棄的 staging fixture 上做。
- `npm run deployment:renderer-smoke` 的 PDF／ERP claim → payload → proxy upload → finalize、Storage bytes/hash、舊 generation stale-worker fencing、ERP retry／terminal failure／response-loss recovery、historical READY revision 與 STOCKTAKE PDF 角色矩陣；仍須在真實 staging credentials 下實際執行並保存 PASS/FAIL 證據。
- `npm run cleanup:storage -- --execute` 的真實 Storage DELETE／404、DB eligibility recheck、cleanup audit event；目前每日 cron 仍只有 dry-run，destructive cron 尚未啟用。
- `npm run retention:import-staging -- --execute` 的真實 90 天／未滿 90 天候選、batch row lock/recheck、payload scrub、row/chunk/diff evidence 保留、`staging_purged_at` 與 purge 後 restart fence；每日 workflow 仍只有 dry-run，destructive cron 尚未啟用。
- ERP 的 `UNIFORM-ERP-SALES-v0` 只算 internal smoke；正式鼎新 mapping 仍需成功匯入樣本與 golden-file 驗證。

任何填入真實帳號、員工、庫存或 secret 的檔案都不得 commit 到 repository。
