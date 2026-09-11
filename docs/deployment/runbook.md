# 部署與同步 Runbook

## 已完成的版本控制路徑

- GitHub private repository：`Kevin72333/uniform-co`
- `main` 已設定 `origin`，每次已驗證的切片都會 commit 並 push。
- GitHub Actions CI 會在 push 後執行 `npm ci`、測試、lint、型別檢查與 production build。
- Vercel 應直接連接同一個 private repository；Preview 與 Production 必須使用不同的 Supabase project／環境變數。

## Supabase

1. 建立 staging 與 production project，保留 project ref；不要把 service role key 放進 GitHub、瀏覽器或 Preview。
2. 在受保護的維運環境設定 `SUPABASE_ACCESS_TOKEN`、`SUPABASE_PROJECT_REF`、`SUPABASE_DB_PASSWORD`。
3. 先對 staging 執行 migration，再做 smoke login、六角色 RLS、`system_cutover_state` 與最小測試資料驗收。
4. 驗收通過後才對 production 執行同一組 migration；migration 必須按 `0001` 到最新序號一次套用。
5. 將下列瀏覽器環境變數只設在對應 Vercel project：
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
6. 邀請制帳號與角色 seed 由 Supabase Auth／受保護 SQL 執行；不得把真實員工資料或 key 寫入 repository。

Staging credentials 由 secret manager／受保護部署環境注入後，先設定 `UNIFORM_DEPLOYMENT_ENV=staging` 並執行 `npm run deployment:preflight`。這個檢查只驗證必要 env 是否存在與基本格式，不連線、不執行 migration，也不代表 smoke 已通過。Migration 與同名 worker LOGIN／actor binding 建立後，再用受保護 `STAGING_DATABASE_URL`、`UNIFORM_STAGING_SMOKE_CONFIRM=YES` 執行 `npm run deployment:smoke`；它只在 `READ ONLY` transaction 做 migration／role／binding／RPC ACL／Storage fence／PRE_CUTOVER baseline assertions。Readiness 全綠後，只有可直接丟棄重建的 staging generation 才能再設定 `UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM=DISPOSABLE_STAGING_ONLY` 並執行 `npm run deployment:active-smoke -- --scope=import`。Renderer／Storage active smoke 另需 `UNIFORM_STAGING_RENDERER_SMOKE_CONFIRM=RENDERER_STORAGE_WRITE_OK`，再以受保護的 document renderer／ERP renderer／renderer Storage proxy 同名 LOGIN、Storage Admin credential 執行 `npm run deployment:renderer-smoke`。期初 once-only 測試另需 `UNIFORM_STAGING_CUTOVER_SMOKE_CONFIRM=ONCE_ONLY_OPENING_BALANCE` 並以 `--scope=cutover` 放在最後。完整 scope、credentials 與 active fixture smoke 順序見 [`staging-preflight.md`](./staging-preflight.md)，版本化的名稱／權限／保存位置清單見 [`secret-inventory.md`](./secret-inventory.md)；兩份文件都不得填入真實 secret 值。

Migration `0015_draft_creation_rpc.sql` 套用後，人資工作台會透過 `create_hr_request_draft` 建立完整快照草稿，再呼叫 `submit_hr_request`；倉庫可用 `create_warehouse_shipment_draft` 建立待 POST 發貨草稿。若 migration 尚未套用，畫面會保留預覽模式並顯示 RPC 錯誤，不會假稱已送出。

`0015_draft_creation_rpc.sql` 也提供 `create_replenishment_draft`；人資可從額外補庫工作台建立不預留庫存的補庫單，再由 `submit_replenishment_request` 送出，倉庫以 `post_replenishment_request` 依總倉現有庫存調庫。`0016_employee_import_guard.sql` 將員工 CSV 匯入改由 `apply_employee_import_checked` 原子套用，資料庫端也會重驗檔案大小、列數、欄數與儲存格長度，重試沿用相同冪等鍵。

換季 migration `0017`–`0021` 依序加入非空活動範圍、OPEN 時員工快照、需求窗口 RPC、RPC-only 寫入、凍結範圍授權，以及 HR_REVIEW 修正與稽核。套用完整 migration 後，需求窗口才能看到活動範圍並登記；HR correction 必須透過 `correct_seasonal_demand_line`，不得直接寫需求明細。

本機目前無 Docker／Postgres，因此 `supabase db lint --local` 只能在具備 Docker 的維運環境執行；本機已通過 app test、lint、typecheck、build，但不把它當成 SQL/RLS 整合驗收。

