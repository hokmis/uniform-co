# 管理清單介面

## 目的

`ManagementCatalogTable` 是帳號、商品、組織、員工、兩倉庫存、營運報表、採購差異原因碼、更正歷史、CEO 待核版本、換季採購決策品項、換季需求登記與待發貨需求共用的管理清單 module。它把欄位顯示、資料密度、每頁筆數、目前範圍、首末頁導覽、排序表頭與空狀態集中在同一個 interface；各業務清單只提供欄位定義、已篩選排序的資料列及逐列操作。

這個模式參考 SPSV29 的欄位設定與大型清單操作，但不移植其全域狀態或直接刪除流程。資料載入、RLS、匯出稽核、編輯表單與 mutation RPC 仍留在各自的業務 module。

## Interface

呼叫端提供：

- 穩定的清單名稱、row key 與欄位 id。
- 每個欄位的顯示名稱、cell renderer、可選排序 key、預設可見性與是否固定。
- 已完成業務篩選與排序的 rows。
- 遠端查詢中的 `loading`（可選）；若為空列且查詢中，顯示載入骨架，不把尚未完成的讀取誤判為空資料。
- 目前頁碼、頁碼變更 callback、排序狀態與排序 callback。
- 空資料訊息，以及可選的每頁筆數設定與 table class。

module 內部負責：

- `10／20／25／50／100` 等呼叫端核准的每頁筆數選項。
- 第一頁、上一頁、下一頁、最後頁與 `第 n–m 筆／共 x 筆` 範圍。
- 舒適／緊湊列高切換。
- 欄位顯示 popover、全部顯示、恢復預設及固定欄位保護。
- sticky table header、ARIA sort 狀態與窄螢幕控制列重排。
- `loading` 且已有 rows 時保留目前資料，以 stale-while-revalidate 方式標記 `aria-busy`；載入骨架以 `aria-live="polite"` 告知狀態，並在 `prefers-reduced-motion` 下停用 shimmer。
- 呼叫端必須將遠端 `dataLoading` 與保存／審核用的 mutation `busy` 分開；讀取中的必要控制可停用，但不得用同一個狀態鎖住不相關的編輯表單。

純計算 interface 位於 `src/domain/management-catalog.ts`，涵蓋 page window、page size normalization 與欄位可見性。React implementation 位於 `src/app/ManagementCatalogTable.tsx`。

商品、組織、員工、兩倉庫存與五種更正來源由 `src/app/use-account-scoped-read-snapshot.ts` 共用帳號範圍讀取生命週期，純狀態轉移位於 `src/domain/account-scoped-read.ts`。共用 hook 以 `createReadRequestController` 拒絕過期回應、將 snapshot 與提示訊息綁定目前 account id，並在同帳號背景刷新時保留已載入列；只有已知的暫時 JWT 同步錯誤可保留非空 snapshot，權限、Schema、未分類失敗與 Promise rejection 都必須清除資料或使用安全通用訊息，不得顯示舊帳號資料或 raw error。盤點更正另把有效 HR／WAREHOUSE 角色組合納入 snapshot scope，角色範圍改變時不沿用舊清單。五種更正面板直接從各自 security-invoker source view 讀取明細，主單號等選單標籤由同一列取得，不再在前端分別維護父單與明細兩份快照；各面板仍自行決定查詢、資料轉換、有效數量計算與 mutation RPC。營運報表與採購原因碼目前仍使用同一 `read-refresh.ts` controller 直接管理請求序號。所有 read seam 只處理讀取排序與 UI snapshot，不改 RLS、匯出集合、mutation RPC 或資料庫交易邊界；純狀態規則由 `src/domain/account-scoped-read.test.ts` 與 `src/domain/read-refresh-ui-contract.test.ts` 驗證。

## 更正歷史 adapter

`CorrectionHistoryTable` 位於 `src/app/CorrectionHistoryTable.tsx`，是五個更正 panel 共用的唯讀 UI adapter。各 panel 仍自行載入可操作的來源明細、執行有效數量計算與呼叫受保護 RPC；更正歷史則交由共用 read adapter 轉成 `CorrectionHistoryRow` 後交給表格。

`src/domain/correction-history.ts` 集中歷史清單的狀態標籤、狀態選項、關鍵字篩選與 workflow 順序排序。畫面提供更正單號／原因搜尋、狀態篩選、差額與過帳時間欄位、欄位顯示、密度與分頁；過帳時間預設隱藏，以維持與來源表單一致的清單密度。這些控制只改變唯讀呈現，不會改變更正資料、庫存餘額或 append-only ledger。

