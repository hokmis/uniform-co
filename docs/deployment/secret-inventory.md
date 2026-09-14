# Secret inventory

這份文件只記錄「名稱、用途、權限與保存位置類型」，不保存任何真實值、project ref、密碼、token、連線字串或正式聯絡資料。staging 與 production 必須使用不同 secret record；能以專用 job role 完成的工作，不得改用 service-role 或 owner credential。

## 分類規則

- **Public config**：可以送到瀏覽器，但仍需按 staging／production 分開設定。
- **Protected config**：本身未必是密碼，但只應由受保護部署／維運環境注入，避免跨環境誤用。
- **Secret**：可直接取得資料、管理 Auth／Storage、登入資料庫或觸發外部受保護程序；不得出現在 repository、前端 bundle、log、issue、PR 內容或一般聊天紀錄。
- `NEXT_PUBLIC_*` 只允許瀏覽器安全設定。任何名稱含 `SERVICE_ROLE`、`SECRET`、`ADMIN`、`DATABASE`、`PASSWORD`、`TOKEN` 的值都不得改成 `NEXT_PUBLIC_*`。

## 版本化 inventory

| 名稱 | 分類 | 使用元件 | 環境／權限 | Browser-safe | 建議保存位置 | Owner / rotation |
| --- | --- | --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public config | Next.js browser client | staging / production 各自 project URL | Yes | Vercel Preview / Production env | `<assign owner>` / project change |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public config | Next.js browser client | staging / production anon key，仍受 RLS 約束 | Yes | Vercel Preview / Production env | `<assign owner>` / project key rotation |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | server Auth admin、backup／restore Storage | 高權限 server-only；不得給 browser／worker adapter | No | Vercel server env、backup/restore secret manager；各環境分離 | `<assign owner>` / rotate on exposure or policy |
| `SUPABASE_SECRET_KEY` | Secret | server Auth admin 的替代名稱 | 與 service-role 等級相同；只允許 server-only | No | Vercel server env / secret manager | `<assign owner>` / rotate on exposure or policy |
| `SUPABASE_ACCESS_TOKEN` | Secret | Supabase migration workflow | CLI 管理權限 | No | GitHub Environment `supabase-staging-migrations` / `supabase-production-migrations` | `<assign owner>` / provider policy |
| `SUPABASE_PROJECT_REF` | Protected config | Supabase migration workflow | staging / production target selector；必須分環境 | No | GitHub Environment `supabase-staging-migrations` / `supabase-production-migrations` | `<assign owner>` / project change |
| `SUPABASE_DB_PASSWORD` | Secret | Supabase migration workflow | migration DB password | No | GitHub Environment `supabase-staging-migrations` / `supabase-production-migrations` | `<assign owner>` / rotate on exposure or policy |
| `STAGING_DATABASE_URL` | Secret | read-only / active staging smoke | staging owner 或 maintenance connection；只在 disposable staging smoke 使用寫入能力 | No | protected staging secret manager/runtime | `<assign owner>` / rotate on exposure or policy |
| `IMPORT_WORKER_DATABASE_URL` | Secret | durable import worker | 必須直接登入同名 `job_import_worker` | No | protected worker runtime | `<assign owner>` / worker credential rotation |
| `DATABASE_URL` | Secret | renderer worker；import worker fallback | 必須對應該 worker 的最小權限同名 DB role | No | protected worker runtime | `<assign owner>` / worker credential rotation |
| `DOCUMENT_RENDERER_DATABASE_URL` | Secret | renderer active smoke | 必須直接登入 `job_document_renderer` | No | protected disposable-staging smoke runtime | `<assign owner>` / worker credential rotation |
| `ERP_RENDERER_DATABASE_URL` | Secret | renderer active smoke | 必須直接登入 `job_erp_renderer` | No | protected disposable-staging smoke runtime | `<assign owner>` / worker credential rotation |
| `RENDER_STORAGE_PROXY_DATABASE_URL` | Secret | renderer Storage proxy / smoke | 必須直接登入 `job_renderer_storage_proxy` | No | private proxy runtime / protected staging runtime | `<assign owner>` / proxy credential rotation |
| `RENDER_STORAGE_PROXY_TOKEN` | Secret | renderer worker ↔ private Storage proxy | shared bearer token；只在 worker/proxy private network | No | worker + proxy secret manager | `<assign owner>` / rotate on exposure or policy |
| `IMPORT_STORAGE_PROXY_TOKEN` | Secret | import worker ↔ private Storage proxy | import-specific token；可按部署明確回退至 `RENDER_STORAGE_PROXY_TOKEN` | No | import worker + proxy secret manager | `<assign owner>` / rotate on exposure or policy |
| `RENDER_STORAGE_PROXY_URL` | Protected config | renderer worker / import fallback | loopback/private-network proxy endpoint | No | protected worker runtime | `<assign owner>` / topology change |
| `IMPORT_STORAGE_PROXY_URL` | Protected config | import worker | import worker 的 private proxy endpoint | No | protected worker runtime | `<assign owner>` / topology change |
| `SUPABASE_URL` | Protected config | renderer proxy、backup、restore | server-side project endpoint；不得與 production credential 混用 | No | protected runtime / GitHub Environment | `<assign owner>` / project change |
| `SUPABASE_STORAGE_ADMIN_KEY` | Secret | renderer Storage proxy / renderer smoke | Storage Admin；只允許 private proxy 或受保護 smoke harness 持有 | No | private proxy secret manager / protected staging runtime | `<assign owner>` / rotate on exposure or policy |
| `SUPABASE_DB_URL` | Secret | DB/Auth backup workflow | production backup DB connection | No | GitHub Environment `backup-production` | `<assign owner>` / rotate on exposure or policy |
| `BACKUP_ENCRYPT_COMMAND` | Secret | backup workflow | 受保護加密程序；可能包含 key locator／credential，使用 `$1` generation dir、`$2` run id | No | GitHub Environment `backup-production` | `<assign owner>` / key custody policy |
| `BACKUP_OFFSITE_COMMAND` | Secret | backup workflow | 受保護 offsite handoff；可能包含 remote credential，使用 `$1` generation dir、`$2` run id | No | GitHub Environment `backup-production` | `<assign owner>` / remote credential rotation |
| `BACKUP_DECRYPT_COMMAND` | Secret | restore-from-zero | 雙人保管的解密程序；使用 `$1` generation dir | No | two-person protected restore runtime | `<assign owner>` / key custody policy |
| `TARGET_DATABASE_URL` | Secret | restore-from-zero | 全新 local／隔離 staging restore target；不得指向 production | No | protected restore runtime | `<assign owner>` / ephemeral target lifecycle |
| `CLEANUP_DATABASE_URL` | Secret | Storage cleanup workflow / runner | 必須直接登入 `job_storage_cleanup` | No | GitHub Environment `staging-storage-cleanup` / protected runtime | `<assign owner>` / job credential rotation |
| `CLEANUP_SUPABASE_URL` | Protected config | destructive Storage cleanup | staging Storage endpoint；只與 cleanup admin key 成對注入 | No | GitHub Environment `staging-storage-cleanup` / protected runtime | `<assign owner>` / project change |
| `CLEANUP_STORAGE_ADMIN_KEY` | Secret | destructive Storage cleanup | Storage Admin；只有已確認 execute path 可取得 | No | GitHub Environment `staging-storage-cleanup` | `<assign owner>` / rotate on exposure or policy |
| `IMPORT_RETENTION_DATABASE_URL` | Secret | DB staging retention workflow / runner | 必須直接登入 `job_import_retention` | No | GitHub Environment `staging-import-retention` / protected runtime | `<assign owner>` / job credential rotation |