`0031_audit_archive_controls.sql` 會把主要業務資料異動寫入 append-only `audit_events`，並建立 archive/lifecycle metadata；封存 finalize 與移除／還原事件只接受預設 `NOLOGIN` 的 `job_storage_cleanup`。`0032_durable_import_foundation.sql` 會建立預設 `NOLOGIN` 的 `job_import_worker` 與固定 `uniform-imports` bucket/key 的 upload batch；`confirm_import_upload` 只有該 job role 可執行，且必須先在 Storage object metadata 寫入並核對 MIME／size／SHA-256。`0033_worker_role_archive_import_forward.sql` 會把已套用舊 migration 的同名 role 強制回到 `NOLOGIN`，並把 durable `import_batches` 接入封存與稽核。`0034_worker_audit_identity.sql` 會要求部署者在受保護的 private schema 綁定 job role 與不可變的 `app_accounts.id`，並由資料庫推導 archive/lifecycle 的 actor 與 canonical fingerprint。`0074_import_staging_payload_retention.sql` 另建立預設 `NOLOGIN` 的 `job_import_retention`，專門負責滿 90 天 FAILED／CANCELLED DB staging payload scrub。部署時須在受保護環境對**同名 role**執行 `ALTER ROLE job_import_worker LOGIN PASSWORD '...'`／`ALTER ROLE job_storage_cleanup LOGIN PASSWORD '...'`／`ALTER ROLE job_import_retention LOGIN PASSWORD '...'`（密碼由 secret manager 注入，完成後可再 `NOLOGIN`），再由 DB owner 寫入 `private.job_actor_bindings`；不能另建 login role 後期待 `session_user` gate 通過，也不能把 service role 或 worker role 暴露給瀏覽器，任何 job role 的密碼／連線字串不進 repository 或前端。
`0035_durable_import_worker_rpcs.sql` 套用後，worker 只能以 `claim_import_chunk` 取得 PARSE／VALIDATE chunk lease，再以同一 token、generation、cursor version 完成或失敗；APPLY 前必須由使用者先呼叫 `confirm_import_batch`（批次層級確認會耐久保存，即使沒有差異列也不能省略），worker 再呼叫 `claim_import_apply` 取得 batch lease，最後把 token／generation／cursor 傳入 `apply_import_batch`。`0044_import_worker_forward.sql` 會在既有環境替換 APPLY claim，於取得 lease 前重驗批次確認、逐列 `proposed_action` 與 ERROR／未確認 diff；`0061_import_chunk_payload_bound.sql` 將完成 chunk 的 JSONB guard 提高至 25MB，以容納 10MB 檔案解析後的 JSON escaping，不放寬上傳檔案本身的 10MB／cell／row 上限；上述 migration 都不回寫既有匯入歷史，避免觸發 append-only／terminal guard。套用前確認 migration 順序完整、`private.job_actor_bindings` 已存在，並以受保護 job connection 執行 smoke：同一 chunk 的重複 claim、逾期 lease 接管、錯誤 fingerprint、EMPLOYEES preview 的 SKIP／確認與 PRE_CUTOVER 期初 once-only gate。`src/domain/import-worker-parser.ts` 必須由 worker 在提交 bounded rows 前呼叫，完成檔案簽章、UTF-8、ZIP bomb、公式（含命名空間標籤）、外部連結、NUL、列／欄／cell 上限驗證；瀏覽器不可直接呼叫 worker RPC。

`0036_account_role_scope_admin.sql` 套用後，先由受保護維運程序在 Supabase Auth 邀請使用者，再以 SYSTEM_ADMIN 面板把已存在的 Auth UUID 綁定成 `app_accounts`；面板可維護六角色、需求窗口的機構／部門範圍、帳號停用，以及帶理由的 Auth 綁定重設或解除。首次 SYSTEM_ADMIN 必須由 DB owner 依公司核准名單 seed `app_accounts` 與 `user_roles`（不使用 service role 給瀏覽器）；之後全部異動使用受保護 RPC，並寫入 operation command、綁定歷史與 audit event。角色與 scope 變更共用鎖，停用最後一位 SYSTEM_ADMIN 會 fail closed。帳號管理面板不會替 Supabase Auth 發邀請，也不會暴露 service-role key。

`0037_durable_import_storage.sql` 套用後，先在 Supabase Storage 建立／確認 private `uniform-imports` bucket，再由登入使用者在「耐久匯入」面板建立 `AWAITING_UPLOAD` batch 並直傳資料庫核發的不可覆寫 key。Storage policy 只允許該批次建立者在期限內 INSERT 同一 key，禁止 authenticated UPDATE／DELETE；worker 仍須以受控同名 `job_import_worker` 連線核對 object metadata／SHA-256、解析 chunk、填入逐列差異，使用者再呼叫 `confirm_import_batch` 後才 APPLY。`0037` 的 filename/MIME check 以 `NOT VALID` 方式向前相容；若舊批次存在不匹配資料，必須由受控維運程序先逐筆封存／取消，再執行 `VALIDATE CONSTRAINT`，不要在 migration owner session 直接改動 append-only 匯入資料。`0038_durable_import_recovery.sql` 提供重開頁面後以原匯入冪等鍵查回批次，並禁止同一上傳 key 跨匯入類型重用。`0040_renderer_storage_key_fence.sql` 與 `0041_renderer_download_and_generation_fence.sql` 會把 PDF／ERP renderer role 的 Storage 讀寫限制到該 worker 目前持有、且尚未逾期的 generation-specific attempt key；資料庫 role 不再直接 INSERT／SELECT `storage.objects`，實際物件上傳必須由受保護的 renderer Storage client 完成。下載則先由 audited download RPC 建立兩分鐘 grant，再由瀏覽器建立短效 signed URL；不要直接對 READY key 建 signed URL。套用後請以兩個受控 worker connection 各做一次「claim → upload reserved generation key → finalize」並測試舊 generation key 被拒，另以兩個登入角色測試 download grant 與 ERP download event。未配置 worker 時，畫面會明確停在等待確認，不會假稱匯入完成。

