# 資料保存、封存與容量政策

- 狀態：第一版架構基準；公司法定／內規保存年限仍須由業務負責人確認
- 適用範圍：Supabase PostgreSQL、Supabase Storage、加密異地備份與封存
- 相關文件：[系統架構](./system-architecture.md)｜[免費方案查核](../research/free-tier-constraints.md)｜[資料模型](../spec/data-model.md)

## 1. 目的

本政策同時處理三件不同的事：

1. **正式紀錄不可被無痕改寫**：庫存流水、正式單據、來源關聯及稽核必須可追溯。
2. **免費配額可預測**：Supabase Free 的資料庫與 Storage 空間有限，暫存及可封存資料不得無限留在線上環境。
3. **災難後可還原**：備份必須位於 Supabase 之外，並能在全新環境重建 DB、Auth 與 Storage。

「不可變」表示保存期間內不可 UPDATE 或以同一 key 覆寫，不代表所有檔案都必須永久留在 production Storage。「備份」用於災難復原；「封存」用於長期保存與查核，兩者不可互相取代。

## 2. 資料分級

| 等級 | 內容 | 可否由一般應用刪除 | 第一版處理 |
|---|---|---|---|
| A：庫存與正式交易真相 | opening balance、posting、ledger、正式發貨／入庫／盤點／更正／退回、ERP source links | 不可 | 全程保留於正式資料庫；容量不足時升級，不以刪流水解決 |
| B：正式歷史與稽核 | 員工／品號 snapshot、核准、採購、角色異動、audit event、正式 artifact metadata/hash、APPLIED import rows／差異 | 不可 | 全程保留於正式資料庫；append-only 或以新紀錄更正 |
| C：正式檔案 bytes | 正式 PDF、鼎新 ERP 檔、已套用匯入原檔 | 不可由一般角色刪除 | 線上保存後可依受控封存程序移至異地；DB 永久保留 metadata、hash、來源與封存位置 |
| D：可重建／診斷資料 | 未套用批次的 raw/normalized staging、錯誤報告、草稿 PDF、工作 log | 可由 retention job 清理 | 依下表保存；清理不影響正式交易或來源追溯 |
| E：孤兒暫存 | 未完成直傳、未被 batch 引用的 render payload、逾期 lease | 可 | 短期保留後由每日清理工作刪除 |
| F：災難備份 | 加密 DB/Auth dump、Storage objects、manifest、設定清單 | 不可由應用讀寫 | 保存於 Supabase／Vercel／GitHub Actions artifact 之外的正式 offsite remote |

## 3. 第一版預設保存期間

以下是技術預設，不取代公司法定或內部規範；若公司要求更長期間，三年容量測試須使用較長者。

| 資料 | Production 線上保存 | 異地保存 | 到期動作 |
|---|---:|---:|---|
| A 類庫存與正式交易資料 | 系統存續期間 | 隨每日／月備份 | 不清除；容量不足即升級 |
| B 類 snapshot、核准、採購、audit、artifact metadata/hash | 系統存續期間 | 隨每日／月備份 | 不清除；容量不足即升級或另立經核准的 archive ADR |
| 正式 PDF 與鼎新 ERP artifact bytes | 至少 3 年 | 至少與公司正式政策相同 | 先封存、驗證 hash 後才可移除 production object；下載畫面顯示需由封存還原 |
| 已套用匯入原檔 | 180 天 | 3 年 | 封存成功後移除 production object；永久保留 batch metadata、範本版本及 SHA-256 |
| 已套用匯入 raw／normalized rows | 系統存續期間 | 隨每日／月備份 | 不清除；它們是 `APPLIED` 批次的不可變正式歷史，必須納入三年 DB 容量投影 |
| 未套用且已 FAILED／CANCELLED 的 raw／normalized／validation staging payload | 90 天 | 不要求 | `0074_import_staging_payload_retention.sql` 只把符合資格 batch 的 `import_rows.raw_values` 清為 `{}`、`normalized_values` 清為 NULL、`validation_errors` 清為 `[]`；row shell、batch/chunk metadata、`import_field_diffs` 永久保留，並以 `staging_purged_at` 留下整批清除標記 |
| 匯入欄位差異及套用結果摘要 | 系統存續期間 | 隨每日／月備份 | 不清除，用於證明哪些主檔被更新 |
| 匯入錯誤報告 | 90 天 | 不要求 | 到期清除；使用者應下載需要保留的報告 |
| 草稿 PDF／預覽 | 原則上不保存；不得超過 24 小時 | 不要求 | 可重新產生，直接清除 |
| 未被 batch／artifact 引用的上傳或 render object | 24 小時 | 不要求 | 每日清理；刪除前再次確認 DB 無引用 |
| 失敗工作詳細 log | 30 天 | 不要求 | 保留聚合錯誤碼、時間及 batch id，清除大型 payload／stack trace |
| 每日／每週／每月災難備份 | 7 日／4 週／12 月 | 同左，全部在正式 offsite remote | 依世代輪替；不得因新備份成功而提前刪除唯一可還原版本 |

