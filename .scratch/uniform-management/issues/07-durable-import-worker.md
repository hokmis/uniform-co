# 07 — Durable Import 解析與整批套用 worker

**What to build:** 以受保護的 `job_import_worker` 讀取已驗證 private Storage object，安全解析 CSV/XLSX，完成 bounded chunk lease、逐列 preview/diff/error、使用者確認後整批 APPLY，支援 EMPLOYEES 與 OPENING_BALANCE once-only gate。

**Blocked by:** 05 — 期初切換、部署與正式驗收

**Status:** ready-for-agent

- [x] Repo parser 契約已提供 bounded CSV/XLSX signature、MIME、UTF-8、解壓大小、ZIP entry／壓縮比、工作表／列／欄／cell 上限、公式／巨集／外部連結／NUL／path traversal 防線與測試；仍需由受控 worker 讀 Storage bytes 並在 staging 驗證實際 OOXML fixture
- [x] Repo worker entry 已提供受控 proxy 下載、reference snapshot、bounded parse／preview、PARSE／VALIDATE chunk 與 APPLY lease orchestration；正式 credentials 與 staging smoke 仍待部署
- [ ] `claim_import_chunk`、heartbeat、complete、fail、cursor CAS 與 lease takeover 在 staging DB 通過並行 smoke
- [x] EMPLOYEES／主檔 preview 能由 worker 比對現有 snapshot 分類 INSERT／UPDATE／SKIP／ERROR，逐列差異與錯誤寫入 durable rows，SKIP/ERROR 不會套用；真實 worker 執行仍待 staging
- [ ] `confirm_import_batch` 是必要且可查回的 durable gate；zero-diff batch 也不能跳過確認
- [ ] APPLY 以 batch lease/fencing、角色與 PRE_CUTOVER once-only 條件整批交易完成；任何列失敗不發布正式資料