`0041_renderer_download_and_generation_fence.sql` 另建立 generation-specific object key、撤銷 renderer role 對 `storage.objects` 的直接 DML，並由 `scripts/renderer/storage-proxy.mjs` 以 `job_renderer_storage_proxy` 受控 proxy 代為操作 Storage；Storage Admin credential 只存在 loopback/private proxy，不能傳給 adapter 或瀏覽器。

`0045_import_worker_snapshot_and_storage.sql` 提供 `list_import_work`、`get_import_reference_snapshot` 與 import object read capability。受控 worker 以 `npm run import:worker -- --once`（或移除 `--once` 持續輪詢）讀取同一個 private storage proxy，先用 `src/domain/import-worker-parser.ts` 驗證並解析檔案，再以 `src/domain/import-worker.ts` 依員工工號、制服品號、供應商條件及倉庫／品號鍵產生 INSERT／UPDATE／SKIP／ERROR preview，逐一完成 PARSE／VALIDATE chunk；使用者確認後才取得 batch lease 並呼叫 APPLY。worker 只持有 DB worker connection 與 proxy token，不持有 Storage Admin key；proxy 只允許 exact `uniform-imports` batch key，已確認批次即使 upload TTL 到期仍可讀取，終端批次則拒絕。部署 smoke 必須涵蓋一列更新、一列略過、一列錯誤、逾期 chunk 接手、max-attempt FAILED、response-loss 後同一 batch／object key 重試。

部署綁定範例（值由 secret manager／受控維運程序注入，不要提交）：

```sql
alter role job_import_worker login password '<secret-managed-password>';
alter role job_document_renderer login password '<secret-managed-password>';
alter role job_erp_renderer login password '<secret-managed-password>';
alter role job_renderer_storage_proxy login password '<secret-managed-password>';
alter role job_storage_cleanup login password '<secret-managed-password>';
alter role job_import_retention login password '<secret-managed-password>';
insert into private.job_actor_bindings (db_role, account_id)
values
  ('job_import_worker', '<dedicated-worker-app-account-uuid>'),
  ('job_document_renderer', '<dedicated-document-renderer-app-account-uuid>'),
  ('job_erp_renderer', '<dedicated-erp-renderer-app-account-uuid>'),
  ('job_renderer_storage_proxy', '<dedicated-renderer-proxy-app-account-uuid>'),
  ('job_storage_cleanup', '<dedicated-worker-app-account-uuid>'),
  ('job_import_retention', '<dedicated-import-retention-app-account-uuid>')
on conflict (db_role) do update
set account_id = excluded.account_id, is_active = true;
```

所有 job worker 必須使用其 migration 建立的同名連線 role，且各自的 DB／Storage secret 僅存在受保護 job；若不啟用 worker，保持 `NOLOGIN`，相關 RPC 會 fail closed。啟用時請限制該 role 的 `CONNECT`／網路來源與必要資源範圍，並在工作完成後依維運政策撤回 LOGIN。

PDF／ERP renderer runner 已納入 `scripts/renderer/renderer-worker.mjs`。以同名受控 role 分別執行 `npm run renderer:pdf` 或 `npm run renderer:erp`，並提供 `DATABASE_URL`、`RENDER_STORAGE_PROXY_URL`、`RENDER_STORAGE_PROXY_TOKEN`、`RENDER_COMMAND`；若 command 需要固定前置參數，使用受保護環境的 JSON 字串陣列 `RENDER_COMMAND_ARGS`。另以同名受控 `job_renderer_storage_proxy` role 執行 `npm run renderer:storage-proxy`，只有 proxy 持有 `SUPABASE_STORAGE_ADMIN_KEY`。adapter 必須接受 `--attempt-id`、`--payload`（版本化 immutable DTO）／`--output` 並產生對應 PDF 或 ERP payload。`scripts/renderer/adapters/uniform-erp-sales-v0.mjs` 可作為內部 smoke adapter（例如 `RENDER_COMMAND=node`、`RENDER_COMMAND_ARGS=["scripts/renderer/adapters/uniform-erp-sales-v0.mjs"]`），但不是鼎新正式 mapping；`scripts/renderer/adapters/uniform-pdf-smoke-v0.mjs` 同樣只供 deterministic PDF staging smoke。`npm run deployment:renderer-smoke` 會用真實 `job_document_renderer`／`job_erp_renderer`／`job_renderer_storage_proxy` LOGIN 與 active actor bindings 驗證 PDF/ERP claim→payload→proxy upload→finalize、generation/key stale fencing、ERP retry／terminal failure／upload-response-loss recovery、PDF historical READY revisions、STOCKTAKE request/download role matrix及 Storage Admin bytes/hash。它會寫 synthetic staging fixture，必須使用 disposable-staging gates；DB-side synthetic JWT 驗證不能取代真實 Supabase Auth／Storage RLS signed-URL smoke。runner 只呼叫 lease-fenced claim／heartbeat／retry／finalize RPC，Storage key 由資料庫 attempt 保留，不能由瀏覽器或 service role 直接寫業務表。此 worker 尚需部署環境注入 secrets、同名 LOGIN 與 `private.job_actor_bindings` 後才會實際產生 READY；未配置時 PREPARING 是預期的 fail-closed 狀態。