若正式 ERP／PDF 檔依公司政策必須永久即時下載，必須把其完整 projected size 納入 Storage gate；不能假設日後一定可刪除。

## 4. 受控封存與清理

### 4.1 封存介面

封存模組只暴露以下介面：

- `plan_archive(cutoff, data_class)`：列出候選批次、檔案數、總大小及所有阻擋原因，不修改資料。
- `execute_archive(plan_id)`：建立不可變 archive、manifest 與 SHA-256，使用異地 adapter 上傳並回讀驗證。
- `finalize_archive(plan_id)`：回讀異地物件並驗證 hash 後，在獨立的 `storage_archive_records` 插入來源種類／id、原 production key／hash、archive key／hash、manifest hash、驗證時間與操作者；不 UPDATE READY artifact 或 APPLIED import batch。只有成功插入不可變 record 後，retention job 才能移除線上 bytes／政策明列可清除的 staging 列。
- `verify_archive(archive_id)`：抽樣或完整下載，重新計算 hash 並記錄驗證結果。

複雜的資料選取、加密、分塊、上傳與重試留在模組實作內；一般頁面不得直接刪除 Storage object 或 import rows。

### 4.2 清理防線

- retention job 採 dry-run → 人工確認 → 執行；A、B 類資料永遠不出現在候選清單。DB staging payload 使用獨立 `npm run retention:import-staging` runner，execute 需 `PURGE_ELIGIBLE_IMPORT_STAGING` 明確 gate；每日 workflow 目前只做 dry-run。
- 正式 artifact 或 import batch 若找不到來源 id、原 production key 與 source hash 全部相符，且包含 archive object key、manifest hash 與成功驗證時間的 finalized `storage_archive_records`，不得清除線上 bytes。來源本身不新增或回寫 `archived_at`。
- DB staging 清理以完整未套用 batch 為資格邊界，但不 DELETE `import_rows`、`import_batch_chunks` 或 `import_field_diffs`；`APPLIED import_rows` 永遠不列入候選。
- `0074_import_staging_payload_retention.sql` 只允許目前 terminal episode 已滿 90 天、尚未標記 `staging_purged_at` 的 FAILED／CANCELLED batch 清空 `raw_values`、`normalized_values`、`validation_errors`。batch header、row shell、chunk metadata 與 `import_field_diffs` 永久保留；同一 transaction 最後設定 `staging_purged_at`，已 purge batch 不得 restart，若需要重新匯入必須建立新 batch。
- 現行資料模型未另拆 purgeable payload table；若日後要縮減 APPLIED payload，必須先以 ADR 與 migration 把可清理 payload 和永久逐列結果分表，不可直接放寬既有不可變 trigger。
- `0073_import_staging_audit_minimization.sql` 起，`import_rows` 的永久 audit 只保存 id、batch、列號、預計動作、目標實體與套用時間等必要 metadata，不再把 raw values、normalized values 或 validation errors 複製進 append-only `audit_events`；其他正式業務 table 仍保留完整 before／after audit。
- `0073` 不追溯改寫已存在的 append-only audit。已部署環境若在套用前曾把 staging payload 寫入 `audit_events`，是否需要歷史 remediation 必須由資料 owner／系統 owner 另行核准並以獨立程序處理，不得藉 retention job 偷改永久稽核紀錄。
- DB 與 Storage 無法共用交易；先封存並以旁掛 record 登記，最後才刪線上 object。刪除／還原各自追加 lifecycle event；失敗可重試，不得回頭改寫 READY／APPLIED 來源或既有 archive record。
- 所有封存、驗證、清理及失敗皆寫 audit；清理命令使用 idempotency key。
- Storage bytes cleanup 與 DB staging payload retention 是兩個權限面：前者維持 `job_storage_cleanup`，後者只使用 `job_import_retention`。`job_import_retention` 對 import tables 沒有一般 DML，只能執行 `list_import_staging_retention_candidates`／`purge_import_staging_payload`，並要求同名 LOGIN 與 active job actor binding；不要把 `job_storage_cleanup` 擴權成 DB staging purge worker。
- retention 的 DB 選取／登記優先使用 job-specific login role 與薄函式 grant；只有 Storage 管理 API 確實需要時才由固定 server-side retention workflow 使用 `service_role`。它不能進瀏覽器，也不能接受任意 bucket／path 作參數。

## 5. 個資與檔案最小化

