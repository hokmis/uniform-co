# 模組工作台介面

## 目的

`ModuleWorkbench` 是正式 Next.js 應用的子功能導覽 seam。它把同一業務模組內的標題、說明、工具列、頁籤、ARIA 關聯與內容狀態保存集中在一個深模組；呼叫端只需提供頁籤 id、名稱與內容。`RetainedPanelSet` 是其下層的掛載 seam，並由 workspace 與 workspace module 導覽共同使用。

商品、組織、員工、兩倉庫存、營運報表、採購差異原因碼、五種更正歷史、CEO 待核版本與換季採購決策品項的大型清單再共用 [`ManagementCatalogTable`](./management-catalog.md)，集中欄位顯示、密度、每頁筆數與完整分頁；`CorrectionHistoryTable` 是更正 panel 的唯讀 adapter；CEO 待核版本與採購品項分別以 `seasonal-approval.ts`、`seasonal-procurement.ts` 集中搜尋／排序規則；`ModuleWorkbench` 不重複承擔清單資料操作。

預設 `visited` mount policy 只掛載目前 panel；使用者實際開啟後才保留該 panel instance，切換時以 `hidden` 保存未送出的草稿。這個策略同時套用在七個 workspace、各 workspace module 與 `ModuleWorkbench` 子頁籤，避免登入後由尚未開啟的面板同時發出 Supabase 查詢。資料讀寫 implementation 仍留在原 panel、domain function、server-side route 與 Supabase RPC，工作台不繞過 RLS、冪等、稽核或 POST 狀態機。

## 掛載策略

- `visited`：預設值。首次開啟才掛載，之後保留狀態；適合表單、清單與多數遠端資料面板。
- `active`：切換後卸載舊 panel；只用於可安全丟棄狀態且重新載入成本低的內容。
- `all`：登入時立即掛載全部 panel；只有具體預載需求與量測證據時才使用。

`shouldMountRetainedPanel()` 是 mount policy 的純領域 interface；`RetainedPanelSet` 負責 React instance retention、tabpanel id 與 ARIA 關聯。呼叫端不可自行複製 visited set 或 hidden 判斷。

## 判斷準則

符合下列任一條件時，應使用模組工作台：

- 同一 workspace module 同時組裝兩個以上不同使用者任務。
- 清單、建立／編輯、批次工具或危險操作確認被直向堆疊。
- 使用者必須捲動很長距離才能找到操作入口。
- 子流程需要保留未送出狀態，但不應同時佔用畫面。

下列情況不應為了視覺一致而強制加頁籤：

- 單一狀態機的一張表單，例如倉庫發貨或 CEO 換季審核。
- 只提供一個明確任務的唯讀總覽。
- 原 panel 內的欄位必須同時可見才能完成同一次提交。

## 套用盤點

| 功能 | 結果 | 子功能 |
| --- | --- | --- |
| 商品管理 | 已套用 | 商品清單、供應商／MOQ、匯入／匯出；商品新增／編輯使用獨立表單 |
| 帳號管理 | 已套用 | 帳號清單、新增帳號、帳號設定；刪除登入身份使用頁面內二次確認 |
| 庫存管理 | 已套用 | 兩倉可用量、異動操作、期初庫存、歷史匯出、規則試算 |
| 人資需求 | 已套用 | 制服需求、額外補庫、員工退回 |
| 人資更正 | 已套用 | 發放更正、退回更正；歷史清單支援搜尋／狀態篩選／分頁 |
| 員工主檔 | 已套用 | 員工清單、獨立新增／修改／停用表單、批次匯入、稽核匯出 |
| 倉庫盤點／更正 | 已套用 | 庫存盤點、調庫更正、盤點更正；歷史清單支援搜尋／狀態篩選／分頁 |
| 採購決策 | 已套用 | 核准品項清單、採購決策、差異原因碼；清單支援搜尋／排序／分頁 |
| 採購入庫 | 已套用 | 採購入庫、入庫更正；歷史清單支援搜尋／狀態篩選／分頁 |
| 換季活動 | 已套用 | 活動設定、需求登記 |
| 正式文件 | 已套用 | 正式 PDF、鼎新 ERP |
| 組織主檔 | 已套用 | 機構／部門清單、獨立新增／修改／停用表單、批次匯入／匯出 |
| 倉庫發貨 | 保持單一 panel | 同一草稿／POST 狀態機，不拆分 |
| CEO 換季審核 | 保持單一 panel | 同一 revision/hash 決策不拆分；panel 內先以共用清單搜尋／排序／分頁，再載入審核明細 |
| 營運總覽 | 保持單一 panel | 唯讀摘要與快速入口 |
| 營運報表 | 保持單一 panel | 報表目錄、中文欄位、即時搜尋、排序、分頁與重新整理集中在同一只讀資料瀏覽器 |

## 維護規則

1. 新增工作台頁籤時，使用穩定英文 id，顯示文字可用中文。
2. 頁籤只負責任務切換；資料權限與保存規則必須留在原本的深層 domain／RPC module。
3. 危險操作使用頁面內明確確認，不使用無上下文的原生瀏覽器確認框。
4. 新 panel 預設沿用 `visited`；若要改成 `active` 或 `all`，需在呼叫端說明丟棄狀態或預載的理由並補 interface 測試。
5. Workspace 與 workspace module 也必須透過 `RetainedPanelSet` 組裝，不要重新加入整頁 eager mount 或散落的 `hidden={active !== id}` implementation。