## Storage cleanup

`0071_storage_cleanup_contract.sql` 建立 Storage cleanup 的 DB-authoritative eligibility；`0072_import_terminal_retention.sql` 再為 durable import 增加可靠 `terminal_at`。兩者只讓同名 `job_storage_cleanup` LOGIN 搭配 active `private.job_actor_bindings` 執行 cleanup RPC，候選只來自固定 `uniform-imports`、`uniform-pdf`、`uniform-erp` bucket 與固定 object-key 格式，且 `coalesce(storage.objects.updated_at, storage.objects.created_at)` 至少滿 24 小時。FAILED／CANCELLED import 的 source object 只有在目前 terminal episode 已滿 90 天時才成為 `TERMINAL_IMPORT_90D`；既有 terminal rows 在套用 0072 時保守地從 migration 當下重新起算完整 90 天。任何仍被 artifact 引用的 key、READY／SUCCEEDED/current attempt、APPLIED 或仍在處理中的 import 都 fail closed；runner 不得自行放寬條件，也不得重設 lease 或刪除 import batch／row／diff 等 DB evidence。

DB staging payload retention 與上述 Storage bytes cleanup 分離。`0074_import_staging_payload_retention.sql` 只讓同名 `job_import_retention` LOGIN 搭配 active actor binding 執行 `list_import_staging_retention_candidates`／`purge_import_staging_payload`；該 role 沒有 `import_batches`／`import_batch_chunks`／`import_rows`／`import_field_diffs` 的一般 table DML。候選必須仍為 FAILED／CANCELLED、目前 `terminal_at` episode 已滿 90 天且 `staging_purged_at IS NULL`。purge 先鎖 batch 並重驗資格，只 scrub `import_rows.raw_values`、`normalized_values`、`validation_errors`，不 DELETE row/chunk/diff，最後在同一交易設定 `staging_purged_at`；已 purge batch 不得 restart，需要重新匯入時建立新 batch。`job_storage_cleanup` 不得被用來執行這個 DB staging purge。

DB staging retention runner 預設只列出候選，不修改資料：

```powershell
$env:IMPORT_RETENTION_DATABASE_URL = "<job_import_retention-login-url>"
npm run retention:import-staging
```

真正 scrub 必須同時使用 CLI 與環境變數兩道 gate；runner 不接受其他 DB role，也不自行重算 90 天 eligibility，真正資格仍由 `purge_import_staging_payload` 在 batch row lock 後重驗：

```powershell
$env:IMPORT_RETENTION_DATABASE_URL = "<job_import_retention-login-url>"
$env:IMPORT_RETENTION_EXECUTE_CONFIRM = "PURGE_ELIGIBLE_IMPORT_STAGING"
npm run retention:import-staging -- --execute
```

`.github/workflows/import-staging-retention.yml` 的每日 cron 刻意只跑 dry-run；手動 execute 需輸入 `PURGE_ELIGIBLE_IMPORT_STAGING` 並使用 protected `staging-import-retention` environment。正式啟用 destructive cron 前，仍必須在真實 PostgreSQL staging 以符合 90 天／不符合 90 天／已 purge／restart race fixture 驗證 RPC lock/recheck、payload scrub、evidence 保留與 `staging_purged_at`。

先以只讀模式檢視候選：

```powershell
$env:CLEANUP_DATABASE_URL = "<job_storage_cleanup-login-url>"
npm run cleanup:storage
```

真正刪除需要同時滿足 CLI 與環境變數兩道 gate，並只在受保護 staging/production job 注入 Storage Admin credentials：

```powershell
$env:CLEANUP_DATABASE_URL = "<job_storage_cleanup-login-url>"
$env:CLEANUP_SUPABASE_URL = "https://<project-ref>.supabase.co"
$env:CLEANUP_STORAGE_ADMIN_KEY = "<protected-storage-admin-key>"
$env:CLEANUP_EXECUTE_CONFIRM = "DELETE_ELIGIBLE_STORAGE"
npm run cleanup:storage -- --execute
```

execute 對每個候選 DELETE 前都會再次呼叫 `confirm_storage_cleanup_candidate`；若 DB 已不再確認，該物件直接跳過。Storage DELETE 的 2xx 記為 `DELETED`，404 視為冪等 `ALREADY_MISSING`，其他結果記為 `FAILED`，每次結果都寫入 append-only `storage_cleanup_events`。runner 不接受任意 bucket/path CLI 參數，也不把 DB URL 或 Storage Admin key 寫入 log。

`.github/workflows/storage-cleanup.yml` 的每日 cron 目前刻意只跑 dry-run；手動 execute 需輸入 `DELETE_ELIGIBLE_STORAGE` 並使用 protected `staging-storage-cleanup` environment。正式啟用 destructive cron 前，必須先在真實 staging credentials 下完成至少一次候選列出、DB recheck、實際 DELETE／404 冪等與 audit event smoke，保存 PASS/FAIL 證據後再另行決策；目前不能把 workflow 存在等同於 destructive cleanup 已驗收。

