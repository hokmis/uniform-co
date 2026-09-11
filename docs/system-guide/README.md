# 制服管理系統 System Guide

<!-- SYSTEM-GUIDE:GENERATED:START -->

## 本次產出

- 模式：`APPLY`
- 語言：繁體中文（zh-TW）
- 分析日期：2026-08-31（Asia/Taipei）
- 專案：Next.js 15／React 19／TypeScript／Supabase Auth、PostgreSQL、RLS、Storage
- 正式來源：GitHub `Kevin72333/uniform-co` 的 `main` 分支
- 前台路徑：`/system-guide`
- 前台權限：暫時只允許有效且具有 `SYSTEM_ADMIN` 角色的登入帳號

## 文件索引

1. `user-guide.md`：登入、導覽、日常操作、狀態、錯誤與常見問題。
2. `admin-guide.md`：帳號、角色、環境、Migration、主檔、期初、Worker、備份與上線檢查。
3. `agent-guide.md`：架構、模組邊界、資料流、命令、測試、部署、風險與接手順序。

前台 System Guide 直接讀取上述三份 Markdown，並嵌入原本的 `WorkspaceShell` 右側內容區；原作業台左側選單保持可用。文件按鈕由固定 allowlist metadata 立即呈現，內容則由受保護 API 在伺服器端以 Supabase bearer session 驗證 `SYSTEM_ADMIN` 後載入。頁面不使用 `dangerouslySetInnerHTML`，原始 HTML 或 JavaScript 不會被當成可執行內容。

## 掃描範圍與證據

主要證據來自 `src/app/`、`src/domain/`、`src/server/`、`supabase/migrations/`、`scripts/`、`.github/workflows/`、`README.md`、`CONTEXT.md`、`docs/spec/`、`docs/architecture/` 與 `docs/deployment/`。`prototype/` 是獨立 mock，不作為正式功能與資料來源。

## 產出驗證

- `npm test`：71 個 test files、287/287 tests 通過。
- `npm run lint`、`npm run typecheck`、`npm run build`：通過。
- Next.js build trace 已包含三份前台 Markdown；`/api/system-guide` 為動態路由，`/system-guide` 與首頁共用正式工作區外殼。
- Prototype JavaScript syntax smoke 與 `git diff --check`：通過。
- 本功能沿用既有角色與 Supabase session，不需要新增或執行 Supabase SQL migration。
- 帳號、商品、組織、員工、兩倉庫存、營運報表、採購差異原因碼、五種更正歷史、CEO 待核版本、換季採購決策品項、換季需求登記與待發貨需求的共用管理清單已包含欄位顯示、密度、每頁筆數與首末頁導覽；更正歷史支援單號／原因搜尋與狀態篩選，CEO 清單支援活動／revision／snapshot hash 搜尋與送核時間排序，採購清單支援品號／品名／數量／決策狀態搜尋，需求清單支援員工／品號／數量／HR 修改狀態搜尋與排序並可回填右側表單，待發貨清單支援需求單／日期／草稿狀態搜尋與排序並可在右側理貨工作區建立或恢復草稿；這些顯示設定不改資料或匯出集合。

## 已知未知資訊

- Production cutover 仍為 `NOT_READY`；repository-local 測試通過不能取代正式 staging／production evidence。
- 鼎新正式匯入 mapping、正式 PDF 樣式、第一批正式帳號與 scope、平台 owner／backup owner、真實備份還原、RPO／RTO、外部監控與三年容量實測仍待外部資料或驗收。
- 正式環境已套用哪些 migration 必須以 `supabase_migrations.schema_migrations` 或受保護 readiness smoke 重新查核，不能只依 Git 歷史推論。

<!-- SYSTEM-GUIDE:GENERATED:END -->

<!-- SYSTEM-GUIDE:MANUAL:START -->

## 手動補充區

此區保留給公司加入內部聯絡窗口、教育訓練日期與核准版本。請勿在此保存密碼、token、連線字串、員工個資或 production secret。

<!-- SYSTEM-GUIDE:MANUAL:END -->