更正歷史的資料讀取由 `src/lib/correction-history-read.ts` 統一：更正面板收到已選取的來源主檔／明細後，優先從 `0116_correction_history_view.sql` 建立的 `v_correction_history` 一次查回該明細的完整歷史。view 使用 `security_invoker`，因此角色與來源表 RLS 仍是授權邊界；尚未套用 0116 時，adapter 先從來源 line table 透過來源專屬複合外鍵 embedded `correction_notes`，將原先串行的主單／明細兩次讀取合併為一次；只有 PostgREST 無法解析關聯時才退回舊兩段讀取，權限錯誤仍直接顯示安全錯誤。發貨明細的 `src/lib/warehouse-shipment-read.ts` 在 `v_warehouse_shipment_lines` 不存在時，也先用既有複合外鍵嵌入 `hr_request_items`，把舊兩個 base-table 查詢合併成一次；只有 PostgREST 無法解析關聯時才回退兩段讀取。來源清單仍由各自的 source view 提供，保存／過帳仍由原 RPC 負責；不要把 read seam 擴成 mutation seam。

## 發貨清單 rollout adapter

待發貨清單由 `src/lib/warehouse-shipment-queue-read.ts` 優先讀 `0103_warehouse_shipment_queue_view.sql`；若該 view 明確缺漏，則以同一 Supabase session 分別載入 HR 與補庫來源，HR 發貨草稿透過既有唯一 FK embedded 讀取。只有 PostgREST 無法解析此 FK 時才查第二次 shipment table；所有來源都沿用登入者 RLS，權限／非 rollout 錯誤不 fallback，避免正式 view 權限設定錯誤時以其它路徑掩蓋問題。此 seam 對正式資料庫目前缺漏的 view 保持可操作；套用 0103 後自動回到一次 view read。

## 套用範圍

| 清單 | 固定欄位 | 額外能力 |
| --- | --- | --- |
| 商品 | 品號、功能 | 分類／狀態篩選、供應商 MOQ、20 筆預設分頁 |
| 組織 | 代碼、功能 | 機構／部門類型、所屬機構、啟用狀態 |
| 員工 | 工號、功能 | 機構／狀態篩選、稽核匯出；離職日與備註可由欄位設定顯示 |
| 帳號 | 顯示名稱、功能 | 帳號／角色搜尋、狀態篩選；登入綁定可由欄位設定顯示 |
| 兩倉庫存 | 品號、狀態 | 分類／庫存狀態篩選、數量排序；有效預留預設隱藏 |
| 營運報表 | 第一個中文欄位 | 動態中文欄位、最多 200 筆即時 view、25／50／100 筆分頁 |
| 採購差異原因碼 | 原因碼、功能 | 搜尋、狀態篩選、明確新增／修改模式；代碼建立後鎖定 |
| 五種更正歷史 | 更正單號 | 單號／原因搜尋、狀態篩選、差額顯示、過帳時間欄位、完整分頁；不提供歷史資料 mutation |
| CEO 待核版本 | 活動、功能 | 活動／revision／snapshot hash 搜尋、送核時間與 revision 排序、欄位顯示、完整分頁；選取後仍由原 panel 執行 revision/hash 重驗與核准／退回 |
| 換季採購決策品項 | 品號、功能 | 品號／品名／尺寸／數量／決策狀態搜尋、核准量排序、欄位顯示、完整分頁；選取後仍由原 panel 執行供應商／MOQ 驗證與決策 RPC |
| 換季需求登記 | 員工、品號、功能 | 員工／品號／數量／HR 修改狀態搜尋、員工編號／品號／數量／更新時間排序、欄位顯示、完整分頁；選取後由右側表單回填修改，儲存仍走需求 RPC |
| 待發貨需求 | 需求單、功能 | 需求單／日期／草稿狀態搜尋、需求單號／發放日／來源版本排序、欄位顯示、完整分頁；選取後由右側理貨工作區建立或恢復草稿 |

## 不變條件

1. 欄位顯示與密度只改畫面，不改查詢、匯出集合、RLS 或資料庫內容。
2. 至少保留一個欄位；固定識別欄與功能欄不能隱藏。
3. 篩選變更由呼叫端回到第一頁；page window 對超出範圍的頁碼 fail-safe clamp。
4. 不提供沒有受保護 bulk RPC 的批次停用或刪除。資料異動仍逐筆進入既有表單或受保護 RPC。
5. 員工匯出維持「目前完整篩選結果」，不因畫面每頁筆數或隱藏欄位改變；匯出前仍須完成 metadata 稽核。

## 驗證

`src/domain/management-catalog.test.ts` 固定分頁範圍、核准 page size、未知欄位排除、固定欄位與至少一欄可見；庫存與原因碼的篩選／排序另由各自 domain test 固定。介面修改另需執行 lint、typecheck、build，並以有正式資料的登入 session 檢查欄位設定、密度、每頁筆數及首末頁操作。