備份／還原固定入口已納入版本庫：`scripts/backup/export-db.sh` 以 protected `SUPABASE_DB_URL` 匯出 `public`／`private` application dump，`scripts/backup/export-auth.sh` 以 data-only dump 保留 Auth UUID／identities／MFA factors，`scripts/backup/export-storage.mjs` 只處理程式固定 allowlist（`uniform-imports`、`uniform-artifacts`、`uniform-render-temp`、`uniform-pdf`、`uniform-erp`）中的 private objects，並由 `scripts/backup/create-manifest.mjs` 建立 SHA-256 manifest。DB metadata 另外保存八個關鍵 application table 筆數；Auth metadata 保存 users／identities／MFA factors 筆數。Manifest 重建會先取得同 generation 的 `manifest.json.lock`；已有 lock 時 fail closed 且不偷鎖。每個來源檔會在雜湊前後比對檔案 identity、size、mtime／ctime，完成後再重掃 generation 檔案集合；掃描期間有來源變動就拒絕發布新 manifest。成功重建則先在同一目錄完成私有暫存檔，再以 rename 原子替換正式 `manifest.json`，避免中斷留下半份 JSON。`BACKUP_RUN_ID` 只允許以英數字開頭、後續使用英數字／`.`／`_`／`-`，最長 80 字元；DB、Auth、Storage 與 GitHub Actions 共用同一驗證，避免 generation 路徑跳脫。Auth 階段只接受已完成且 manifest 可驗證的 DB generation，Storage 階段也要求 DB/Auth 輸出完整，且兩者都拒絕覆寫同一 generation 的既有輸出。`scripts/backup/verify-manifest.mjs` 會重新核對 generation 的完整檔案集合、bytes 與 SHA-256；`--for-offsite` 另會拒絕仍含 `application.dump`／`auth-data.sql` 明文的 generation。Backup workflow 在加密後重建並驗證 manifest 才允許 offsite handoff；generation 路徑與 run id 都不拼入 shell command，`BACKUP_ENCRYPT_COMMAND` 與 `BACKUP_OFFSITE_COMMAND` 必須分別使用 `$1` 取得 generation directory、`$2` 取得已驗證的 `BACKUP_RUN_ID`。從零還原會先確認 `node`、`pg_restore`、`psql` 均可用，再驗證 ciphertext generation；之後以 `scripts/restore/assert-empty-target.sql` 確認目標仍是乾淨 Supabase：必要 Auth table 必須存在且 users／identities／MFA factors 無資料，`public`／`private` 不得已有非 extension-owned 的 table/view/sequence/routine/enum/domain。這個 target guard 必須在雙人解密前通過，因此誤指向已有應用資料的 project 會在產生 plaintext 或 `pg_restore` 寫入前 fail closed。缺少任何工具、備份驗證失敗或目標非空都不得進入解密。解密後會重建／驗證本地 manifest，並先驗證 `database-metadata.json`／`auth-metadata.json` 格式，之後才允許 `pg_restore`。資料庫與 Auth 寫回後，`scripts/restore/verify-metadata.mjs` 會重新讀取目標 users／identities／MFA factors 筆數；新 generation 也會逐項核對八個 application table 筆數，任一 drift 都 fail closed。舊 generation 若尚無 `application_counts` 仍可還原，但只保留 Auth count 驗證並明確標示 legacy；不以 migration head 相等作為還原成功條件，因 application dump 本身不包含 `supabase_migrations` schema。Storage 還原前可先設定 `BACKUP_RUN_DIR`，執行 `node scripts/restore/restore-storage.mjs --validate-only` 做純本機驗證；此模式不需要 Supabase credentials，會驗證 manifest schema、bucket allowlist、物件路徑與備份 bytes／SHA-256，且不發出 Storage request。從零還原使用 `scripts/restore/restore-from-zero.sh`，需要明確 `CONFIRM_RESTORE=YES`、`BACKUP_DECRYPT_COMMAND`（雙人程序在受保護 staging 解密 application/Auth dump）、新目標資料庫及 Storage Admin credentials；generation 路徑不會被拼入 shell command，而會以位置參數傳入，受保護的 `BACKUP_DECRYPT_COMMAND` 必須使用 `$1` 取得 `BACKUP_RUN_DIR`。最後才執行 `scripts/restore/verify.sql`。GitHub Actions 的 `.github/workflows/backup.yml` 目前刻意只能手動執行；必須先在受保護 environment 設定上述 positional-argument command contract、加密金鑰與雙人保管資料，才可考慮排程，不宣稱 AC-38／RPO/RTO 已通過。

Storage restore 的本機 safety gate 另外要求五個固定 private bucket 在 `storage-manifest.json` 中各出現一次、每個 object path 精確對應 `storage/<bucket>/<name>`，且 restore target 不可重複；`--validate-only` 會在完全不發出 Storage request 的情況下先核對這些條件與備份 bytes／SHA-256。實際還原若 bucket 已存在，只接受查回後確認仍為 private 的 bucket；object upload 的 HTTP 409 一律 fail closed，不會把既有 object 衝突誤報為已還原。每個 object POST 成功後還會立即從目標 private Storage 讀回 bytes，重新核對 byte length 與 SHA-256；讀回失敗或 bytes/hash 不一致都 fail closed，不會把只收到 upload 2xx 視為已驗證還原。這些 repository-local 防線不等同真實 Supabase Storage 從零還原已驗收。

