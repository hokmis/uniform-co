# 04 — 單據 PDF 與鼎新 ERP 匯出

**What to build:** 以不可變 snapshot 產生可重複下載的 PDF 與鼎新銷貨單匯出批次，保留 artifact revision、hash、來源追溯與匯入回執狀態。

**Blocked by:** 03 — 採購入庫與分批驗收

**Status:** ready-for-agent

- [ ] PDF 與 ERP artifact 可重試且不覆寫既有版本
- [ ] 匯出批次與來源單據可追溯、同 key 冪等
- [ ] 鼎新實際欄位格式以使用者提供的成功樣本完成黃金檔驗收

