# 實作路線圖

本路線圖以可獨立驗收、可安全上線的小階段排序。每一階段完成前不進入下一階段的正式資料作業。

## 第 0 階段：素材與技術基線

- 取得員工、組織、制服、供應商、期初庫存樣本。
- 取得正式單據樣式及鼎新成功匯入樣本。
- 以連接 Vercel Hobby 的同一個人 GitHub 帳號持有 private repository，啟用 MFA／離線 recovery codes／每日加密 offsite `git bundle`，實際驗證 push 可觸發 Preview／Production；若現有 repository 屬 GitHub Organization，先完成移轉或升級決策。任何 push collaborator 必須列為 production 特權維運者，不能接受此權限就不加入。
- 建立 Vercel、Supabase production／staging 專案及 local 環境，確認 Preview 不可能取得 production secret 或寫入正式資料。
- 建立 migration、lint、型別檢查、資料庫測試、CI、錯誤監控與 secret inventory。CI 已固定執行 test／lint／typecheck／build，secret inventory 已版本化；錯誤監控已落地不記錄 raw error／secret 的 provider-neutral server logging 與通用錯誤頁基線，但 production 外部 provider、告警路由與 incident smoke 仍是部署 gate，完成前不視為正式監控驗收。
- 選定唯一正式 offsite backup remote、兩位解密金鑰保管人與共同維運信箱；建立並由 CI 實際呼叫 `scripts/backup/export-db.sh`、`scripts/backup/export-auth.sh`、`scripts/backup/export-storage.mjs`、`scripts/restore/restore-from-zero.sh` 與 `scripts/restore/verify.sql`，完成 DB、Auth、Storage、設定清單的每 12 小時加密備份、每日 generation 晉升及手動重跑。Repository 的 manifest 重建已增加同 generation 獨占 lock、掃描期間來源檔／檔案集合穩定性檢查與同檔案系統原子替換；既有 lock 或掃描期間 source drift 都會 fail closed，不覆寫目前 manifest。這只強化本機／CI generation 安全，不代表 offsite 排程、真實備份或還原演練已驗收。
- 以第 0 階段的最小 seed schema／測試 Auth／private Storage fixture 從零還原到全新 local／隔離 project，驗證 migration、Auth UUID、private object bytes／hash 與備份管線可用並記錄初步時間；repository 的 restore preflight 已在雙人解密與任何 DB 寫入前要求目標具備 Supabase Auth 基線、Auth users／identities／MFA factors 為空，且 `public`／`private` 沒有非 extension-owned application objects。解密後 metadata 先做格式驗證，還原後再核對 Auth users／identities／MFA factors；新 generation 另逐項比對八個關鍵 application table 筆數，舊 generation 缺 `application_counts` 時維持 backward-compatible Auth 驗證。Storage restore 另已 fail closed 驗證固定五 bucket 完整性、canonical object path、重複 target、private existing bucket、object 409 衝突，且每個 upload 2xx 後都會從目標 Storage read-back 並重新核對 bytes／SHA-256。但真實 Supabase DB/Auth/private Storage 從零還原與計時仍屬外部驗收。六角色 RLS、正式 ledger／balance 與完整業務資料的 AC-38 還原驗收延至相應 schema 完成後及第 5 階段總驗收。
- 依[資料保存與容量政策](../architecture/data-retention.md)建立三年合成資料與檔案模型，量測資料庫、索引、audit、Storage、尖峰工作，以及 30 天等價 DB/Auth 壓縮 dump＋Storage 增量備份＋還原演練的 egress／GitHub Actions 分鐘。Repository 已落地 fail-closed 的 `capacity:plan` 規劃工具、版本化 assumptions example 與 60%／70%／85% gate 測試；它會把 model estimate 與 `STAGING_SYNTHETIC` measured evidence 分開，沒有真實三年 synthetic/staging measurement、尖峰效能、還原與 30 天 quota usage 時只回報 `NOT_VALIDATED`，因此本項外部驗收仍未完成。
- 建立資料庫權限基線：暴露表啟用 RLS、anon deny-all、private helper schema、逐函式 EXECUTE grant、service role 用途清單及 `security_invoker` view 規則。

完成條件：測試部署可登入，repository ownership 路徑已實測，migration 可重建第 0 階段空 schema；最小 fixture 的最新備份可從零恢復 DB＋Auth＋private Storage bytes 並通過 hash；已建立初步 RPO／RTO 與三年容量基準，30 天等價備份＋演練 egress 與 Actions 分鐘不超過各自免費額度 60%。這只是基礎設施 smoke gate，不宣稱完整 AC-38 或正式業務 RPO／RTO 已驗收；任一條未通過不得進入功能實作。

