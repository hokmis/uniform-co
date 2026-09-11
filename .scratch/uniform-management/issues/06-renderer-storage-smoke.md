# 06 — Renderer 與 Storage 受控煙測

**What to build:** 在 staging Supabase 以受控同名 worker roles、Storage proxy、實際 renderer adapter 完成 PDF／ERP claim、generation-specific upload、heartbeat、finalize、fail/retry、download grant 與歷史 revision 驗收；worker 不暴露 Storage Admin credential 給 adapter 或瀏覽器。

**Blocked by:** 04 — 單據 PDF 與鼎新 ERP 匯出

**Status:** ready-for-agent

- [ ] `job_document_renderer`、`job_erp_renderer`、`job_renderer_storage_proxy` 以 protected credentials 與 `private.job_actor_bindings` 正確登入，未配置時所有 RPC fail closed
- [ ] 兩個 concurrent lease 接手時 object key 含不同 generation；舊 worker 不能上傳、finalize 或讀取新 generation key
- [ ] upload response 遺失後以同一 reserved key reconciliation，hash/size/MIME 正確才 READY；不同 bytes 轉 terminal failure
- [ ] PDF／ERP finalize、retry、terminal fail、歷史 READY revision download、ERP download event 與短期 grant 通過 integration smoke
- [ ] adapter process 的環境沒有 `DATABASE_URL`、`SUPABASE_*`、Storage Admin 或其他 secrets
