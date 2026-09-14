# 正式上線資料準備

本資料夾提供正式上線前的「空白填寫範本」。範本不包含真實帳號、員工、供應商、庫存或任何 secret；填妥的正式資料也不要提交到 Git。除了帳號、主檔與期初庫存，README「尚待提供」中的鼎新、列印資產、備份責任、容量保存政策與平台 owner／備援移交，統一使用 [`external-acceptance.md`](./external-acceptance.md) 整理。

## 1. 正式帳號、角色與需求窗口

先填寫 [`formal-accounts.md`](./formal-accounts.md)。這份文件是核准與建立帳號用的人工清單，不是 durable import 檔案。

- `login_name`：2–50 個小寫英文字母或數字。
- `display_name`：帳號顯示名稱。
- 聯絡 Email 選填，且不作登入帳號。
- 可使用角色只有 `SYSTEM_ADMIN`、`HR`、`WAREHOUSE`、`PROCUREMENT`、`CEO`、`DEMAND_COORDINATOR`。
- `DEMAND_COORDINATOR` 另填機構／部門範圍。
- 第一位 `SYSTEM_ADMIN` 由 DB owner 依公司核准名單 seed；後續帳號、角色與 scope 由帳號管理介面／受保護 RPC 維護。
- 不在文件中保存密碼、service role、Auth Admin key 或其他 secret。

## 2. 主檔匯入範本

下列 CSV 的 header 使用 `src/domain/import-worker.ts` 的 canonical 欄位，可直接作為 durable import 的填寫起點：

| 順序 | Durable import type | 範本 |
| --- | --- | --- |
| 1 | `INSTITUTIONS` | [`templates/institutions.csv`](./templates/institutions.csv) |
| 2 | `DEPARTMENTS` | [`templates/departments.csv`](./templates/departments.csv) |
| 3 | `UNIFORM_ITEMS` | [`templates/uniform-items.csv`](./templates/uniform-items.csv) |
| 4 | `SUPPLIERS` | [`templates/suppliers.csv`](./templates/suppliers.csv) |
| 5 | `SUPPLIER_ITEMS` | [`templates/supplier-items.csv`](./templates/supplier-items.csv) |
| 6 | `EMPLOYEES` | [`templates/employees.csv`](./templates/employees.csv) |

建議依上表順序準備與匯入，因為部門依賴機構、供應商品號依賴供應商與制服品號、員工依賴機構與部門。正式套用前一定先看 preview，處理所有 `ERROR` 後再確認 APPLY。

欄位規則：

- `isActive`：建議只填 `true` 或 `false`；空白代表不主動提供此欄位值。
- `employmentStatus`：只能填 `ACTIVE` 或 `INACTIVE`。
- `hireDate`、`terminationDate`：有值時必須為有效 `YYYY-MM-DD`。
- `minimumOrderQuantity`：正整數。
- 代碼與名稱不可用自行新增的示例資料取代正式公司主檔。

## 3. 期初庫存

主檔完成並確認正式倉庫代碼後，再填 [`templates/opening-balances.csv`](./templates/opening-balances.csv)。

- `warehouseCode` 必須是資料庫中已存在且啟用的倉庫 `code`，不要把畫面顯示名稱當成代碼猜填。
- `itemCode` 必須是已存在且啟用的制服品號。
- `quantity` 必須為非負整數。
- 正式發布前先完成完整 preview 與差異核對。
- 期初正式發布是一次性切換：`PRE_CUTOVER → LIVE`。只有 `SYSTEM_ADMIN` 可執行 `publish_opening_balance`；進入 `LIVE` 後不可發布第二批期初。

## 4. 外部驗收資料與維運責任

填寫 [`external-acceptance.md`](./external-acceptance.md)，集中整理：

- 鼎新 ERP 成功匯入樣本、欄位規格與驗收人。
- 公司抬頭、Logo、正式 PDF 版面、字型與簽名欄位。
- 異地備份目的地、兩位金鑰保管人、維運通知、RPO／RTO 及業務接受人。
- 三年員工／交易／匯入／PDF／ERP／database／Storage／backup 容量估算與正式保存年限。
- GitHub、Vercel、Supabase、備份與 worker 的 primary／backup owner 與移交狀態。

容量規劃可從 [`templates/capacity-assumptions.example.json`](./templates/capacity-assumptions.example.json) 開始。請先複製到 `private/capacity-assumptions.json` 再填正式假設，執行 `npm run capacity:plan -- --input docs/deployment/onboarding/private/capacity-assumptions.json`。版本化 example 的 `evidence.source` 固定是 `TEMPLATE`；即使估算低於 quota，也只會得到 `NOT_VALIDATED`，不能代替三年 staging synthetic 實測。

Production release evidence 的版本化 [`templates/release-evidence.example.json`](./templates/release-evidence.example.json) 永遠保持 `evidenceKind=TEMPLATE`，不要直接修改。建立正式私有檔時使用 `npm run deployment:release-evidence -- init --release-id release/<release-id>`；工具只會在已被 `.gitignore` 排除的 `private/release-evidence.json` 建立全數 `PENDING` 的 `RELEASE_EVIDENCE`，且既有檔案存在時拒絕覆寫。逐項完成真實 staging／provider／業務／維運驗收後，再用 `npm run deployment:release-evidence -- record --gate <gate-id> --source <approved-source> --evidence-reference <non-secret-path-or-id>` 記錄；若任一既有 evidence 後續失效、撤銷或需要重驗，立即用 `npm run deployment:release-evidence -- block --gate <gate-id>` 把該 gate 安全退回 `PENDING` 並清除舊 reference。`record`／`block` 都先取得同一份 evidence 的獨占 `.lock`、重新讀取最新內容、以 release gate validator 驗證整份檔案，再用同目錄暫存檔原子替換，避免兩個維運操作互相覆蓋或留下半份 JSON；第二個同時更新會 fail closed 且不偷刪既有 lock。若程序異常留下 stale `.lock`，先確認沒有更新程序仍在執行並保留必要事故證據，再由維運者人工移除，不自動猜測 lock 已過期。工具只接受已知 gate、核准 source 與 release gate 可接受的非 secret path／ID，不會執行 migration、Storage DELETE 或其他 production 動作。最後執行 `npm run deployment:release-gate -- --input docs/deployment/onboarding/private/release-evidence.json`；只有 17 個 required gate 全部通過才會回報 `READY`。

範本只記決策、責任與驗收證據位置，不保存 secret、金鑰內容、production credentials、2FA recovery code 或可直接登入的連線資訊。

## 5. 填妥後的交付方式

填妥的正式資料請使用受保護的公司傳遞方式交付，或直接透過正式／staging 的受保護 UI 匯入。不要把填妥後的帳號清單、員工資料、庫存、secret 或 production credentials commit 到 repository。

若要先在本機專案內整理，可自行建立 `docs/deployment/onboarding/private/`，把本資料夾的空白範本複製進去後再填寫；此路徑已加入 `.gitignore`。不要直接覆寫 repository 內受版本控制的空白範本。

正式切換前至少完成：staging durable import smoke、RLS／Storage／worker 驗證、鼎新成功匯入樣本驗收、正式 PDF 樣式驗收、三年容量 synthetic/staging measurement、備份還原演練與 production cutover gate。Repository 具備 release gate harness 不代表 production cutover 已驗收；沒有真實 evidence 時必須維持 `NOT_READY`。
