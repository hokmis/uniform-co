# 08 — 鼎新 ERP 成功樣本與黃金檔契約

**What to build:** 取得實際鼎新產品／版本與成功匯入樣本，固定欄位、編碼、日期、數字、負數、單號與錯誤回執契約，讓 ERP adapter 產出的 bytes 可在測試帳套重複匯入。

**Blocked by:** 04 — 單據 PDF 與鼎新 ERP 匯出

**Status:** ready-for-agent

- [ ] 成功樣本與欄位 mapping 經使用者確認並版本化
- [ ] 固定 fixture 的輸出 bytes、encoding、欄位順序與 hash 通過 golden test
- [ ] 測試帳套完成新增、重送防重、IMPORT_FAILED、IMPORT_CONFIRMED、格式修正版新 revision
- [ ] 不把真實員工資料、帳密或鼎新檔案提交 GitHub