## 非 secret 的 runtime controls

下列值是安全 gate、路徑、固定 allowlist 或調校值，不應放進 secret inventory 當作憑證，也不能因為它們不是 secret 就省略權限 gate：

- `UNIFORM_DEPLOYMENT_ENV`, `UNIFORM_STAGING_SMOKE_CONFIRM`, `UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM`, `UNIFORM_STAGING_RENDERER_SMOKE_CONFIRM`, `UNIFORM_STAGING_CUTOVER_SMOKE_CONFIRM`
- `CLEANUP_EXECUTE_CONFIRM`, `IMPORT_RETENTION_EXECUTE_CONFIRM`, `CONFIRM_RESTORE`
- `BACKUP_ROOT`, `BACKUP_RUN_ID`, `BACKUP_RUN_DIR`, `BACKUP_STORAGE_BUCKETS`
- `RENDER_COMMAND`, `RENDER_COMMAND_ARGS`, `RENDER_KIND`, `RENDER_OUTPUT_PATH`, `RENDER_LEASE_SECONDS`, `RENDER_STORAGE_PROXY_PORT`
- `IMPORT_LEASE_SECONDS`, `IMPORT_POLL_MS`

其中 confirmation 值必須在執行當次顯式設定，不應持久化成長期 secret 來自動繞過 destructive gate。`BACKUP_ROOT` / `BACKUP_RUN_DIR` 必須位於 repository 外；renderer command/args 若實際部署會包含 credential，該部署值立即升級為 Secret 處理。

## GitHub Environment 對應

| Environment | 應保存的 repository 外值 |
| --- | --- |
| `supabase-staging-migrations` | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`（staging 專屬） |
| `supabase-production-migrations` | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`（production 專屬） |
| `backup-production` | `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BACKUP_ENCRYPT_COMMAND`, `BACKUP_OFFSITE_COMMAND` |
| `staging-storage-cleanup` | `CLEANUP_DATABASE_URL`; destructive smoke 另加 `CLEANUP_SUPABASE_URL`, `CLEANUP_STORAGE_ADMIN_KEY` |
| `staging-import-retention` | `IMPORT_RETENTION_DATABASE_URL` |

## 維運檢查

1. 新增 workflow secret、worker credential 或 provider token 時，先更新本文件，再提交使用它的程式／workflow。
2. 每次 staging／production 建置前執行 `npm run deployment:preflight`；preflight 只檢查名稱、格式與安全邊界，不輸出 secret。
3. GitHub／Vercel／secret manager 中同名 secret 仍必須按環境建立不同 record，不能用一份 production 值供 Preview 或 staging 共用。
4. Rotation 後依最小範圍重跑 migration／worker／renderer／backup／cleanup／retention smoke；不要把舊值留在 `.env`、shell history、artifact 或 Actions log。
5. Owner 尚未正式指派前保留 `<assign owner>`，不得以 repository 中的姓名、email 或臨時聊天內容代填正式 on-call owner。

目前 repository 尚未配置外部 error monitoring provider token／DSN；server 只使用 provider-neutral structured log baseline。未來若選用 Sentry、OTel collector 或其他外部 provider，任何 credential／DSN 必須先依上列規則加入 inventory，並維持 staging／production 分離。