- 匯入 raw values、錯誤報告、PDF 與 ERP 檔只保存制服作業必要欄位，不把身分證、電話、地址等無關個資帶入。
- 錯誤訊息只顯示必要定位資訊；集中 log 不寫密碼、JWT、database URL、service role、SMTP credential 或完整 Excel row。
- 備份與封存檔一律加密；解密私鑰與 production credentials 分開保管。
- 測試與容量資料使用合成或去識別資料；production 備份不可用作一般測試 seed。

## 6. 三年容量驗證

### 6.1 必備輸入

正式上線前取得並記錄：

- 目前及三年後預估員工數、機構／部門數、制服品號數。
- 每年人資發放明細、補庫、盤點、更正、退回、換季需求、採購與入庫筆數。
- 每月匯入次數、平均／最大列數、raw JSON 平均大小及 audit amplification。
- 正式 PDF、ERP、匯入原檔的平均／P95 大小與每年件數。
- 索引、TOAST、dead tuples、migration headroom 及備份／封存 metadata。

### 6.2 測試方法

1. 以正式 schema、索引、RLS、trigger 與 audit 規則建立合成三年資料；不得只用裸資料列大小估算。
2. 執行主要查詢、換季彙總、匯入、PDF／ERP 產生及並行庫存測試。
3. 記錄 `pg_database_size`、各 table／index／TOAST 大小、Storage bucket bytes、egress 與函式用量。
4. 以實測壓縮率與新增 Storage bytes 換算 30 天備份，再執行一次完整備份及從零還原；備份＋演練 egress 與 GitHub Actions 分鐘都必須低於各自免費額度的 60%，並確認仍可達 RPO／RTO。
5. 把實測基準、資料生成版本與結果保存於 release 文件；schema 或保存政策重大變更後重跑。

### 6.3 可重複容量規劃 gate

Repository 提供 `scripts/capacity/capacity-plan.mjs`，用版本化 JSON assumptions 重算三年 DB、private Storage 與 30 天備份的規劃值。空白起點使用 `docs/deployment/onboarding/templates/capacity-assumptions.example.json`；正式數值應複製到已被 Git 忽略的 `docs/deployment/onboarding/private/` 或其他受保護位置後填寫，不要把真實營運數量或驗收證據提交到 repository。

執行：

```powershell
npm run capacity:plan -- --input docs/deployment/onboarding/private/capacity-assumptions.json
```

工具會 fail closed：缺必備欄位、負值、非有限數字、未知 schema version、P95 小於平均值或最大匯入列數小於平均列數都會拒絕。估算模型會分開顯示 master／transaction／import／audit、index／TOAST／dead tuple／migration headroom，以及 PDF／ERP／匯入原檔的線上保存期間；這些結果只是規劃值，不得當成 `pg_database_size`、實際 Storage bucket bytes 或 production 驗收證據。

只有 `evidence.source=STAGING_SYNTHETIC`、附上可追溯 evidence reference、三年 synthetic 實測 DB／Storage bytes、尖峰效能與還原演練均通過，且 30 天備份＋演練 egress 與 GitHub Actions 分鐘都嚴格低於各自 quota 60% 時，容量工具才會回報 `VALIDATED`。範本或純估算一律是 `NOT_VALIDATED`。

### 6.3 上線與運行門檻

| 指標 | 預警 | 啟動改善／升級決策 | 暫停非必要大量工作 |
|---|---:|---:|---:|
| Supabase database 500 MB quota | 300 MB（60%） | 350 MB（70%） | 425 MB（85%） |
| Supabase Storage 1 GB quota | 600 MB（60%） | 700 MB（70%） | 850 MB（85%） |
| 月度 egress／function／Vercel 用量 | 60% | 70% | 85% |

- **上線 gate：**三年投影的 DB 不得超過 300 MB，Storage 不得超過 600 MB，且尖峰工作需通過效能與還原演練。
- 超過 gate 時，依序處理可重建暫存、調整 C／D 類線上保存、優化索引與 payload；不得刪除 A 類流水或 B 類正式歷史來勉強符合配額。
- 改善後仍超過即升級方案；不得把接近 read-only／service restriction 的容量當作可接受常態。
- 系統每週記錄用量與最近四週成長率，估算到達 70% 的日期；預估 90 天內到達時立即啟動決策。

## 7. 政策變更

任何縮短正式資料／檔案保存期間、把線上資料移至封存、或改變加密與異地位置的變更，都必須：

1. 由業務資料 owner 與系統 owner 核准；
2. 更新本文件及相應 migration／retention job；
3. 先在測試環境完成封存、查回及還原演練；
4. 保留變更前後政策版本與生效日；
5. 不追溯刪除仍受既有保存承諾約束的資料。
