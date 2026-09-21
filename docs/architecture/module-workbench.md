# 模組工作台介面

## 目的

`ModuleWorkbench` 是正式 Next.js 應用的子功能導覽 seam。它把同一業務模組內的標題、說明、工具列、頁籤、ARIA 關聯與內容狀態保存集中在一個深模組；呼叫端只需提供頁籤 id、名稱與內容。`RetainedPanelSet` 是其下層的掛載 seam，並由 workspace 與 workspace module 導覽共同使用。

商品、組織、員工、兩倉庫存、營運報表、採購差異原因碼、五種更正歷史、CEO 待核版本與換季採購決策品項的大型清單再共用 [`ManagementCatalogTable`](./management-catalog.md)，集中欄位顯示、密度、每頁筆數與完整分頁；`CorrectionHistoryTable` 是更正 panel 的唯讀 adapter；CEO 待核版本與採購品項分別以 `seasonal-approval.ts`、`seasonal-procurement.ts` 集中搜尋／排序規則；`ModuleWorkbench` 不重複承擔清單資料操作。

預設 `visited` mount policy 只掛載目前 panel；使用者實際開啟後才保留該 panel instance，切換時以 `hidden` 保存未送出的草稿。這個策略同時套用在七個 workspace、各 workspace module 與 `ModuleWorkbench` 子頁籤，避免登入後由尚未開啟的面板同時發出 Supabase 查詢。已掛載但目前隱藏的資料 panel 必須再透過 `usePanelActivity()` 檢查 `panelActive`，停止查詢、session recovery 與 workflow event refresh；重新變成可見時才重新載入。`hidden` 只負責呈現與狀態保留，不是遠端讀取的停止機制。資料讀寫 implementation 仍留在原 panel、domain function、server-side route 與 Supabase RPC，工作台不繞過 RLS、冪等、稽核或 POST 狀態機。

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
6. 保留型資料 panel 的遠端 effect、恢復查詢與 workflow event listener 必須以 `usePanelActivity()` 的 `panelActive` 為第一層 gate；補上或更新 `src/domain/retained-query-panel-contract.test.ts`，確保新增 panel 不會在隱藏狀態持續讀取。
7. 倉庫待發貨清單使用 `v_warehouse_shipment_queue` 的 security-invoker read seam；不要在 `WarehouseShipmentPanel` 恢復分別查詢來源單、補庫單與草稿後再由瀏覽器合併。這只可簡化讀取，不得把明細查詢、草稿 mutation、冪等鍵或庫存 POST 搬進 view。
8. 人資需求表單使用 `v_hr_request_employee_options`／`v_hr_request_item_options` 的 server-shaped read seam；不要恢復在瀏覽器重新 join 員工、機構、部門、品號或另查一次 `v_item_availability`。view 只提供選項與快照，送出 RPC 仍負責鎖定、重算與最終有效性驗證。
9. 調撥更正的初始來源選擇使用 `v_warehouse_transfer_correction_sources` 的 security-invoker read seam；不要恢復分別查詢發貨／補庫來源單與兩種明細，再由瀏覽器自行合併。view 只提供已完成來源的選項與數量快照，更正建立／過帳、品號鎖定、歷史查詢與稽核仍留在既有 RPC／資料表，不得把 mutation 或鎖定規則搬進 view。
10. 盤點更正的初始來源選擇使用 `v_stocktake_correction_sources` 的 security-invoker read seam；不要恢復分別查詢盤點單、啟用倉庫與盤點明細，再由瀏覽器自行合併。view 只提供來源快照，前端角色過濾仍是顯示／操作入口，盤點過帳、帳面版本 fencing、歷史查詢與稽核仍留在既有 RPC／資料表。
11. 入庫更正與退回更正的初始來源選擇使用 `v_purchase_receipt_correction_sources`／`v_return_correction_sources`；不要恢復分別查詢已完成主單與明細，再由瀏覽器維持兩份相依狀態。view 只提供來源快照與顯示欄位，更正建立／過帳、歷史查詢與不可變規則仍留在既有 RPC／資料表。
12. 人資發放更正的初始來源選擇使用 `v_hr_issue_correction_sources`；不要恢復分別查詢已發放需求與發放明細，再由瀏覽器以主單 `find()` 組合選單。view 只提供已發放來源快照，更正建立／過帳、數量重算、歷史查詢與稽核仍留在既有 RPC／資料表。
13. 換季採購決策清單使用 `v_seasonal_procurement_queue` 的 security-invoker read seam；不要恢復分開讀取核准明細與既有採購決策，再由瀏覽器回配。供應商／MOQ／差異原因碼仍由共用 master-data adapter 提供，採購決策與採購單 mutation 不得搬進 view。
14. 換季需求登記使用 `v_seasonal_demand_workspace` 的 tagged security-invoker read seam；不要恢復分開查詢活動員工、活動品號與需求列，也不要改成員工×品號笛卡兒積。view 只提供三種唯讀資料列，前端 adapter 分流成表單選項與清單；需求保存仍由 `upsert_seasonal_demand_line` 負責授權、冪等與最終驗證。
15. CEO 換季審核清單使用 `v_seasonal_approval_queue` 的 security-invoker read seam；不要恢復分開查詢 PENDING submission 與 campaign 再由瀏覽器 `find()` 回配。view 只提供清單標籤，明細仍選取後讀取，核准／退回仍由既有 revision、hash 與 RPC 防線負責。
16. 人資需求查詢的選取明細使用 `v_hr_request_history_detail` 的 tagged security-invoker read seam；不要恢復分開查詢 request items、issue lines 與 reservations。view 只提供唯讀 detail rows，前端 adapter 分流顯示，需求異動、預留釋放、發貨與更正仍由既有 RPC／資料表負責。
17. 倉庫待發貨清單的重新整理使用 `canRefreshWarehouseShipmentQueue` 這個純 interface：查詢／交易進行中與本地未保存理貨變更才是阻擋條件；已保存草稿可刷新清單並保留目前工作區。這只改善操作摩擦，不得移除草稿、來源版本、POST 或庫存鎖定防線。
18. 採購入庫的來源採購單選擇不應被相依明細查詢鎖住；只在交易忙碌或已有入庫草稿時停用來源選擇，明細 select 與送出按鈕仍可依 `loadingData`／資料完整性停用。切換採購單時必須清空舊明細，並依 effect cleanup 忽略過期回應。
19. 人資需求的主檔快照刷新只鎖定送出，不應把日期、備註與正在編輯的明細一起禁用；`dataReady` 仍是正式提交的 gate，已送出單據在使用者明確進入修改前仍為唯讀。
20. 使用者主動按下「重新整理」時，若資料來自短期 read cache，呼叫端必須先透過對應 adapter 的 `invalidate` seam 再觸發讀取；背景事件與面板切換仍可使用 TTL 去重。不可只增加 reload token 卻繼續顯示舊快照，也不可為了強制刷新而繞過共用 adapter 或自行建立第二套查詢。
21. Workspace module 的非主要 panel 使用 `next/dynamic` 搭配 `WorkspacePanelLoading`；主要入口可保持同步載入，次要面板只在第一次開啟時取用 bundle。lazy loading 只改善 bundle 與首屏互動，不得改變 `RetainedPanelSet` 的 activity gate、身份查核、RLS、冪等或 workflow 狀態機；新增或移動 panel 時同步更新 `workspace-loading-contract.test.ts`。
22. 商品／組織／員工／庫存／報表／原因碼等清單的遠端讀取必須使用 `createReadRequestController` 的目前 token；舊請求只能被丟棄，不能關閉新請求的 loading 或發布過期 rows。此序號 seam 只收斂前端讀取競速，不得把 mutation、權限或資料庫狀態機搬到 UI。
23. 倉庫發貨左側來源選擇與右側明細讀取是兩個不同的操作 seam：`detailsLoading` 只鎖定右側明細編輯與完成操作，不得阻擋使用者切換另一筆來源；切換前先清空舊明細，`detailsReadController` 只允許最新選取發布結果。`busy` 與 `draftDirty` 仍是交易／未保存變更的必要 gate，不能因為改善切換速度而移除。
24. 四個換季 panel 的手動重新載入只受 mutation `busy` 控制，不得因 `dataLoading`／`campaignLoading`／`scopeLoading` 禁用，讓使用者能在卡住或暫時同步時自助重試。`SeasonalProcurementPanel` 的 queue／master-data 讀取必須以 `createReadRequestController` fencing，`SeasonalApprovalPanel` 的 queue 與明細各有獨立 controller；重新載入或切換選取先 invalidate 舊 token，舊回應不得發布 rows、重設編輯器或關閉新讀取的 loading。這只改善讀取操作 seam，不改核准、採購、需求或活動 RPC；契約由 `seasonal-read-path-contract.test.ts` 保護。
25. 人資需求查詢的「重新整理」是唯讀重試入口，不得因歷史清單 `loading` 而停用；`historyReadSequenceRef` 與 `detailReadSequenceRef` 讓重複查詢由最新序號擁有 loading，晚到回應只能被丟棄，不能覆蓋清單、明細或提前關閉新查詢。這只改善卡住時的自助恢復，不改需求查詢 view、RLS、預留或任何 mutation；契約由 `hr-request-read-path-contract.test.ts` 保護。
26. 商品／組織／員工／兩倉庫存／營運報表／採購原因碼與人資需求的唯讀重新整理不得被 `dataLoading`／`loadingData` 鎖住；只在真正的 mutation `busy` 時停用。前六者必須沿用 `createReadRequestController`，HR 需求以 effect cleanup 丟棄舊回應；帳號目錄另以 `directoryLoadSequence` 讓最新讀取擁有資料與 loading。這只改善重試與狀態呈現，不改主檔、報表 view、RLS、需求選項或任何交易 RPC；契約由 `read-refresh-ui-contract.test.ts`、`hr-request-ui-contract.test.ts` 與 `account-admin-workbench-contract.test.ts` 保護。
27. 營運總覽的重新整理只受 `identityReady` gate 控制，不得因核心／延後摘要 `displayLoading` 禁用；`queueReload` 會合併 scope，effect cleanup 會丟棄舊讀取，`aria-busy` 只反映讀取狀態。這讓首頁在慢查詢時可自助重試，不改 `v_overview_core`、reporting views、RLS 或事件刷新規則；契約由 `reporting-read-path-contract.test.ts` 保護。
28. PDF／ERP artifact 的背景 polling 與手動狀態查詢必須共用 `useWorkflowStatusPoll` 的 in-flight request；同一 artifact 在已有狀態讀取時不得再開第二個 status RPC，晚到結果由共用 hook 序列化處理。這只改善唯讀查詢競態，不改 artifact 建立、下載、Storage signed URL、RLS 或冪等契約；契約由 `workflow-polling-contract.test.ts` 保護。
29. 帳號設定的機構／部門／範圍控制不得把目前帳號 scope 的低頻讀取當成整個表單卡控；`manageOptionsReady` 為首次必要選項的 gate，scope 讀取中仍可準備選項，窗口保存才等待 scope read 完成。切換帳號要清除舊 scope 顯示與選擇，避免把前一帳號的窗口範圍誤呈現或沿用；契約由 `account-admin-workbench-contract.test.ts` 保護。
30. Durable import 的「重新查詢批次」是唯讀恢復入口，不得因 `dataLoading` 停用；`refreshBatch` 仍由共用 `ReadRequestController` 擁有最新讀取與 loading，`reloadSequenceRef` 只讓最新一次手動重查發布訊息，避免快速連點時晚到結果覆蓋新狀態。匯入確認仍等待完整逐列資料，檔案上傳／取消／APPLY 的 mutation busy、固定 object key、冪等鍵與 worker／Edge actor 邊界不變；契約由 `durable-import-ui.test.ts` 保護。
31. 入庫／退回的相依明細讀取在主來源被清空、切換帳號、空清單或不可恢復錯誤時，必須同步清空失效明細並釋放 `linesLoading`；舊 request 的 cleanup 不得假設一定有下一個 effect 會接手關閉 loading。選取新來源時可短暫重新進入明細讀取，但不可把前一筆明細的 loading 狀態帶到「請選擇」空狀態；交易 busy、來源快照、POST 與冪等鍵防線不變，契約由 `warehouse-operation-contract.test.ts` 保護。
32. 盤點帳面餘額的 loading 必須綁定目前倉別與有效工作區範圍，不可使用跨選取共用的 boolean。清除／切換倉別、帳號或離開有效 panel 時，舊請求即使被取消也不能讓新畫面永久停在讀取中；餘額快照尚未與目前倉別匹配時，新增／送出仍須 fail-closed。盤點 RPC、帳面版本 fencing、RLS 與冪等契約不變；純規則由 `isReadPendingForSelection` 與 `warehouse-operation-contract.test.ts` 保護。
33. 退回面板在同帳號已發貨需求快照有效時，背景刷新不得停用「已發貨需求」選擇器；切換來源會清除相依發放明細並重新讀取，但 `requestsLoading`／`linesLoading` 仍阻擋建立與完成交易。首次快照、帳號切換或權限錯誤仍由 `dataReadBlocked` fail-closed；這只解除讀取期間不必要的來源選擇鎖，契約由 `warehouse-operation-contract.test.ts` 保護。
34. **換季活動原子建立**：`SeasonalCampaignPanel` 使用 `runSeasonalCampaignSetup` 優先以 `create_seasonal_campaign_with_scope` 單次 RPC 建立活動並凍結員工／品號範圍；`0125_atomic_seasonal_campaign_setup.sql` 在一個資料庫 transaction 內委派既有 create／scope RPC，維持角色檢查、獨立冪等鍵與稽核，任一步失敗都回滾。只有共用 optional-RPC adapter 明確確認新 RPC 缺少時才退回舊的兩步流程；已知缺少狀態按 client 快取 60 秒，期滿重探，舊流程部分成功會保留 campaign ID，只重試 scope，不重複建立。套用 0125 前不會得到單一往返最佳化，Git／Vercel 部署也不會代替 Supabase migration；契約由 `seasonal-campaign.test.ts` 與 `seasonal-campaign-contract.test.ts` 保護。
35. **採購入庫原子完成**：完整到貨分類的「確認並完成入庫」優先使用 `complete_purchase_receipt` 單次 transaction RPC；wrapper 先做 WAREHOUSE 權限檢查並取得品號鎖，再依 item→PO 鎖序委派既有草稿建立與 POST，保留兩組操作冪等鍵、稽核與 POSTED 不可變語意。只有共用 optional-RPC adapter 明確確認函式缺少時才回退舊流程；授權、業務、網路與結果未知錯誤不可觸發 fallback。`src/lib/optional-rpc.ts` 按 Supabase client／函式名稱快取缺漏 60 秒，避免每次收貨都多打一趟失敗 RPC，並在期滿後允許偵測 migration。未完整分類的資料仍使用獨立草稿保存入口；`0126_atomic_purchase_receipt_completion.sql` 必須另行套用，契約由 `purchase-receipt-completion.test.ts` 保護。
36. **盤點原子完成與重盤**：`StocktakePanel` 的「確認並完成盤點」優先使用 `complete_stocktake`，由 `0127_atomic_stocktake_completion.sql` 在同一個 PostgreSQL transaction 呼叫既有 `create_stocktake_draft` 或 `update_stocktake_draft`，再呼叫 `post_stocktake`；`0113` 的重盤也優先使用 `recapture_stocktake_draft`。兩者共用 `src/lib/optional-rpc.ts` 的 client-scoped、60 秒負向能力快取，移除面板各自保存的支援旗標；只有明確 missing-function 才回退，權限錯誤、傳輸例外或回傳形狀不完整一律停止，不啟動第二條寫入路徑。未知回應保留冪等鍵並鎖定表單。套用 migration 後應以 HR／WAREHOUSE session 驗證新建、既有草稿、同鍵重試及 `STALE_COUNT` 重盤；Git／Vercel 發布本身不會執行 DB migration。
37. **人資需求／補庫原子送出**：`HrRequestWorkbench` 與 `ReplenishmentPanel` 優先呼叫各自的 `*_with_lines` RPC，把草稿建立／更新與送出由兩次串行 browser RPC 收斂為一次。transaction wrapper 仍委派既有 RPC，保留角色、逐列快照、品號鎖序、庫存重算、reservation、operation-command idempotency 與 audit。已送出需求修改仍走原有單一 `update_hr_request`。新 wrapper 缺少時才走舊流程，缺漏能力統一由 `src/lib/optional-rpc.ts` 按 client／函式快取 60 秒，不再由 React state／ref 保存重複旗標；網路／未知結果不切換寫入路徑，保留原 payload、單號與冪等鍵。手動驗收仍需涵蓋新單、既有 DRAFT、庫存不足 rollback、legacy fallback 與回應遺失重試。
38. **Read-model 缺漏快取**：`src/lib/read-model-rollout.ts` 讓總覽、帳號目錄、員工目錄、更正歷史、發貨明細與補庫明細共用每個 Supabase client 的 60 秒缺漏能力快取。首次收到 `PGRST205` 或明確點名目標 view 缺漏的錯誤（如 `42P01`）才走既有 legacy fallback；快取期間直接略過必然失敗的 view request，期滿再探測，成功或非缺漏錯誤會清除快取。只有缺少物件錯誤可觸發 fallback，權限／其他 schema 錯誤仍需顯示；這是資料庫 migration 尚未到位時的暫時延遲緩解，不取代正式 read-model repair SQL。`read-model-rollout.test.ts` 與 `overview-dashboard-read.test.ts` 保護快取及查詢次數。
39. **退回與更正原子完成**：`ReturnPanel` 的新退回「確認並完成」與五種庫存更正優先使用各自單一 RPC，在同一 transaction 委派既有 create／post；不複製角色、來源鎖、庫存流水或稽核規則。`0131`／`0132` wrapper 的部署界線與舊版 fallback 不變；退回與更正現在共用 `src/lib/optional-rpc.ts`，按 Supabase client／函式名稱快取明確缺少 60 秒，避免同一分頁重複探測。網路錯誤、權限錯誤與未知回應不會被誤判為缺少函式，也不啟動第二次寫入。DRAFT 保存與 POSTED immutable 契約維持不變；測試由各 completion domain tests 與 `optional-rpc.test.ts` 保護。
40. **Optional RPC 能力快取 seam**：`src/lib/optional-rpc.ts` 是可選部署 wrapper 的單一能力判定介面，供收貨、退回、盤點／重盤、人資需求、補庫、換季活動、五種更正與倉庫發貨共用。只有錯誤碼為 `PGRST202` 且錯誤明確指出目標 function 不在 schema cache，或 `42883` 且明確指出該 function does not exist，才按 Supabase client／函式名稱負快取 60 秒；transport rejection、permission／business error、不同 helper 缺失與錯誤 response shape 不快取且不得切換 fallback。快取期滿自動重探，因此正式套用 migration 後無須重新部署前端；每個 domain 的 observable fallback 與 idempotency 仍由原 domain interface 負責，shared module 只提供 capability lookup。`optional-rpc.test.ts` 測試快取隔離／期限／錯誤分類，各 workflow tests 測試實際 fallback。