## 第 1 階段：帳號、權限與主檔

- 邀請制登入、多角色、停用帳號、需求窗口範圍與六角色 RLS 正反向矩陣。
- 完成 private `SECURITY DEFINER` implementation、薄 RPC、顯式 function grant/revoke、使用者 JWT 呼叫及 service role 隔離。
- 機構、部門、員工、制服、供應商及倉庫主檔。
- 完成 private Storage bucket、authenticated download、60–120 秒 signed URL fallback、不可覆寫 object key 與下載稽核。
- 先建立共用 `operation_commands`、canonical fingerprint、穩定 idempotency key、lease generation fencing、SUCCEEDED 結果查回及 UNKNOWN_RESULT 介面；匯入的 start／confirm／apply 命令從一開始即沿用，不等到庫存階段再補。
- 建立 durable batch：cursor、lease token、fencing generation、attempt、指數退避、五次重試上限、last_error、頁面關閉不丟進度且重開後可查回。版本庫已提供受控 `import:worker`；不加 `--once` 時會依 `IMPORT_POLL_MS` 持續輪詢並接續 PARSE／VALIDATE／APPLY，因此瀏覽器關閉不會成為 chunk 解析的必要暫停點。Storage cleanup 的 DB eligibility contract、runner、append-only audit 與每日 dry-run cron 已落地；`0072_import_terminal_retention.sql` 已讓 FAILED／CANCELLED source object 依可靠 `terminal_at` 在滿 90 天後進入 Storage DB 候選；`0073_import_staging_audit_minimization.sql` 已停止把 purgeable staging payload 永久複製進 audit；`0074_import_staging_payload_retention.sql` 已新增專用 `job_import_retention` 薄 RPC，只 scrub 滿 90 天 FAILED／CANCELLED 的 raw／normalized／validation payload，永久保留 batch header、row shell、chunk/diff evidence 與 `staging_purged_at`，purge 後不可 restart。DB staging retention 的獨立 dry-run/execute runner、preflight 與每日 dry-run workflow 已落地；Storage、DB staging destructive cron 與 import worker 的實際常駐 staging 部署都仍待真實 staging smoke 驗證後再啟用／驗收。
- Excel 直傳、預覽、分塊解析、整批驗證／原子發布及錯誤報告；實作檔案大小、列欄、解壓大小、ZIP bomb、巨集、外部連結、公式與 CSV formula injection 防護。
- 停用與歷史引用保護。

完成條件：[AC-01、AC-02、AC-39](../spec/acceptance-criteria.md) 通過；六角色針對本階段已存在的帳號、窗口範圍、主檔、匯入與 Storage table／view／RPC 的允許與拒絕測試全部通過；真實樣本可正確匯入且不重複；頁面關閉後進度不遺失、重新開啟可從耐久 cursor 接續，且 lease 逾時、chunk 重跑後仍可完成；惡意及超限檔案在寫入正式資料前被拒絕。AC-20 的發貨冪等與 AC-41 的庫存／發貨越權部分，等第 2 階段相關表與 RPC 建立後驗收，不以尚不存在的功能阻擋本階段。

## 第 2 階段：兩倉、發放與調庫

- 期初庫存、流水、餘額、預留與可申請量。
- 人資需求、發放明細、增庫、補庫。
- 倉庫實際調庫、差異標示、發貨鎖單。
- 更正、退回、盤點及自動稽核。
- 所有正式寫入沿用第 1 階段的穩定 idempotency key 與具 lease／fencing 的 command claim；純 DB 命令的成功結果與過帳同 transaction 提交，網路逾時顯示 UNKNOWN_RESULT，恢復後以 key 查詢／協調，不直接重做。
- 建立 PDF artifact 模組：artifact revision 採 PREPARING／READY／FAILED，render job 採 PENDING／RENDERING／SUCCEEDED／FAILED；支援固定 snapshot、繁中文字型、模板版本、SHA-256、attempt 重試、取代關係及大型檔 Storage 下載。

完成條件：[AC-03 至 AC-10、AC-16、AC-17、AC-20 至 AC-22、AC-24 至 AC-29、AC-40 至 AC-43](../spec/acceptance-criteria.md) 通過，並完成 AC-23 的 HR_ISSUE／WAREHOUSE_TRANSFER／STOCKTAKE／RETURN 子情境及 AC-37 的需求、發貨、盤點、更正與退回子情境；並行庫存測試、同 key 重送、同 key 不同參數拒絕，以及「伺服器成功但回應遺失」協調全部通過。正式 PDF 可重複下載相同 hash，舊模板 artifact 不被覆寫。此時完整驗收 AC-20、AC-21 與 AC-41 的發貨／庫存寫入、期初全域 once-only 及越權拒絕；AC-23 採購入庫部分與 AC-37 ERP 部分分別留待第 3、4 階段。