## Vercel

Renderer storage proxy deployment note: `job_renderer_storage_proxy` is a separate NOLOGIN role in migration 0041. If renderer is enabled, the protected deployment must run `ALTER ROLE job_renderer_storage_proxy LOGIN PASSWORD '<secret-managed-password>'` on that exact role and keep the proxy listening on loopback or a private network. The renderer runner receives only the proxy URL/token; the Storage Admin credential is never passed to the adapter or browser.

1. Import `Kevin72333/uniform-co`，Production branch 選 `main`。
2. Preview 使用 staging Supabase URL/key；Production 使用 production URL/key；不要在 Vercel Project Settings 複用錯環境。
3. 開啟 Preview deployment protection，確認 Preview 無法取得 production secret 或寫入 production 資料。
4. 第一次 Production deploy 後驗證：登入、RLS 讀取、HR request 預覽、A4 列印、錯誤頁與 server logs。

## 錯誤監控基線

根目錄 `instrumentation.ts` 透過 Next.js `onRequestError` 捕捉 server request error，並交給 `src/server/error-monitoring.ts` 輸出 `[error-monitoring]` 結構化事件。事件只允許 `event`、`version`、`timestamp`、已分類的 `environment`、route template `routePath`、`routerKind`、`routeType`、固定分類的 `errorKind`、格式受限的 Next `digest`（若有）與不可逆 SHA-256 `fingerprint`；不得記錄原始 error message／stack、request body、headers、Authorization、cookie、token、URL query、DB URL 或其他 secret。`src/app/error.tsx` 只向使用者顯示通用錯誤頁與重試按鈕，不在瀏覽器輸出 raw error。

這是 provider-neutral logging baseline，不代表 production 外部錯誤監控、告警路由或 incident smoke 已驗收。正式上線前仍須選定 log drain／error provider 與 on-call owner，若 provider 需要 token 或 DSN 類 secret，必須先登錄 `secret-inventory.md` 再配置；之後以不含真實資料的受控錯誤驗證事件可抵達 provider、fingerprint 可搜尋、告警能送達正式維運路徑。未完成這個外部 smoke 前，不得把「錯誤監控」標記為 production complete。

## 三年容量／配額 gate

先把 `docs/deployment/onboarding/templates/capacity-assumptions.example.json` 複製到 `docs/deployment/onboarding/private/capacity-assumptions.json`，再用公司核准的數量、保存期間及容量假設填寫。不要直接覆寫或提交版本化 example。

```powershell
npm run capacity:plan -- --input docs/deployment/onboarding/private/capacity-assumptions.json
npm run capacity:plan -- --input docs/deployment/onboarding/private/capacity-assumptions.json --json
```

第一條用人工可讀輸出檢查 300／350／425 MB DB 與 600／700／850 MB Storage gate；第二條可保存到受保護 release evidence。`estimate` 永遠只是模型結果，不能代替 staging 實測。正式容量驗收必須另外以完整 schema 生成三年 synthetic data，記錄 `pg_database_size`、table/index/TOAST、Storage bucket bytes、主要查詢／匯入／PDF／ERP／並行庫存尖峰、完整備份與從零還原，並把實測 bytes 與 30 天 egress／Actions quota ratio 回填為 `STAGING_SYNTHETIC` evidence。只有工具回報 `capacityValidation.status=VALIDATED` 才代表「容量這一個 gate」通過；它不代表其他 production cutover gate 已通過。

## Production release gate

正式切換前，保留 `docs/deployment/onboarding/templates/release-evidence.example.json` 為不可當作正式證據的 fail-closed template；不要直接修改它。使用 helper 建立受保護、已被 Git 忽略的正式 evidence 檔：

```powershell
npm run deployment:release-evidence -- init --release-id release/2026-08-29
```

初始化結果一定是 17 個 gate 全部 `PENDING`、狀態 `NOT_READY`，且不會覆寫既有 `private/release-evidence.json`。每一項真實驗收完成並取得非 secret evidence path／ID 後，再記錄該 gate；例如：

```powershell
npm run deployment:release-evidence -- record --gate rlsSixRole --source STAGING_SMOKE --evidence-reference evidence/staging/rls-six-role-20260829
```

`record` 只接受 release gate 已知的 gate、該 gate 核准的 source 與安全 evidence reference，並在寫入前以同一套 release-gate validator 驗證整份檔案。它不會連線 production、不執行 migration、不做 Storage DELETE，也不會把 evidence reference 印到 console。

若已通過的 evidence 後續失效、撤銷、過期或需要重新驗證，先 fail closed，不要保留舊 PASS：

```powershell
npm run deployment:release-evidence -- block --gate rlsSixRole
```

`block` 只接受既有正式 evidence 與已知 gate，會把該 gate 重設為 `passed=false`、`source=PENDING`、空 `evidenceReference`。`record` 與 `block` 會先取得 `<release-evidence.json>.lock` 的獨占鎖，再讀取最新正式 evidence、驗證完整 schema，最後以同目錄暫存檔原子替換；因此同時執行的第二個更新會 fail closed，不會用較舊快照蓋掉另一個維運者剛記錄的 gate。正常完成或驗證失敗都會清掉自己持有的 lock；若程序 crash 留下 stale lock，先確認沒有 evidence update 仍在執行、保留必要調查資訊後再人工刪除，工具不會自動判定 stale lock 已安全。版本化 TEMPLATE 永遠拒絕被這兩個命令修改。

```powershell
npm run deployment:release-gate -- --input docs/deployment/onboarding/private/release-evidence.json
npm run deployment:release-gate -- --input docs/deployment/onboarding/private/release-evidence.json --json
```

Release gate 集中檢查 repository/deployment smoke、staging migration、六角色 RLS、private Storage／signed URL／ACL、durable import／worker／concurrency、renderer／PDF／ERP、Storage destructive cleanup、DB 90-day retention、從零還原、RPO／RTO、三年容量、外部 error monitoring、鼎新成功匯入、正式 PDF 樣式、第一批正式帳號、owner／backup owner 移交與 production cutover approval。每個 passed gate 都必須有核准 evidence source 與非空 evidence path／ID；schema 未知、gate 缺失、來源不符或 evidence reference 缺失都 fail closed。`NOT_READY` 的 process exit code 是 1，輸入格式錯誤是 2，只有 `READY` 是 0。

這個 harness 不會連線 production、不執行 migration、不刪除 Storage、不發布期初，也不讀取 secret。Harness 已完成只代表 repository 有統一判讀器；真實外部 evidence 未齊前不得宣稱 production cutover 已驗收。

## Migration deploy（建議由維運手動核准）

GitHub Actions 的 `Supabase migrations (manual)` workflow 只允許選擇 `staging` 或 `production`，不接受手動輸入 project ref。兩個目標分別使用受保護的 `supabase-staging-migrations`／`supabase-production-migrations` GitHub Environment；各 Environment 必須自行設定 `SUPABASE_ACCESS_TOKEN`、`SUPABASE_PROJECT_REF`、`SUPABASE_DB_PASSWORD` secrets，production Environment 應設定 required reviewers。執行時還必須依目標輸入 `STAGING_MIGRATION` 或 `PRODUCTION_MIGRATION`，避免誤選環境後直接套用 migration。

若需在受保護維運終端手動執行，可使用同一組環境變數：

```powershell
$env:SUPABASE_ACCESS_TOKEN = "<protected-token>"
npx supabase@latest link --project-ref <staging-ref>
npx supabase@latest db push
```

Production 執行前要先備份、確認目前 migration version、在 staging 以合成資料重跑，再由第二位維運者核准。不要在 production 使用 `db reset`。

## 期初切換

- 先使用 `create_opening_balance_batch` 做完整預覽；任一錯誤都不會寫入正式餘額。
- 只有 SYSTEM_ADMIN 可呼叫 `publish_opening_balance`；此 RPC 會鎖定 `system_cutover_state` singleton，建立唯一 OPENING posting／ledger，並將狀態轉 `LIVE`。
- `LIVE` 後不可再次發布期初；非期初 inventory posting 在 `PRE_CUTOVER` 由 database trigger 阻擋。

## 鼎新 ERP 依賴

目前只提供 `UNIFORM-ERP-SALES-v0` 示範 renderer 與 immutable logical batch／artifact request。要完成正式匯入，仍需提供鼎新版本、成功原始檔、欄位長度／固定值、編碼與更正／退回單別；收到樣本後再建立版本化 adapter 與 golden-file test。

## 事故與回復底線

- 回應逾時先用同一 idempotency key 查詢 operation command，不直接重做。
- 發現 migration／RLS 不一致先停止正式 cutover，不刪除正式 ledger 或 READY artifact。
- 備份／還原與 offsite credentials 尚未配置前，不宣稱 AC-38 或 production RPO/RTO 已通過。

Durable import worker deployment also applies `0046_import_chunk_split_forward.sql`, `0047_import_worker_confirmation_actor.sql`, `0048_import_upload_failure.sql`, `0056_import_worker_actor_forward.sql`, `0058_import_chunk_legacy_split.sql`, and `0061_import_chunk_payload_bound.sql`; the worker confirms uploads, reuses immutable master snapshots, processes bounded chunks, and durably marks definitive parser failures. `0056` separates the dedicated worker execution actor from the original uploader attribution, so the worker can confirm the object without impersonating the user who uploaded it. `0058` repairs only untouched, oversized PARSE chunks left by pre-0046 batches while holding the batch lock. `0061` keeps the 10MB upload limit and raises only the JSONB completion envelope guard to 25MB. Claim keys are generated per lease attempt, while the database worker role and actor binding remain fixed.

`0050_return_correction.sql` 套用後，HR 可從已 POST 退回明細建立 RETURN correction；只有受保護 `create_return_correction_draft`／`post_return_correction` RPC 能寫入，POST 會鎖原退回單、原發放明細、品號 mutex、兩倉餘額及必要的預留集合，重算有效退回量並以本次 delta 調整人資倉。`ReturnCorrectionPanel` 以同一冪等鍵查回建立／POST 結果，展示已 POST 歷史；staging 必須驗證同一原發放明細的退回、退回更正並行時只有鎖後仍合法者成功。