## 第 3 階段：換季、核准與採購

- 換季活動、窗口範圍、防重複、人資修正。
- 執行長核准、MOQ、採購差異原因。
- 供應商、採購單、價格、分批驗收與總倉入庫。
- 換季／採購 PDF 及進度報表沿用同一 artifact 模組，不另建旁路產生器。
- 換季彙整與大型報表沿用 durable batch／job 介面，驗證中斷續跑與配額行為。

完成條件：[AC-11 至 AC-15、AC-23、AC-30 至 AC-33](../spec/acceptance-criteria.md) 完整通過，並以測試活動完成窗口填報到分批入庫的完整演練；此時補驗 AC-23 的 PURCHASE_RECEIPT 更正、PO REOPENED、採購同源與共同鎖情境。

## 第 4 階段：鼎新與報表

- 日期＋機構分組、品號彙總、來源追溯。
- 實作 `PREPARING` snapshot transaction：鎖定來源、建立不可變分組／彙總／source links 後才交由 renderer。
- renderer 只讀取批次 snapshot；上傳後以 READY／GENERATED finalize transaction 保存 object key、format version 與 SHA-256。
- 實作 GENERATION_FAILED、安全重試同一 snapshot、上傳成功但 finalize 失敗復原、孤兒檔清理與並行來源唯一性。`0071_storage_cleanup_contract.sql`／`npm run cleanup:storage` 已覆蓋 renderer failed、expired-lease temp 與未引用 bytes 的保守 cleanup 候選，DELETE 前會再做 DB eligibility recheck；真實 destructive Storage smoke 與自動 destructive cron 仍未完成驗收。
- 區分 logical batch 與 artifact revision；鼎新拒收但數量未變時取代檔案版本，真正更正／退回才建立 adjustment batch。
- 依鼎新成功樣本完成 adapter 與黃金檔測試。
- 庫存、發放、差異、換季、採購及稽核報表。

完成條件：[AC-18、AC-19、AC-34 至 AC-37](../spec/acceptance-criteria.md) 完整通過且鼎新測試帳套成功匯入；兩個工作同時取候選、新發貨發生於 snapshot 後、render／upload／finalize 任一步失敗、回應遺失查回、重複下載、拒收取代與更正／退回情境全部驗證，且來源不重複、每個正式 artifact hash 固定。

## 第 5 階段：切換與穩定化

- 最終主檔清理及兩倉實盤。
- 演練並發布正式期初庫存。
- 角色與窗口權限確認、使用者操作驗收。
- 舊檔封存、retention dry-run、正式上線、配額／成長率／耐久工作／最後備份監控。
- 再執行一次 production-sized DB＋Auth＋Storage 從零還原；輪替還原演練使用的 credentials，確認備份失敗通知與手動重跑。
- 依實際 production-sized 結果重算三年 DB／Storage 預測；確認 60% 預警、70% 升級決策及 85% 暫停非必要批次的責任人與操作程序。
- 上線後核對庫存、第一批單據與鼎新匯出。
- Repository 已落地 fail-closed 的 `deployment:release-gate` harness、版本化 `release-evidence.example.json` 與 `deployment:release-evidence` 私有 evidence helper，集中 17 個 production cutover 必過 gate。Helper 初始化時只建立全數 `PENDING` 的 ignored `private/release-evidence.json`、拒絕覆寫既有檔；record 時只接受已知 gate／核准 source／安全 evidence path 或 ID，block 可在 evidence 失效時立即撤銷 PASS 並清空舊 reference；兩種更新都會先取得同 evidence 的獨占 lock、重新讀取最新內容、共用 release-gate validator，再原子替換正式 JSON，避免併發維運造成 lost update，stale lock 則保守留給人工確認後處理。template 永遠 `NOT_READY`，正式 evidence 缺 gate、來源不符或缺 evidence reference 都不能變成 READY。這只完成 release evidence 的安全紀錄與判讀機制，不代表任何尚未取得的 staging、第三方、業務或維運驗收已完成。

完成條件：[AC-21、AC-38](../spec/acceptance-criteria.md) 以正式切換資料及完整 production-sized schema 通過；AC-21 在隔離演練重跑後才執行唯一正式期初發布。業務驗收簽核、RPO／RTO 與免費方案風險簽認、完整還原演練、三年容量 gate、Storage／RLS／signed URL 測試及上線核對全部通過；任何一項失敗即延後切換。

## 暫不排入第一版

- 離線同步。
- 員工自助填報。
- 不可用／隔離／報廢庫存狀態。
- 付款與會計模組。
- 舊交易明細搬遷。
- 鼎新雙向 API 同步。