`0051_hr_issue_correction.sql` 套用後，HR 可從已 SHIPPED 發放明細建立 HR_ISSUE correction；只有 `create_hr_issue_correction_draft`／`post_hr_issue_correction` RPC 能寫入，正數補登會扣 HR 倉、負數沖回會回補 HR 倉，且鎖內重算 effective issued、已退回量與 active reservations。`HrIssueCorrectionPanel` 保留操作鍵與歷史，staging 必須驗證 HR_ISSUE、RETURN、RETURN correction 對同一原發放明細並行時的來源鎖與數量上限。

`0052_correction_source_advisory.sql` 需在 0050、0051 後套用；它以同一 HR request 的 transaction advisory lock 統一不同品號的人資發放／退回更正，staging 應驗證並行交易不形成 item-mutex／需求列死結，失敗者以 40001 重試。

`0053_return_reason_codes.sql` 套用後，先確認 `return_reason_codes` 的正式代碼已由 SYSTEM_ADMIN 維護；退回工作台只呼叫含 `p_return_date`／`p_reason_code` 的新建立 RPC，舊無原因碼 signature 必須維持 revoked。歷史資料會保留 `LEGACY` 相容值，新退回單不得使用停用代碼。

`0054_warehouse_transfer_correction.sql` 套用後，WAREHOUSE 可從已 POST 發貨或 SHIPPED 補庫明細建立更正；`post_warehouse_transfer_correction` 會鎖來源與品號、重算有效調撥量及兩倉餘額，並以同一 operation key 查回結果。staging 必須驗證正負差額、上限、負庫存、同品號並行鎖與跨來源 response-loss recovery。

`0055_stocktake_correction.sql` 套用後，HR／WAREHOUSE 可從各自允許的已 POST 盤點明細建立更正；`post_stocktake_correction` 會鎖盤點、明細、品號、兩倉餘額及受影響預留，將不足覆蓋的需求轉為 `INVENTORY_REVIEW_REQUIRED` 後再完成更正流水。staging 必須驗證盤點差額、角色、負庫存、預留衝突與同 key 查回。

`0057_correction_source_immutability_forward.sql` 必須在 0055 後套用；它只替換既有 trigger function，不改寫業務資料，並將 `original_stocktake_id` 納入 DRAFT／POSTED 更正來源不可變檢查。staging 應嘗試修改盤點更正來源並確認被拒絕。

`0059_receipt_correction_lockset_forward.sql` 必須在 0049 後套用；它在採購入庫更正處理預留衝突前重驗需求／品號集合，集合變動時以 40001 讓 caller 重試，避免跨品號更正持有部分鎖集合。

`0060_pdf_document_type_coverage.sql` 必須在 0039／0041 後套用；它補齊八類 PDF 單據的來源鎖、canonical snapshot hash、renderer payload、角色授權與下載 policy。`0062_renderer_metadata_null_guard.sql` 必須在 0039 後套用，讓 finalize 對缺失／空白 Storage hash 或 size 一律拒絕，並以 `nullif` 正確 fallback 到 user metadata。staging 必須逐一以 HR、WAREHOUSE、PROCUREMENT、CEO 驗證允許／拒絕矩陣，並對正式來源與草稿浮水印各跑一次 claim→payload→upload→finalize→download。

`0063_reporting_views.sql` 建立 security-invoker 的 `v_item_availability`、`v_hr_request_item_totals`、`v_pending_warehouse_shipments`、`v_inventory_history`、`v_employee_distribution_history`、`v_seasonal_demand_summary`、`v_purchase_order_receipt_progress`、`v_erp_export_candidates` 與 `v_audit_event_history`。報表不維護另一份庫存／採購數字；畫面只讀取 view，底層業務表的 RLS 仍是最後授權邊界。staging 應以 HR、WAREHOUSE、PROCUREMENT、CEO、DEMAND_COORDINATOR 各跑一次可見／不可見資料矩陣，並確認稽核 view 不會讓非稽核角色讀到 `audit_events`。

`0064_reporting_receipt_aggregation.sql` 必須在 0063 後套用；它只替換報表 view，不回寫採購或入庫資料，並先按原始 receipt line 合併已 POSTED 更正，再按 purchase order line 計算 effective delivered／accepted／rejected。staging 應建立同一 PO line 的兩張以上 POSTED 入庫單及一筆更正，確認報表數量等於各筆有效數量總和而非被入庫張數倍增。

`0065_inventory_history_source_number.sql` 必須在 0063／0064 後套用；它只替換 `v_inventory_history`，依 posting kind 解析來源單號（發貨、補庫、入庫、盤點、退回、更正、期初），不改動流水。staging 應確認報表同時顯示可讀來源單號與不可變 `source_entity_id`。

`0066_inventory_history_source_acl.sql` 必須在 0065 後套用；它只對 `opening_posting_sources`／`correction_posting_sources` 授予 authenticated SELECT，且 RLS 限 HR／WAREHOUSE，沒有任何 INSERT／UPDATE／DELETE。staging 應確認 HR／WAREHOUSE 可讀流水來源單號，其他角色不因該映射表 grant 擴大庫存歷史可見範圍。
