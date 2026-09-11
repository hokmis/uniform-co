# 制服管理系統邏輯資料模型

狀態：第一版實作基準  
資料庫：Supabase PostgreSQL  
時區：業務日期以 Asia/Taipei 解讀；資料庫時間戳一律使用 timestamptz  
依據：已確認的 50 題需求訪談與根目錄 CONTEXT.md

## 1. 模型目標與邊界

本模型涵蓋：

- 二十家機構共用一個人資倉與一個總倉。
- 員工、機構、部門、制服品號、供應商與帳號權限主檔。
- 人資需求單、發放明細、增庫量、庫存預留、倉庫發貨及調庫差異。
- 發貨後的更正、退回及兩倉盤點。
- 換季需求活動、窗口填報、人資修正、執行長核准、採購決定、採購單與分批驗收入庫。
- Excel／檔案匯入批次、期初庫存、鼎新 ERP 銷貨匯出批次、A4 PDF 成品及完整異動紀錄。

不在本系統處理的範圍是付款、應付帳款、會計傳票與 ERP 內部過帳。第一版不支援離線寫入，也不匯入舊交易明細；舊資料只封存，系統庫存歷史從經確認的期初庫存開始。

## 2. 共通設計約定

### 2.1 識別碼與欄位型別

- 所有內部主鍵使用 uuid，預設 gen_random_uuid()。外鍵一律指向內部主鍵，不以可變的名稱作關聯。
- 工號是員工的永久唯一業務鍵；制服品號是庫存唯一業務鍵，且與鼎新 ERP 品號相同。
- 單號是供人閱讀與列印的唯一業務鍵，例如 HR-202608-000001；不能拿單號取代 uuid 外鍵。
- 數量使用 bigint 或 integer，業務數量必須是整數。一般數量為非負數；只有明確表示差額的欄位可為負數。
- 金額使用 numeric(18,4)，稅率使用 numeric(9,6)，幣別使用 char(3)。不得用浮點數儲存金額。
- 業務日使用 date；建立、送出、發貨、核准、入庫等事件時間使用 timestamptz。
- 每個可編輯表至少有 created_at、created_by、updated_at、updated_by；所有 created_by／updated_by／submitted_by／posted_by／approved_by 等業務 actor FK 一律指向 app_accounts.id，而不是 auth.users.id。樂觀鎖可用 row_version bigint。
- 主檔採 is_active 停用，不刪除被交易引用的資料。所有交易外鍵使用 ON DELETE RESTRICT。

### 2.2 代碼與狀態

固定且不由使用者維護的值適合 PostgreSQL enum 或有 CHECK 的 text：

- 角色：SYSTEM_ADMIN、HR、WAREHOUSE、PROCUREMENT、CEO、DEMAND_COORDINATOR。
- 倉庫用途：HR、GENERAL；未來若新增其他倉庫可另增用途，不改變第一版兩倉計算。
- 人資需求單：DRAFT、SUBMITTED、INVENTORY_REVIEW_REQUIRED、SHIPPED、CANCELLED。
- 補庫單：DRAFT、SUBMITTED、SHIPPED、CANCELLED；補庫不建立庫存預留。
- 倉庫發貨、入庫、更正、退回：DRAFT、POSTED；盤點：DRAFT、STALE_COUNT、POSTED。
- 更正種類：HR_ISSUE、WAREHOUSE_TRANSFER、PURCHASE_RECEIPT、STOCKTAKE、RETURN。
- 換季活動：DRAFT、OPEN、HR_REVIEW、PENDING_APPROVAL、APPROVED。
- 換季送核版本：PENDING、RETURNED、APPROVED；執行長審查決定：RETURN、APPROVE。
- 採購單：DRAFT、ORDERED、PARTIALLY_RECEIVED、RECEIVED、REOPENED、CLOSED_SHORT、CANCELLED；REOPENED 的原因種類至少區分 RECEIPT_CORRECTION 與 ORDER_QUANTITY_INCREASE。
- 預留：ACTIVE、CLOSED、RELEASED、CONFLICTED。
- 系統切換：PRE_CUTOVER、LIVE；正式環境只允許單向切換一次。
- 匯入批次：AWAITING_UPLOAD、UPLOADED、PARSING、VALIDATING、VALIDATED、APPLYING、APPLIED、FAILED、CANCELLED；只有尚未 APPLIED 的批次可受控取消。
- 匯入 chunk：PENDING、LEASED、RETRY_WAIT、COMPLETED、FAILED。
- ERP 匯出批次：PREPARING、GENERATION_FAILED、GENERATED、DOWNLOADED、IMPORT_FAILED、IMPORT_CONFIRMED。
- ERP 匯出 artifact：PREPARING、READY、FAILED；render attempt：PENDING、RENDERING、SUCCEEDED、FAILED。
- 文件成品：PREPARING、READY、FAILED。
- 文件 render attempt：PENDING、RENDERING、SUCCEEDED、FAILED。
- 業務命令 claim：IN_PROGRESS、SUCCEEDED、RETRYABLE_FAILED、TERMINAL_FAILED。

狀態只能透過具名資料庫函式轉換，不允許前端直接任意更新狀態欄。狀態轉換函式同時寫入時間、操作者與異動紀錄。

### 2.3 命令去重與逾時後結果查詢

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| operation_commands | id PK；UNIQUE (operation_code, idempotency_key) | operation_code、idempotency_key、canonical_request_fingerprint、actor_account_id FK app_accounts.id、status、lease_token、lease_generation、lease_expires_at、attempt_count、result_entity_type、result_entity_id、started_at、succeeded_at、failed_at、last_error_code、last_error_message。 |

所有會正式送出、過帳、核准、結案、套用匯入或建立正式批次的命令，都先由同一個受控 RPC claim 一筆 operation_commands。衝突時鎖定既有 claim 並遵守：

- operation＋idempotency key 相同但 fingerprint 或 actor 不同，立即拒絕，不得把另一個請求的結果當成本次結果。
- 已 SUCCEEDED 時回傳既有 result_entity_type／result_entity_id；有效租約仍為 IN_PROGRESS 時回傳明確 IN_PROGRESS，不另跑一次。
- 只有租約逾期或 RETRYABLE_FAILED 才可接手；接手同時產生新 lease_token、增加 lease_generation、設定新期限。舊執行者即使稍後恢復，也不能再完成命令。
- 執行者完成前必須在鎖住 claim 後驗證 token、generation 及未逾期租約；業務寫入、來源狀態轉換、result_entity_id 與 claim 的 SUCCEEDED outcome 必須在同一資料庫 transaction 提交。若交易 rollback，不能留下假成功 claim；若 client 在 commit 後逾時，重送即可查到同一結果。
- RETRYABLE_FAILED 可保存安全的錯誤碼並重試；TERMINAL_FAILED 不可自動接手。error 欄位不得含密碼、JWT、Storage token 或完整敏感 payload。

operation_commands 是命令執行協定，不取代每個來源單／posting／artifact 自身的唯一鍵與 idempotency constraint；兩層都必須存在，避免不同程式路徑繞過 claim 後重複正式寫入。

需要 Storage 等外部副作用的流程以「建立耐久工作」為命令成功邊界：例如 `create_erp_export_batch` 在凍結 logical batch 後把命令設 SUCCEEDED，`request_erp_artifact`／`request_document` 在建立 PREPARING artifact 與第一個 PENDING attempt 後把各自命令設 SUCCEEDED。render、upload 與 finalize 只依 artifact／attempt 的 fencing state machine 推進，不延長或再次完成原 operation command；若要求新 revision，另以新的 revision request 命令及冪等鍵建立，命令同樣在耐久工作建立時完成，不等待 READY。

## 3. 組織、帳號與主檔

### 3.1 帳號與權限

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| app_accounts | id uuid PK；auth_user_id uuid UNIQUE NULL；login_name case-insensitive UNIQUE NULL | login_name、display_name、email_snapshot、is_active。login_name 是新帳號必填的 2–50 個小寫 ASCII 英數字登入名稱；email_snapshot 是選填聯絡資料，不作登入用途。既有 email 登入帳號轉換前可暫時沒有 login_name。id 是可還原且不可變的業務帳號識別；auth_user_id 只用來綁定目前 Supabase Auth 身分，不作任何業務 actor FK。 |
| user_roles | PK (account_id, role_code) | account_id FK app_accounts.id；同一帳號可有多個角色；role_code 僅允許六種已確認角色。 |
| coordinator_scopes | PK (account_id, institution_id, department_id) | account_id FK app_accounts.id；只供 DEMAND_COORDINATOR；一位窗口可跨機構與部門。department_id 必須屬於同一 institution_id。 |
| account_auth_binding_events | id PK | account_id、old_auth_user_id、new_auth_user_id、reason、rebound_at、rebound_by_account_id nullable、db_role_snapshot、recovery_ticket、execution_channel。append-only 保存首次綁定、解除與災難復原後重新綁定。 |

private.current_account_id() 先以有效 JWT 的 auth.uid() 查找唯一、啟用且 auth_user_id 相符的 app_accounts.id；找不到或找到多筆即拒絕。private.has_role(role_code) 與 private.can_manage_employee(employee_id) 只以 current_account_id() 查 user_roles／coordinator_scopes，供 RLS 與 RPC 共用。權限判斷不可只放在前端。

app_accounts.auth_user_id 刻意不作業務主鍵，也不以不可還原的硬 FK 讓一般資料 dump 依賴 auth.users；綁定 RPC 必須在寫入時查驗該 UUID 確實存在於 auth.users。一般資料庫 dump 即使不能原樣還原 auth.users，app_accounts.id、所有 actor FK 與歷史稽核仍保持有效。重新邀請後只能由具 SYSTEM_ADMIN 角色的另一個已驗證帳號呼叫受控 rebind RPC，把新的 auth.uid() 綁回原 app_accounts.id；RPC 必須確認新 auth_user_id 尚未綁定、保存 old/new UUID、原因與操作者。

若災難復原後沒有任何仍可登入的 SYSTEM_ADMIN，僅允許資料庫 owner 使用不授權給 PUBLIC／anon／authenticated／service_role 的一次性 maintenance 函式，依雙人核准的 recovery_ticket 綁定第一位既有管理員。函式必須確認目前確實不存在可登入管理員、驗證新 auth.users 身分、寫入 db_role_snapshot／execution_channel 及 append-only binding event；完成後立即回到一般 rebind RPC。禁止修改歷史 actor FK、禁止把兩個 app_accounts 合併成一人，也禁止把同一人的舊歷史搬到新 app_accounts；無法確認身分時建立新帳號並保留舊帳號停用，不猜測合併。

### 3.2 組織與員工

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| institutions | id PK；code UNIQUE | name、is_active。機構只是員工、需求、成本與報表歸屬，不是庫存位置。 |
| departments | id PK；UNIQUE (institution_id, code)；另設 UNIQUE (id, institution_id) | institution_id FK、name、is_active。複合唯一鍵供其他表保證部門與機構一致。 |
| employees | id PK；employee_no UNIQUE | name、institution_id、department_id、employment_status、job_title、hire_date、termination_date、note。employee_no 不重用。 |

員工表以複合外鍵 (department_id, institution_id) 參照 departments(id, institution_id)，避免員工被掛到另一機構的部門。在職員工的 institution_id 與 department_id 必填；離職員工保留最後歸屬與所有歷史關聯。Excel 中缺少某員工不代表離職，也不得據此刪除或停用。

### 3.3 庫存與採購主檔

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| warehouses | id PK；code UNIQUE | name、purpose、is_active。第一版各有且只有一個啟用中的 HR 與 GENERAL 用途倉庫。 |
| suppliers | id PK；supplier_code UNIQUE | name、tax_id、contact fields、default_currency char(3)、is_active、note。聯絡欄位與預設幣別可選填。 |
| uniform_items | id PK；item_code UNIQUE | item_code 即鼎新品號；item_name、unit、is_active 為必填。size、category、season、fit_or_gender、color、default_supplier_id、safety_stock_qty、note 為選填。 |
| supplier_uniform_items | PK (supplier_id, item_id) | 該供應商供應該品號的關係；minimum_order_quantity、supplier_item_code、is_active、note。MOQ 屬於供應商＋品號，不是全域品號屬性。 |

品名、尺寸、季別、顏色等都只是描述；任何庫存、發放、調庫、採購及匯出加總只以 uniform_items.id／item_code 分開計算。同款不同尺寸既然有不同品號，就自然形成不同庫存。

建議約束：

- institution code、department code、supplier code、employee_no 與 item_code 都是匯入比對及外部對照所需的穩定業務鍵，必填且不得只含空白；可採 citext 或另建 lower(value) 唯一索引，避免大小寫造成重複。缺少代碼的來源檔必須先在預覽中補值並經使用者確認，不得以名稱猜測，也不得發布 NULL 代碼。
- unit 與名稱 trim 後不得為空字串。
- supplier_uniform_items.minimum_order_quantity 若有值必須大於 0；uniform_items.safety_stock_qty 若有值不得小於 0。
- uniform_items.default_supplier_id 若有值，必須存在同一品號的 supplier_uniform_items 關係；新採購只能選啟用中的供應關係，歷史 snapshot 不因關係日後停用而改寫。
- suppliers.default_currency 若有值必須是 trim 後三碼大寫幣別代碼；採購單仍在 ORDERED 時凍結實際使用的幣別，不隨供應商主檔日後變更。
- 啟用中的 HR 與 GENERAL 倉庫可各用一個 partial unique index 保證唯一。
- 已被引用的機構、部門、員工、品號、供應商與倉庫只能停用，不能硬刪除。

## 4. 人資需求、發放與倉庫發貨

### 4.1 人資需求單

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| hr_requests | id PK；request_no UNIQUE | status、distribution_date、note、created_by、submitted_at/by、shipped_at/by、cancelled_at/by、cancellation_reason、row_version；CANCELLED 時原因必填。 |
| hr_issue_lines | id PK；UNIQUE (request_id, id)；UNIQUE (request_id, line_no)；UNIQUE (request_id, employee_id, item_id) | request_id FK、employee_id FK、item_id FK、quantity、snapshot 欄位。同一張單的一位員工＋品號以一列數量表示；每列代表本單 POST 成功後準備交付某員工之某品號數量，SUBMITTED 階段不是已領取。 |
| hr_request_items | id PK；UNIQUE (request_id, item_id)；UNIQUE (request_id, id, item_id) | issue_quantity、increase_quantity、requested_transfer_quantity、品號 snapshot。issue_quantity 必須等於同單同品號之 hr_issue_lines.quantity 合計；三欄複合唯一鍵供發貨明細強制同一來源單及品號。 |

requested_transfer_quantity 不接受人工輸入，應用 generated column 或交易函式固定為：

    requested_transfer_quantity = issue_quantity + increase_quantity

hr_issue_lines.quantity 必須大於 0；hr_request_items.issue_quantity 與 increase_quantity 必須大於等於 0，且兩者合計必須大於 0。人資透過逐員工明細決定發放量，並在品號彙總列填寫增庫量；倉庫不得修改兩者。

### 4.2 歷史快照

發放明細在送出時至少凍結下列資料：

- employee_no_snapshot、employee_name_snapshot。
- institution_id_snapshot、institution_code_snapshot、institution_name_snapshot。
- department_id_snapshot、department_code_snapshot、department_name_snapshot。
- item_code_snapshot、item_name_snapshot、size_snapshot、unit_snapshot。
- distribution_date 取自單頭並在正式發貨後不再改變。

employee_id、item_id 等外鍵仍保留，用來查詢同一員工或品號的完整歷程；報表、正式 PDF 與 ERP 來源追溯顯示 snapshot，不因員工轉調、改名、品名更正或主檔停用而改寫舊單。DRAFT 可即時顯示目前主檔，SUBMITTED 時填入快照，SHIPPED 後由 trigger 禁止修改。

### 4.3 倉庫發貨

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| warehouse_shipments | id PK；shipment_no UNIQUE；hr_request_id UNIQUE；UNIQUE (id, hr_request_id) | 對應一張人資需求單；status、source_request_row_version、posted_at/by、note。 |
| warehouse_shipment_lines | id PK；UNIQUE (shipment_id, hr_request_item_id) | shipment_id、hr_request_id、hr_request_item_id、item_id、requested_transfer_quantity_snapshot、general_on_hand_snapshot、maximum_transfer_quantity_snapshot、actual_transfer_quantity、transfer_difference_quantity、short_ship_reason_code FK transfer_short_ship_reasons。`(shipment_id, hr_request_id)` 指向同一發貨表頭，`(hr_request_id, hr_request_item_id, item_id)` 指向該表頭來源需求的同品號彙總列；item_id 由來源推導。 |
| transfer_short_ship_reasons | code PK | label、is_active、sort_order；只用於實際調庫量低於鎖後最大可調量的例外原因，停用不影響歷史。 |

transfer_difference_quantity 固定為：

    transfer_difference_quantity =
      requested_transfer_quantity_snapshot - actual_transfer_quantity

requested_transfer_quantity_snapshot、general_on_hand_snapshot 與 maximum_transfer_quantity_snapshot 只在 POST 交易取得鎖後，以來源單目前版本及總倉目前現有量凍結；倉庫草稿不得自行提供這些值。最大可調量固定為：

    maximum_transfer_quantity_snapshot =
      least(requested_transfer_quantity_snapshot, general_on_hand_snapshot)

發貨明細不得只驗證 hr_request_item_id 存在。複合 FK 必須保證每列屬於發貨表頭的 hr_request_id，且 line.item_id 等於該來源彙總列品號；POST 鎖後再重驗來源集合完整、沒有漏列／多列／錯接，正式數量與 snapshot 全部從來源推導。

約束為 0 <= actual_transfer_quantity <= maximum_transfer_quantity_snapshot，因此差異不得為負。若 actual_transfer_quantity 小於 maximum_transfer_quantity_snapshot，short_ship_reason_code 必填；庫存足夠時不能無理由以 0 或任意較小數量結案。差異只用於醒目標示；不建立待補量、不建立後續義務，也不自動帶入下一張單。若之後仍需補貨，由人資另建補庫單。

warehouse_shipments.source_request_row_version 必須等於 POST 當下 hr_requests.row_version。人資在發貨前更正需求時，必須增加 row_version，並把既有倉庫草稿標為需要重新整理、清空 actual_transfer_quantity 與 short_ship_reason_code；POST 不得信任舊需求 snapshot。正式 snapshot 只在版本比對成功的 POST 交易中建立。

warehouse_shipments 一旦 POSTED：

- 發貨單、發貨明細、來源 hr_requests、hr_issue_lines、hr_request_items 與其正式快照全部不可 UPDATE／DELETE。
- 僅能另建更正單或退回單。
- 該人資需求單才可進入正式鼎新銷貨匯出候選集合。

## 5. 補庫、更正、退回與盤點

### 5.1 補庫單

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| replenishment_requests | id PK；request_no UNIQUE | status、note、created_by、submitted_at/by、shipped_at/by、cancelled_at/by、cancellation_reason、row_version；CANCELLED 時原因必填。 |
| replenishment_request_lines | id PK；UNIQUE (request_id, item_id) | item_id、requested_quantity、request_row_version_snapshot、general_on_hand_snapshot、maximum_transfer_quantity_snapshot、actual_transfer_quantity、difference_quantity、short_ship_reason_code FK transfer_short_ship_reasons、品號 snapshot。 |

補庫單不含員工、不含發放量，只代表增加人資倉的需求。requested_quantity 由人資填寫，actual_transfer_quantity 由倉庫填寫，difference_quantity 等於兩者差額且不形成待補。依已決議規則，補庫單送出時完全不建立 inventory_reservations，也不保證日後可調數量；正式發貨時鎖定 GENERAL balance，凍結 `maximum_transfer_quantity_snapshot = least(requested_quantity, general_on_hand_snapshot)`，並限制 actual_transfer_quantity 不得超過該值。若實際量小於該最大值，short_ship_reason_code 必填。

補庫 requested_quantity 被人資更正時必須增加 replenishment_requests.row_version，清空倉庫尚未 POST 的實際量及其舊 snapshot。POST 時 request_row_version_snapshot 必須等於目前 row_version；兩張補庫單競爭同一總倉品號時，先依第 12 節共同鎖序取得 item mutex 與 balance 者先過帳，後一張必須依最新總倉量重新確認，不能沿用先前畫面上的數量。

### 5.2 發貨後更正

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| correction_notes | id PK；correction_no UNIQUE | correction_kind、status、reason 必填、note 選填、posted_at/by；original_hr_request_id、original_warehouse_shipment_id、original_replenishment_request_id、original_purchase_receipt_id、original_stocktake_id、original_return_note_id 依種類恰有一個。 |
| issue_correction_lines | id PK；UNIQUE (correction_note_id, line_no) | original_hr_request_id、original_issue_line_id、employee_id、item_id、issue_quantity_delta、員工與品號 snapshot；parent id 與 identity 由原明細推導並以同父約束固定。 |
| transfer_correction_lines | id PK；UNIQUE (correction_note_id, line_no) | original_warehouse_shipment_id／original_replenishment_request_id 與 original_shipment_line_id／original_replenishment_line_id 依類型各恰一組、item_id、actual_transfer_quantity_delta、品號 snapshot；父項與原明細同源。 |
| receipt_correction_lines | id PK；UNIQUE (correction_note_id, original_receipt_line_id) | original_purchase_receipt_id、original_receipt_line_id、item_id、delivered_quantity_delta、accepted_quantity_delta、rejected_quantity_delta、rejection_reason_snapshot、品號 snapshot；三個差額至少一個非 0，父項、PO 與品號由原明細推導。 |
| stocktake_correction_lines | id PK；UNIQUE (correction_note_id, original_stocktake_line_id) | original_stocktake_id、original_stocktake_line_id、warehouse_id、item_id、quantity_delta、倉庫與品號 snapshot；父項與原明細同源。 |
| return_correction_lines | id PK；UNIQUE (correction_note_id, original_return_line_id) | original_return_note_id、original_return_line_id、employee_id、item_id、return_quantity_delta、員工與品號 snapshot；父項與原明細同源。 |

更正種類與庫存效果：

- `HR_ISSUE`：issue_quantity_delta 正值補登發放並減少人資倉，負值沖回登記並增加人資倉；可形成鼎新發放調整批次。
- `WAREHOUSE_TRANSFER`：可關聯人資需求發貨或補庫發貨；actual_transfer_quantity_delta 以總倉與人資倉等量反向兩筆流水修正，修正後實際調庫量仍須介於 0 與原調庫需求量之間。
- `PURCHASE_RECEIPT`：delivered／accepted／rejected 三個 delta 一起修正原驗收分類，只有 accepted_quantity_delta 影響總倉；更正後該收貨列仍須完整分類，且累計合格入庫量不得為負或超過調整後採購量。
- `STOCKTAKE`：quantity_delta 修正原盤點登記錯誤對同一倉庫、同一品號造成的庫存效果；不得覆寫原盤點單。
- `RETURN`：return_quantity_delta 正值補登可用退回並增加人資倉，負值沖回誤登退回並減少人資倉；修正後累計退回量仍不得超過有效發放量。

每張更正明細至少要有一個適用差額非 0；單一差額種類不得填 0，PURCHASE_RECEIPT 的三個分類差額則允許個別為 0、但不可全部為 0。更正單只修正登記錯誤；實際改品號或換尺寸必須使用退回原品號＋新增發放。原始需求、發貨、補庫、入庫、盤點與退回單一律保持不變，更正只新增關聯流水。

更正來源不能只靠「兩個 id 都存在」判斷。各原始明細表建立 `UNIQUE (parent_id, id)`，correction_notes 建立各種 `UNIQUE (id, original_parent_id)`；每張更正明細以兩段複合 FK／等效 deferred constraint 同時保證「明細所帶 original_parent_id 等於更正表頭來源」及「original_line_id 確實隸屬該 parent」。correction_kind 必須與唯一非空的表頭來源及使用的明細表相符。employee_id、item_id、warehouse_id、purchase_order_id 等識別欄由受控 RPC 鎖定原明細後複製，前端不得任意傳入；constraint trigger 再驗證與原明細完全相同。任何一列錯接另一張需求、shipment、補庫、receipt、stocktake 或 return，整張更正不得 POST。

查詢及進度不得只讀原單數量，必須以不可變原值加已 POSTED 更正推導 effective quantity，例如：

    effective_actual_transfer =
      original_actual_transfer + sum(POSTED transfer delta)

    effective_delivered =
      original_delivered + sum(POSTED delivered_quantity_delta)

    effective_accepted =
      original_accepted + sum(POSTED accepted_quantity_delta)

    effective_rejected =
      original_rejected + sum(POSTED rejected_quantity_delta)

    effective_delivered = effective_accepted + effective_rejected
    effective_delivered >= 0
    effective_accepted >= 0
    effective_rejected >= 0

    effective_returned =
      original_returned + sum(POSTED return correction delta)

調庫差異、採購 delivered／accepted／rejected 進度、員工淨領用及 ERP adjustment 候選都使用 effective quantity。原始 POSTED 收貨列必須 delivered > 0；更正可把一筆完全誤登的收貨列沖回為 effective delivered／accepted／rejected 全為 0，但仍保留原列與更正歷史。有效 rejected 大於 0 時仍須可由原驗收或更正快照追溯拒收原因。PURCHASE_RECEIPT 更正必須在同一交易重算 effective delivered／accepted／rejected、remaining_to_accept、採購配置量及 PO 狀態；若使原 RECEIVED 採購單重新出現 remaining_to_accept，狀態轉為 REOPENED 並記錄 reopen_reason_kind = RECEIPT_CORRECTION，之後只能再收貨成 RECEIVED 或以原因轉 CLOSED_SHORT。原已 CLOSED_SHORT 的採購單仍保持禁止後續入庫的終態，但其有效進度與配置量按更正後 accepted 重算；若重算會超過 current_purchase_limit，須先完成具理由的上限調整，否則更正失敗。不得維持數量、配置與狀態矛盾。

任何差額會使相關倉庫餘額為負時，POST 必須失敗。HR_ISSUE 的正向差額還必須以未被 ACTIVE reservation 占用的合計可用量支付。PURCHASE_RECEIPT、STOCKTAKE 或 RETURN 更正若是在修復帳實錯誤且會使既有預留失去覆蓋，必須在同一交易觸發第 6.2 節的預留衝突流程，不能留下負的 available_to_request。更正單 POSTED 後不可修改；HR_ISSUE 與 RETURN 的 ERP 呈現方式屬調整批次，實際欄位與正負號格式待鼎新規格確認，其餘種類不得進入銷貨匯出。

同一 original_issue_line 的所有 HR_ISSUE 更正與 RETURN／退回過帳共用同一把來源列鎖，並在鎖內滿足：

    effective_issued =
      original_issue_quantity + sum(POSTED issue_quantity_delta)

    effective_issued >= 0
    0 <= sum(POSTED return_quantity)
           + sum(POSTED return_quantity_delta)
       <= effective_issued

負向 HR_ISSUE 更正一定要關聯 original_issue_line_id，且 employee_id、item_id 必須與原明細一致；不得利用可空來源為任意員工或品號憑空加庫。兩張更正、兩張退回，或更正與退回同時 POST 時，都必須由這把鎖序列化後重算累計值。

### 5.3 員工退回

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| return_reason_codes | code PK | label、is_active、sort_order；停用不影響歷史退回單。 |
| return_notes | id PK；return_no UNIQUE；UNIQUE (id, original_hr_request_id) | original_hr_request_id FK、status、return_date、reason_code FK return_reason_codes 必填、note 選填、posted_at/by。 |
| return_lines | id PK；UNIQUE (return_note_id, line_no)；UNIQUE (return_note_id, original_issue_line_id) | original_hr_request_id、original_issue_line_id、employee_id、item_id、quantity、員工與品號 snapshot；兩段複合 FK 強制原發放明細屬於退回表頭的 original_hr_request。 |

退回數量必須大於 0。`(return_note_id, original_hr_request_id)` 必須指向同一 return note，`(original_hr_request_id, original_issue_line_id)` 必須指向同一人資需求的發放明細；employee_id、item_id 與 snapshot 由鎖定的 original_issue_line 推導，前端不得任意指定，constraint trigger 再驗證完全相同。依第 5.2 節鎖定表頭與原發放明細後，同一原發放明細的累計已退回量不得超過 effective_issued；任何表頭／明細錯接整張拒絕。退回確認 POST 時直接增加人資倉；本系統不區分可用與不可用庫存。換尺寸時，退回與新發放是兩筆可追蹤交易，不改寫原明細。

### 5.4 盤點

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| stocktakes | id PK；stocktake_no UNIQUE | warehouse_id、status、counted_on、note、created_by、posted_at/by。 |
| stocktake_lines | id PK；UNIQUE (stocktake_id, item_id) | item_id、book_quantity_snapshot、balance_version_snapshot、book_captured_at、counted_quantity、counted_at、difference_quantity、reason。 |

difference_quantity 固定為 counted_quantity - book_quantity_snapshot；差異非 0 時 reason 必填。POST 時才依差額寫庫存流水，不能直接覆寫 inventory_balances。若 POST 當下 inventory_balances.version 不等於 balance_version_snapshot，盤點必須以 `STALE_COUNT` 失敗；使用者須重新取得帳面版本並重新實盤，同時更新 book、count 及其時間，禁止只換 book snapshot 卻沿用舊 counted_quantity。人資只能過帳人資倉盤點，倉庫角色只能過帳總倉盤點；SYSTEM_ADMIN 只有在同一 app_account 另具對應 HR／WAREHOUSE 角色時才能執行，並留下實際操作者。

## 6. 庫存帳、餘額與預留

### 6.1 庫存過帳與不可變流水

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| inventory_postings | id PK；idempotency_key UNIQUE | posting_kind、request_fingerprint、posted_at/by；以專用外鍵關聯且只關聯一個來源：發貨、補庫發貨、採購入庫、盤點、五類更正、退回或期初匯入批次。 |
| inventory_ledger_entries | id PK；UNIQUE (posting_id, line_no) | posting_id、warehouse_id、item_id、movement_kind、quantity_delta、occurred_on、來源明細外鍵。 |
| inventory_balances | PK (warehouse_id, item_id) | on_hand_quantity、version、last_posting_id、updated_at。它是加速查詢的同步投影，不是可人工編輯的帳。 |
| inventory_item_locks | item_id PK FK uniform_items.id | 無業務數字；每個品號建立時預建，用作所有庫存／預留／需求數量交易共同且可排序的 item-level mutex。 |
| inventory_reservations | id PK；UNIQUE (source_hr_request_id, item_id) | item_id、quantity、status、source_hr_request_id、created_at、closed_at、closed_by_posting_id。預留只由已送出的人資需求建立，是跨兩倉的品號層級預留，不歸屬單一倉庫。 |

來源關聯不要只用無外鍵的 source_type + source_id。inventory_postings 實體欄位可採多個 nullable FK，並用 num_nonnulls(...) = 1 保證恰有一個來源；流水明細同理使用對應的 shipment_line_id、replenishment_line_id、receipt_line_id、stocktake_line_id、issue／transfer／receipt／stocktake／return_correction_line_id、return_line_id 或 import_row_id。inventory_reservations 則只有 source_hr_request_id，不得連補庫單。這樣能由 PostgreSQL 保證來源存在。

inventory_ledger_entries 與已 POSTED 的 inventory_postings 是 append-only：

- 禁止 UPDATE／DELETE。
- inventory_balances 只能由過帳函式在同一交易更新。
- 每一來源只允許一筆成功 posting，idempotency_key 防止重送與按鈕連點重複扣庫。相同 idempotency_key 再送時，只有 operation、source id 與 canonical payload 算出的 request_fingerprint 完全相同才回傳原結果；同 key 不同 payload 必須拒絕。
- 所有 inventory_balances.on_hand_quantity 皆不得小於 0。

主要流水：

| 業務事件 | 總倉 | 人資倉 | 系統總量 |
|---|---:|---:|---:|
| 期初庫存 | 依匯入增加 | 依匯入增加 | 增加 |
| 採購入庫 | accepted_quantity 增加 | 0 | 增加 |
| 調庫 actual_transfer_quantity | 減少 | 等量增加 | 不變 |
| 員工發放 issue_quantity | 0 | 減少 | 減少 |
| 退回 | 0 | 增加 | 增加 |
| 盤點／更正 | 依差額 | 依差額 | 依差額 |

一張人資需求單的倉庫發貨過帳，可在同一 inventory_posting 內為每個品號寫三列：總倉調出、人資倉調入、人資倉員工發放。調出與調入必須等量；該 posting 全部流水加總必須等於負的發放量。增庫量不會憑空增加系統總庫存，它只包含在希望由總倉移至人資倉的調庫需求量內。

### 6.2 合計可申請量

提供只讀 view 或穩定函式 v_item_availability，逐品號計算：

    combined_on_hand =
      HR 倉 on_hand_quantity + GENERAL 倉 on_hand_quantity

    active_reserved =
      該品號所有 ACTIVE inventory_reservations.quantity 合計

    available_to_request =
      combined_on_hand - active_reserved

人資需求單的每個品號皆必須滿足：

    issue_quantity + increase_quantity <= available_to_request

在每一個已提交 transaction 邊界，必須維持：

    combined_on_hand >= active_reserved

一般消耗或可延後的負向更正若會破壞此式，必須拒絕。盤點、PURCHASE_RECEIPT 更正或 RETURN 更正若是在修復帳實不符而不得拒絕，則在同一交易把受影響品號之 ACTIVE reservation 所屬人資需求單全部轉為 INVENTORY_REVIEW_REQUIRED，將該批需求單的所有 reservation 轉為 CONFLICTED，之後才過帳真實差額。這些單據不得發貨；人資重新檢查整張單並送出後，才可用同一來源＋品號的 reservation row 重建為 ACTIVE。不得在已提交狀態留下負的 available_to_request。

補庫單依已決議規則不套用這個合計預留上限，也不出現在 active_reserved；它的實際調庫量只在發貨交易中受總倉現有量限制。前端輸入上限只是使用體驗；人資需求的真正限制必須在送出交易內重新計算。不同尺寸因品號不同，不能互相抵充。

inventory_reservations 是品號層級、跨兩倉的合計預留，沒有 warehouse_id，因此 v_item_availability 只能在品號合計層呈現 active_reserved 與 available_to_request。各倉畫面只能分別呈現 on_hand_quantity；除非未來新增具 warehouse_id 的預留配置明細，不得推算或顯示「人資倉預留」與「總倉預留」。

### 6.3 發貨過帳前的最低條件

人資需求單同一品號在正式過帳時必須同時滿足：

- 總倉現有量 >= actual_transfer_quantity。
- 人資倉現有量 + actual_transfer_quantity >= issue_quantity，確保先調入再發放後不出現負庫存。
- 0 <= actual_transfer_quantity <= least(requested_transfer_quantity, 總倉鎖定後現有量)。
- 來源預留仍為 ACTIVE，來源單尚未被取消或過帳。
- shipment.source_request_row_version 等於來源 request.row_version；正式 snapshot 由目前來源重新建立。
- actual_transfer_quantity 若小於上述最大可調量，short_ship_reason_code 必填。

補庫發貨使用相同的實際調庫上限、版本比對及短發原因規則，但沒有「來源預留仍為 ACTIVE」條件，也不建立或關閉 reservation。實際調庫量可以小於調庫需求量；只要上述條件成立，差異即可結案而不建立待補。

## 7. 換季需求、核准與採購

### 7.1 換季需求活動

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| seasonal_campaigns | id PK；campaign_code UNIQUE | name、season、opens_at、closes_at、status、created_by。opens_at < closes_at。 |
| seasonal_campaign_items | PK (campaign_id, item_id) | 活動允許填報的制服品號。 |
| seasonal_campaign_employees | PK (campaign_id, employee_id) | 活動適用員工集合，以及活動開放時的機構、部門快照；正式集合需可追溯。 |
| seasonal_demand_lines | id PK；UNIQUE (campaign_id, employee_id, item_id) | quantity、entered_by、updated_by、hr_modified、hr_note、員工組織與品號 snapshot。 |

需求窗口只能在 OPEN 且目前時間位於開放區間時，依 seasonal_campaign_employees 凍結的機構＋部門快照，為 coordinator_scopes 授權範圍內員工填報；同一活動、員工、品號只會更新同一筆，不得重複加總。員工在活動中途調動不改變本活動的窗口歸屬；新進或漏列員工須由人資具名加入活動集合。截止後窗口不能修改。人資仍可直接修正，系統自動將 hr_modified 設為 true，備註可空白，但 audit_events 必須保留舊值、新值、修改人與時間。

### 7.2 執行長核准與採購決定

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| seasonal_approval_submissions | id PK；UNIQUE (campaign_id, revision) | campaign_id、revision、status（PENDING／RETURNED／APPROVED）、demand_snapshot_hash、submitted_at/by。每次人資送核建立新 revision，不覆寫前次。 |
| seasonal_approval_submission_lines | id PK；UNIQUE (submission_id, item_id) | item_id、demand_quantity_snapshot、品號 snapshot。保存該次送核的完整品號彙總。 |
| seasonal_approval_reviews | id PK；submission_id UNIQUE | decision（RETURN／APPROVE）、reason、reviewed_at/by。RETURN 時 reason 必填；APPROVE 不允許直接修改 submission 數量。 |
| seasonal_approvals | id PK；approval_no UNIQUE；campaign_id UNIQUE；submission_id UNIQUE | approved_at/by、status、demand_snapshot_hash。只在 APPROVE 時建立，並引用被核准的不可變 submission。 |
| seasonal_approval_lines | id PK；UNIQUE (approval_id, item_id)；UNIQUE (id, item_id) | item_id、demand_quantity_snapshot、approved_quantity、品號 snapshot。 |
| seasonal_procurement_lines | id PK；approval_line_id UNIQUE；UNIQUE (id, item_id) | approval_line_id、item_id、supplier_id、supplier_uniform_item 關聯、approved_quantity_snapshot、minimum_order_quantity_snapshot、final_purchase_quantity、difference_reason_code、note、decided_at/by、ordering_completed_at/by。`(approval_line_id, item_id)` 複合 FK 指向同一核准明細，`(supplier_id, item_id)` 指向 supplier_uniform_items；item_id 由核准明細推導。第一版每個核准品號選定一個供應商，但可拆成該供應商的多張採購單。 |
| seasonal_procurement_line_changes | id PK；UNIQUE (procurement_line_id, revision) | old_purchase_limit_quantity、new_purchase_limit_quantity、reason 必填、changed_at/by。只在超收或其他具名例外需提高／調整原最後採購上限時追加，不覆寫 final_purchase_quantity。 |

順序固定為：窗口填報 → 人資彙整修正並建立送核 revision → 執行長核准或填理由退回 → 採購選擇供應商並依該供應商／品號的最低採購量決定最後採購量。退回後人資修正並建立下一個 submission revision；舊 submission、明細與 review 永久保留。採購量不同於核准量時不再次送執行長，但 difference_reason_code 必填；補充 note 選填。核准完成後 approval 與 approval_lines 作為不可變快照，採購不能覆寫核准量。

執行長只能核准某一完整 submission 或填理由退回，不直接改品號數量；需要改量時退回人資。`seasonal_approval_lines.approved_quantity` 第一版等於被核准 submission 的 demand_quantity_snapshot。採購原始 `final_purchase_quantity` 亦不可覆寫；目前可下單上限由最後一筆 seasonal_procurement_line_changes.new_purchase_limit_quantity 推導，若無調整則等於 final_purchase_quantity。每次調整都須保存前值、新值、原因、操作者與時間，且不觸發執行長二次核准。

執行長 review RPC 必須收到 UI 所見的 submission_id、revision 與 demand_snapshot_hash；依第 12 節鎖定 campaign 及 submission 後，重驗該 submission 仍是該活動唯一目前 PENDING 版本且三者吻合，才可原子建立 review 及 approval snapshot。若人資已產生新 revision、舊版本已退回／核准，或內容雜湊不符，整筆拒絕並要求重新載入，不得把舊畫面決定套到新彙總。

人資送核 RPC 與執行長 review RPC 必須共用同一把 seasonal_campaign row lock 及固定鎖序。送核在鎖後要求 campaign = HR_REVIEW、尚無 approval、沒有 PENDING submission，且前一版若存在必為 RETURNED；它原子建立下一 revision／完整明細 snapshot 並把 campaign 轉 PENDING_APPROVAL。PENDING_APPROVAL 期間人資不得修改需求或另建 submission。review 在同一鎖後核准時把 submission／campaign 原子轉 APPROVED 並建立唯一 approval；退回時把 submission 轉 RETURNED、campaign 轉 HR_REVIEW。因兩個 writer 共鎖 campaign，CEO 核准與 HR 送核並行時不可能留下「已核准活動又多一筆 PENDING submission」。

差異原因至少需要可維護代碼表 procurement_difference_reasons；最初可包含已訪談提及的最低採購量、包裝倍數、廠商供貨限制、取消採購。代碼停用不影響歷史資料。

### 7.3 採購單與驗收入庫

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| purchase_order_termination_reasons | code PK | reason_kind（CANCEL／CLOSE_SHORT）、label、is_active、sort_order；停用不影響歷史。 |
| purchase_orders | id PK；po_no UNIQUE | supplier_id、supplier snapshots、order_date、expected_arrival_date、currency（草稿預設 suppliers.default_currency）、tax_type、status、note、ordered_at/by、reopened_at/by、reopen_reason_kind、closed_at/by、close_reason_code FK termination reasons、cancelled_at/by、cancel_reason_code FK termination reasons。 |
| purchase_order_lines | id PK；UNIQUE (purchase_order_id, line_no)；UNIQUE (purchase_order_id, id) | seasonal_procurement_line_id、item_id、item snapshots、initial_ordered_quantity_snapshot、ordered_quantity、unit_price_ex_tax、tax_rate、net_amount、tax_amount、gross_amount。`(seasonal_procurement_line_id, item_id)` 複合 FK 指向同一採購決定；item_id 與 snapshot 由該決定的核准品號推導，initial snapshot 在 ORDERED 時凍結。 |
| purchase_order_line_changes | id PK | purchase_order_line_id、old_quantity、new_quantity、reason 必填、changed_at/by。供超收前調整採購量及其他有理由的數量調整。 |
| purchase_receipts | id PK；receipt_no UNIQUE；UNIQUE (id, purchase_order_id) | purchase_order_id、received_on、status、supplier_delivery_no、note、posted_at/by。 |
| purchase_receipt_lines | id PK；UNIQUE (receipt_id, purchase_order_line_id) | receipt_id、purchase_order_id、purchase_order_line_id、delivered_quantity、accepted_quantity、rejected_quantity、rejection_reason；複合 FK `(receipt_id, purchase_order_id)` → purchase_receipts `(id, purchase_order_id)`，以及 `(purchase_order_id, purchase_order_line_id)` → purchase_order_lines `(purchase_order_id, id)`，強制表頭及採購明細屬於同一 PO。 |

約束與過帳規則：

- ordered_quantity、delivered_quantity、accepted_quantity、rejected_quantity 均不得為負；採購明細 ordered_quantity 必須大於 0。
- DRAFT 可暫存尚未完成的驗收；POST 時必須 delivered_quantity > 0 且 accepted_quantity + rejected_quantity = delivered_quantity，不允許 POST 後留下沒有分類又無法再處理的到貨量。
- rejected_quantity 大於 0 時 rejection_reason 必填；拒收品不寫入庫存。
- 同一採購明細累計已 POSTED 的 accepted_quantity 加本次數量，不得超過目前 ordered_quantity。若實際超收，採購須先調高 ordered_quantity 並留下 purchase_order_line_changes.reason，之後才能過帳。任何 ordered_quantity 變更都不得把新數量降到累計已 POSTED accepted_quantity 以下。
- RECEIVED 採購單若把 ordered_quantity 調高至 effective accepted_to_date 以上，數量變更、狀態轉為 REOPENED、reopen_reason_kind = ORDER_QUANTITY_INCREASE 及配置量重算必須在同一交易完成；不得留下「已完成但仍有未到量」。CLOSED_SHORT／CANCELLED 為終態，不允許再改訂購量；需追加採購時另開新 PO。
- 入庫可分批；POST 一張入庫單時只將 accepted_quantity 增加到總倉。未驗收合格的部分不進庫。
- 採購進度以已 POSTED receipt 加相關更正分開計算 effective delivered_to_date、effective accepted_to_date、effective rejected_to_date 與 remaining_to_accept = ordered_quantity - effective accepted_to_date；拒收品預設仍屬待供應商補交，不得被誤列為「從未到貨」。effective accepted_to_date 等於 ordered_quantity 時轉 RECEIVED。
- 供應商確定不再補足時，採購以必填 close_reason_code 將 ORDERED／PARTIALLY_RECEIVED／REOPENED 轉為 CLOSED_SHORT，凍結未完成量並禁止後續入庫；完全沒有任何 POSTED 收貨單的訂單才可 CANCELLED。即使合格量為 0，只要已正式記錄到貨／拒收就不得假裝從未收貨；已有收貨而終止剩餘數量一律用 CLOSED_SHORT，不能刪除或改寫既有紀錄。
- POSTED 入庫單與其明細不可修改。重複提交由唯一 posting 及 idempotency_key 擋下。
- 金額欄是採購單列印與成本分析快照，不建立付款、傳票或應付帳款資料表。

一個 seasonal_procurement_line 可以拆到同一選定供應商的多張採購單或多列；purchase_orders.supplier_id 必須等於該 procurement line.supplier_id，purchase_order_line.item_id 必須等於該 procurement line 經 approval_line 核准的 item_id，且該供應商＋品號必須存在啟用中的 supplier_uniform_items 關係。品號鏈以複合 FK 強制，供應商表頭則在 DRAFT 儲存與轉 ORDERED 的受控函式中鎖定 PO／procurement line 後重驗；任何一列錯借別品號的核准上限都整張拒絕。每張 PO 轉 ORDERED 時，先鎖定該 seasonal_procurement_line 與所有關聯 purchase_order_lines，並以目前採購上限檢查配置量：

    current_purchase_limit =
      最後一筆 seasonal_procurement_line_changes.new_purchase_limit_quantity
      （若無調整則為 final_purchase_quantity）

    allocated_quantity =
      開放／已完成 PO lines 的 ordered_quantity
      + CLOSED_SHORT PO lines 的 effective accepted_to_date
      + CANCELLED PO lines 的 0

`allocated_quantity` 永遠不得超過 current_purchase_limit；採購將該 procurement line 標記 ordering completed 時兩者必須相等。CLOSED_SHORT 釋放未收部分，使採購可在同一上限內另開替代 PO；若要讓訂購合計超過原上限，須先追加 seasonal_procurement_line_changes，再追加具理由的 purchase_order_line_changes，不得只放大 PO。報表同時呈現核准量、原 final_purchase_quantity、目前上限、目前配置量與所有調整原因。

purchase receipt POST、PURCHASE_RECEIPT correction、purchase_order_line_changes、採購上限調整、PO 取消與短收結案必須依共同順序共用 purchase_order header、seasonal_procurement_line 及所有相關 purchase_order_line 的 SELECT ... FOR UPDATE 鎖。取得鎖後重新讀取 PO 狀態、POSTED receipt／corrections 是否存在、effective accepted／rejected／delivered、remaining、current_purchase_limit 與 allocated_quantity，再決定是否過帳、更正或終止；兩張並行入庫、入庫／更正與減單、入庫／更正與取消／結案，或任何採購配置／上限調整不得各自依舊快照通過。取消只在鎖後確認不存在任何 POSTED receipt 時成功；CLOSED_SHORT 在鎖後確認已有 POSTED receipt 且寫入原因後成功，兩種終止狀態均阻擋之後的 receipt POST。

## 8. 匯入批次與期初庫存

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| system_cutover_state | singleton_key PK 且固定 GLOBAL | status（PRE_CUTOVER／LIVE）、opening_import_batch_id UNIQUE、opening_posting_id UNIQUE、live_at/by、row_version；migration 預建且永遠只有一列。 |
| import_batches | id PK；batch_no UNIQUE | import_type、status、original_filename、expected_mime_type、expected_size_bytes、file_sha256、storage_object_key UNIQUE、upload_expires_at、mapping_version、processing_cursor、cursor_version、lease_token、lease_generation、lease_owner、lease_expires_at、attempt_count、max_attempts、next_retry_at、last_error_code、last_error_message、upload_started_at/by、uploaded_at/by、validated_at、applied_at/by、terminal_at、staging_purged_at、row counts。`terminal_at` 是 FAILED／CANCELLED retention episode 的資料庫時鐘；`staging_purged_at` 只可在該 episode 滿 90 天後由專用 retention RPC 設定。 |
| import_batch_chunks | id PK；UNIQUE (batch_id, phase, chunk_no)；idempotency_key UNIQUE | batch_id、phase、start_row_number、end_row_number、status、processing_cursor、cursor_version、lease_token、lease_generation、lease_owner、lease_expires_at、attempt_count、next_retry_at、last_error_code、last_error_message、started_at、completed_at。phase 至少有 PARSE、VALIDATE。 |
| import_rows | id PK；UNIQUE (batch_id, row_number) | raw_values jsonb、normalized_values jsonb、proposed_action、validation_errors jsonb、target_entity_id、applied_at。 |
| import_field_diffs | id PK；UNIQUE (import_row_id, field_name) | old_value jsonb、new_value jsonb、confirmed。 |

import_type 至少支援機構、部門、員工、制服品號、供應商、供應商品號條件與期初庫存。流程為：

1. `start_import_upload` 先以冪等命令建立 AWAITING_UPLOAD batch、不可猜測且不可覆寫的唯一 storage_object_key、預期 MIME／大小與 upload_expires_at；此時不建立可執行的 parse chunk。瀏覽器只能直傳該固定 key。
2. `confirm_import_upload` 從 Storage 查驗固定 key 的 MIME、實際大小、SHA-256 與完成 metadata；吻合時在短交易填入 file_sha256、轉 UPLOADED 並建立固定列範圍的第一批 PARSE chunks。回應遺失依原 batch／key 查回，不另配 key；逾期且未成功確認的 AWAITING_UPLOAD 可受控取消，孤兒 bytes 經無引用檢查後清理。
3. 解析與驗證工作依固定列範圍建立 durable import_batch_chunks；每個完成 chunk 都在獨立短交易提交 import_rows 與 durable cursor，不能只把進度放在 Vercel 記憶體、`/tmp` 或單次 HTTP request。
4. 顯示新增、更新、略過與錯誤筆數；員工以 employee_no 比對，制服以 item_code 比對。
5. 使用者確認欄位差異後才呼叫套用 RPC。
6. 相同工號更新目前基本資料，不新增第二位員工，也不改寫任何歷史 snapshot；Excel 缺少某列不會刪除員工。
7. 期初庫存批次只能在正式上線切點套用，套用後建立不可變 inventory_posting 與 ledger entries，不直接寫 balance。

第一版固定採「整批驗證成功才套用」：只要有一列錯誤，該批任何正式資料都不發布；使用者下載錯誤、修正檔案後重新上傳。內部解析／驗證可以 durable chunk 短交易續跑，但最終套用正式主檔或期初庫存仍是一個單一、可回滾、具 idempotency 的資料庫交易。

期初發布另有全系統 once-only gate：`publish_opening_balance` 先鎖 system_cutover_state singleton，要求仍為 PRE_CUTOVER、opening_import_batch_id／opening_posting_id 皆為 NULL，且不存在任何非 OPENING_BALANCE 的正式 inventory_posting。期初批次套用、唯一 opening posting／ledger、兩倉 balances、singleton 指向該批次／posting 並轉 LIVE 必須在同一交易提交；任何第二個批次或不同冪等鍵都無法再次發布。所有非期初的庫存過帳 RPC 都先要求 system_cutover_state = LIVE。

批次與 chunk 的租約／重試不變條件：

- worker 必須由受控 RPC 以 SELECT ... FOR UPDATE SKIP LOCKED 原子取得 PENDING／可重試或 lease 已逾期的 chunk，寫入不可猜測的 lease_token、lease_owner、lease_expires_at、增加 attempt_count，並在每次取得或接手時嚴格增加 lease_generation。`lease_generation` 是 fencing token；token 相同也不得跨 generation 使用。
- 每次 heartbeat、推進 cursor、完成或記錄失敗都必須帶入 expected cursor_version，並在同一 statement／transaction 以 `(id, lease_token, lease_generation, lease_expires_at > transaction_timestamp(), cursor_version = expected)` 做 compare-and-swap；成功後 cursor_version 加 1。更新 0 列代表租約已逾期、已被接手或 cursor 已前進，整個交易必須 rollback，逾期 worker 不得寫回 import_rows、錯誤或完成狀態。
- chunk claim 是獨立短交易，固定先鎖 batch 再以 SELECT ... FOR UPDATE SKIP LOCKED 取得 chunk。每次完成 chunk 的新交易也固定先鎖 batch、再鎖 chunk，通過兩者的 fencing／cursor CAS 後，才可 upsert 由 UNIQUE (batch_id, row_number) 保護的 import_rows、更新 chunk.processing_cursor，並由資料庫重算 batch 的最高連續 cursor、增加 batch.cursor_version。batch cursor 只能代表「從第一列起所有前置 chunk 皆 COMPLETED 的最高連續列」，不得因較後面的 chunk 先完成而跨越缺口；不能由 worker 傳入任意較大值。
- batch lease 負責 phase transition／最終 APPLY，取得或接手時同樣增加 batch.lease_generation；每次 transition／APPLY 都須驗證未逾期的 batch token＋generation 與 expected batch.cursor_version。chunk lease 可供多 worker 處理互不重疊的固定列範圍。worker crash 後只能由新 generation 接手，舊 generation 永遠不能完成；已完成列不得重複建立。
- 可重試錯誤保存 last_error_code／last_error_message 並以 next_retry_at 排程；attempt_count 到 max_attempts 後轉 FAILED。錯誤欄位不得保存密碼、token 或完整敏感資料。
- 所有 PARSE 與 VALIDATE chunks COMPLETED 且無驗證錯誤後才能轉 VALIDATED。APPLYING 必須持有有效 batch fencing lease；APPLIED 只能由最終套用交易設定，且正式資料寫入、operation_commands 成功結果與 APPLIED 必須同一交易提交。相同套用 idempotency key 重送回傳原結果，不得再寫主檔或期初流水。

import_rows 保留逐列結果；`APPLIED` 批次及其已套用列、已完成 chunks 與差異資料不可 UPDATE／DELETE。從未套用且已 `FAILED／CANCELLED`、目前 terminal episode 已滿 90 天的批次，`0074_import_staging_payload_retention.sql` 只允許專用 `job_import_retention` RPC 把 `raw_values` 清為 `{}`、`normalized_values` 清為 NULL、`validation_errors` 清為 `[]`，不刪除 row shell、chunk 或 `import_field_diffs`，並在同一交易設定 batch 的 `staging_purged_at`。purge 後該 batch 不可 restart；若需重新處理來源，必須建立新 batch。batch header、檔名、file_sha256、行數、操作者、結果摘要與 purge marker 永久保留；原始 Storage bytes 可另依保存政策由 `job_storage_cleanup` 清除。file_sha256 用於警示重複檔案，不應單獨設成全域 UNIQUE，因同一檔可能是合法的重新驗證。

## 9. 鼎新 ERP 銷貨匯出

### 9.1 正式批次

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| erp_export_batches | id PK；batch_no UNIQUE | export_kind、distribution_date、institution_id_snapshot、institution_code/name_snapshot、status、source_snapshot_hash、active_artifact_id、current_artifact_id、prepared_at/by、generated_at/by、generation_failed_at、import_failed_at、import_confirmed_at/by、last_error_code、last_error_message。active／current 都以同父複合 FK 指向本 batch 的 artifact。 |
| erp_export_batch_lines | id PK；UNIQUE (batch_id, line_no) | item_id、item_code_snapshot、品項描述 snapshot、quantity、以及日後依鼎新格式增加的凍結欄位。 |
| erp_export_source_links | id PK | batch_line_id，以及 issue_line_id、issue_correction_line_id、return_line_id、return_correction_line_id 四者擇一；source_quantity。以 CHECK num_nonnulls(...) = 1 及四個 partial unique index 防止同一銷貨來源重複匯出。調庫、入庫與盤點更正不得成為銷貨來源。 |
| erp_export_artifacts | id PK；idempotency_key UNIQUE；UNIQUE (batch_id, revision)；UNIQUE (batch_id, id) | batch_id、status、revision、supersedes_artifact_id、is_current、format_version、storage_object_key、payload_sha256、request_fingerprint、winning_attempt_id、prepared_at/by、ready_at、failed_at、error_code、error_message；另以 partial UNIQUE (batch_id) WHERE status = PREPARING 保證每批至多一個 active revision，supersedes 與 winner 皆用同父複合 FK。 |
| erp_export_render_attempts | id PK；attempt_key UNIQUE；UNIQUE (artifact_id, attempt_no)；UNIQUE (artifact_id, id)；temp_object_key UNIQUE | artifact_id、attempt_no、status、lease_token、lease_generation、lease_expires_at、temp_object_key、payload_sha256、started_at、uploaded_at、succeeded_at、failed_at、error_code、error_message。 |
| erp_export_download_events | id PK | batch_id、artifact_id、downloaded_at/by。每次下載追加一列並固定指向當次 artifact revision，不改寫檔案內容。 |

正式發放批次只納入已 SHIPPED 人資需求單的 hr_issue_lines.quantity。建立邏輯批次時先在單一 snapshot transaction 內鎖定候選來源、建立 PREPARING batch／彙總列／source links 並計算 source_snapshot_hash；此時已占用來源，但尚未選擇輸出格式，也沒有可下載檔案：

- 先依 distribution_date + 發放明細 institution snapshot 分成不同批次。
- 每個批次內再依 item_id／item_code 加總為匯出列。
- source_links 保存每個彙總數量回到員工發放明細的完整追溯。
- 發放量之外的增庫量、調庫量、採購入庫量及換季需求量不得加入銷貨匯出。
- 每一 hr_issue_line 只能歸入一個正式發放批次；可用 issue_line_id 的 partial unique index 防止重複匯出。
- PREPARING 起批次分組、明細、來源連結及 source_snapshot_hash 即不可修改；其他工作不可再取得這些來源。`create_erp_export_batch` 的 operation command 在這個 snapshot transaction 內設 SUCCEEDED 並指向 batch，不跨越後續 Storage 工作。
- `request_erp_artifact` 使用獨立冪等鍵，鎖定既有 logical batch，重驗 active_artifact_id 為 NULL 且不存在其他 PREPARING artifact，明確選擇 format_version，以 frozen source_snapshot_hash 計算 request_fingerprint，建立下一個 PREPARING artifact revision 與第一個 PENDING attempt、設定 active_artifact_id，並在同一短交易把該 revision request command 設 SUCCEEDED。初次產檔、GENERATION_FAILED 重試及 IMPORT_FAILED 格式修正都走此介面；後兩者沿用同一 batch/source snapshot 並把 batch 受控轉回 PREPARING。不同冪等鍵並行時最多一個可建立 active revision。
- renderer 只讀 frozen batch snapshot 與 PREPARING artifact 的 format_version；取得 attempt fencing lease 後轉 RENDERING，輸出至唯一 temp_object_key 並計算 hash。它不得直接把 artifact 設 READY 或 batch 設 GENERATED，也不得更新已 SUCCEEDED 的 batch／revision request command。
- finalize／terminal-fail RPC 都鎖定 batch、artifact 與 attempt，並先驗證 batch.active_artifact_id 等於本 artifact。finalize 另驗證 attempt token＋lease_generation＋未逾期期限、RENDERING 狀態、temp object metadata、hash、artifact fingerprint 及 source_snapshot_hash；只有第一個合法 finalize winner 可在同一交易把 attempt 設 SUCCEEDED、artifact 設 READY／current、batch 設 GENERATED、清空 active_artifact_id 並指定 current_artifact_id。terminal fail 只可把同一 active artifact 設 FAILED、batch 設 GENERATION_FAILED 並清空 active pointer。舊 revision 或競爭輸家都不得推進 batch，其 temp object 由受控清理回收。
- 同一 batch＋revision 只有一個 artifact；同一 batch 最多一個 READY current artifact。若轉接器修正需重產，新增 revision／supersedes，不覆寫舊 payload、hash 或 format_version；舊 READY 只允許由 finalize RPC 將 is_current 由 true 降為 false。
- GENERATION_FAILED 保存錯誤但不提供下載；GENERATED／DOWNLOADED 才能下載 READY current artifact。重複下載同一 artifact revision 必須回傳相同 storage_object_key 與 payload_sha256，並由 download_events 留痕。
- 鼎新回報失敗時批次轉 IMPORT_FAILED，仍保留來源及所有 artifact revisions；可重送同一 READY revision，或依明確修正建立新 revision。成功後才轉 IMPORT_CONFIRMED，IMPORT_FAILED 不得解散批次或讓來源進入另一批次。
- 發貨後的 HR_ISSUE 更正、退回及 RETURN 更正另建 adjustment 類型批次，不修改原正式批次，並各自對來源明細設 partial unique index。

ERP ownership pointers 必須由資料庫強制同父關係，不能只由應用檢查：`(batch_id, supersedes_artifact_id)` 複合 FK 指向同 batch 的 artifact、`(artifact_id, winning_attempt_id)` 複合 FK 指向同 artifact 的 attempt，`(batch.id, batch.active_artifact_id／current_artifact_id)` 分別指向同 batch 的 PREPARING／READY artifact。循環 FK 可設 DEFERRABLE 並由 request／finalize／fail RPC 在同一交易驗證；不得讓一個 batch 指到另一批的 artifact，或讓競爭 attempt 成為別的 artifact winner。

### 9.2 外部依賴：鼎新欄位映射

目前只確認：

- 制服 item_code 就是鼎新 ERP 品號。
- 匯出來源只取人資發放量。
- 發貨後才能匯出。
- 依發放日期＋機構分組，再依品號加總。
- 正式批次不可重複產生，更正與退回走調整批次。

尚未取得鼎新銷貨單匯入範本與欄位規格，因此以下內容不得先猜測或硬寫進業務表：

- 檔案格式、編碼、分隔符、表頭、欄位順序與日期／小數格式。
- 鼎新銷貨單別、客戶／機構對應碼、庫別、部門、業務員、稅別、幣別與單號規則。
- 必填固定值、批號、備註、負數／退貨／更正的表示方式。
- ERP 匯入成功的回執欄位與是否能自動確認。

取得範本後應新增版本化 mapping 定義與測試樣本，讓每個 erp_export_artifacts.format_version 指向確切版本；既有 artifact revision 永遠保留原格式版本與原始檔 hash。未取得格式前只能完成批次資料集與預覽，不能宣稱已產出可匯入鼎新的正式檔案。

## 10. 異動紀錄與列印成品

### 10.1 異動紀錄

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| audit_events | id PK | occurred_at、actor_account_id FK app_accounts.id、action、entity_table、entity_id、before_data jsonb、after_data jsonb、reason、request_id／correlation_id、client metadata。 |

audit_events 由資料庫 trigger 或受控 RPC 寫入，前端無 INSERT／UPDATE／DELETE 權限。至少涵蓋：

- 員工及其他主檔新增、更新、停用與 Excel 套用。
- 人資需求送出前後的發放量、增庫量與明細更正。
- 換季需求由人資修改的舊值、新值與操作者，即使備註空白也要記錄。
- 採購量相對核准量的差異、採購單數量調整及原因。
- 所有狀態轉換、過帳、取消、ERP 產生、下載與確認匯入。
- 權限角色與窗口範圍異動。

已 POSTED／SHIPPED／APPROVED 的業務資料不可變，因此稽核表記錄後續建立的更正或調整關係，而不是偽造對原資料的 UPDATE。audit_events 本身永久 append-only。durable import 的 `import_rows` 是 retention 例外：`0073_import_staging_audit_minimization.sql` 起只把 id、batch_id、row_number、proposed_action、target_entity_id、applied_at 寫入永久 before／after audit，不複製 raw_values、normalized_values、validation_errors；其他業務 table 維持完整列 audit。既有 audit history 不由該 migration 回寫或刪除。

### 10.2 A4 PDF

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| document_artifact_families | PK (document_type, document_id, artifact_kind) | active_artifact_id、current_artifact_id、next_revision；作為同一文件家族的鎖定根，active／current 以同父複合 FK 指向本家族 artifact。 |
| document_artifacts | id PK；idempotency_key UNIQUE；UNIQUE (document_type, document_id, artifact_kind, revision)；UNIQUE (document_type, document_id, artifact_kind, id) | document_type、document_id、artifact_kind、status、revision、source_snapshot_version、source_snapshot_hash、supersedes_artifact_id、is_current、template_version、storage_object_key、sha256、request_fingerprint、winning_attempt_id、error_code、error_message、prepared_at/by、ready_at/by、failed_at；partial UNIQUE (document_type, document_id, artifact_kind) WHERE status = PREPARING，supersedes 與 winner 皆用同父複合 FK。 |
| document_render_attempts | id PK；attempt_key UNIQUE；UNIQUE (artifact_id, attempt_no)；UNIQUE (artifact_id, id)；temp_object_key UNIQUE | artifact_id、attempt_no、status、lease_token、lease_generation、lease_expires_at、temp_object_key、sha256、started_at、uploaded_at、succeeded_at、failed_at、error_code、error_message。 |

artifact_kind 至少區分 DRAFT_WATERMARK 與 FORMAL。正式 PDF 使用已凍結 snapshot，包含單號、狀態、日期、操作者及簽名欄。正式成品一旦產生不可覆寫；版面重產要新增 revision，supersedes_artifact_id 指向同一 document_type／document_id／artifact_kind 的前一版本並保留舊 hash。草稿必須有明顯浮水印。

成品採 artifact 與 render attempt 分離的可恢復流程：

1. 受控函式在短交易內鎖定來源及 document_artifact_family，重驗 active_artifact_id 為 NULL 且不存在其他 PREPARING revision，再從 next_revision 配號，以 idempotency_key 與 canonical request_fingerprint 建立一個 PREPARING artifact revision 及第一個 PENDING attempt，設定 family.active_artifact_id，並明確凍結 source_snapshot_version、source_snapshot_hash 與 template_version；request_fingerprint 必須涵蓋 document identity、artifact kind、來源版本／hash 與範本版本。同 key 同 fingerprint 重送回傳原 artifact，同 key 不同內容拒絕；`request_document` command 在此交易設 SUCCEEDED 並指向 artifact，不等待外部 render。只有內容、來源 snapshot、範本版本改變或使用者明確要求重產時才建立新 revision；不同冪等鍵並行時最多一個可建立 active revision，worker retry 不建立 revision。
2. 每次嘗試先建立具唯一 attempt_key 的 PENDING render attempt。job-specific renderer 原子取得 attempt 後轉 RENDERING，寫入隨機 lease_token、嚴格增加 lease_generation 與期限，輸出至該 attempt 專屬且不可公開的 temp_object_key，並計算 SHA-256。heartbeat／失敗／finalize 都必須驗證 token、generation 與未逾期 lease；舊 generation 不得寫回。
3. finalize RPC 依序鎖定 family、artifact 與 attempt，驗證 family.active_artifact_id 正是本 artifact、artifact 仍 PREPARING、winning_attempt_id 為 NULL、attempt 仍 RENDERING 且 fencing lease 有效、request fingerprint／template version／source snapshot version＋hash 相符，以及暫存物件 metadata／hash 完整。只有第一個通過者可在同一交易將 attempt 設 SUCCEEDED、把其 temp_object_key／sha256 指定為不可變正式內容、artifact 設 READY、寫 winning_attempt_id、把舊 current 的 is_current 降為 false、設定新 current 並清空 active pointer；較舊／較新家族 revision 或競爭輸家不得奪取 current，也不得覆寫 storage key 或 hash。
4. 單次 render 失敗只把 attempt 設 FAILED 並保存不含敏感內容的 error_code／error_message；可在同一 PREPARING artifact 建立新 attempt。達到明定 max attempts 或確認不可重試後，terminal-fail RPC 鎖定 family 並驗證 active_artifact_id 後，才把 artifact 設 FAILED、清空 active pointer；FAILED 永遠不是 current，也不可下載。
5. READY 時 storage_object_key、sha256 與 winning_attempt_id 必填且互相對應；PREPARING／FAILED 不得被當成可下載成品。每個 document_type＋document_id＋artifact_kind 最多一個 `is_current = true AND status = READY`，以 partial unique index 保證。新 revision READY 的 finalize 交易可把舊 READY 的 is_current 由 true 改為 false；除此之外，READY artifact 的狀態、內容、hash、fingerprint、revision、supersedes 與 winner 不得 UPDATE／DELETE。

supersedes_artifact_id 只能指向同一 document_type／document_id／artifact_kind 且 revision 較小的 artifact。document_type + document_id 是跨多種單據的附件關聯，若採通用 polymorphic 欄位，產生函式必須驗證來源存在；若要完全依賴 FK，可依單據種類拆成各自 artifact link 表。Storage 清理工作只能刪除未被任何 READY artifact 引用、不是任何 winning attempt 且已逾保存期限的失敗／競爭輸家暫存物件，不能只依檔名推斷。

`(document_type, document_id, artifact_kind, active_artifact_id／current_artifact_id／supersedes_artifact_id)` 必須以複合 FK 指向同一文件家族，`(artifact_id, winning_attempt_id)` 必須以複合 FK 指向同 artifact attempt；FORMAL artifact 的 source_snapshot_version／hash 在 PREPARING 即必填，READY 後不可變。request_fingerprint 是冪等摘要，不能取代可查詢、可列印稽核的來源版本及 hash 欄位。

### 10.3 正式檔案封存關聯

READY artifact 與 APPLIED import batch 不增加可回寫的 archived_at／archive key 欄位。封存以旁掛資料保存，不放寬正式來源的不可變 trigger：

| 實體 | 主鍵／唯一鍵 | 關鍵欄位與關係 |
|---|---|---|
| storage_archive_records | id PK；archive_record_key UNIQUE | erp_artifact_id、document_artifact_id、import_batch_id 三者恰一；original_storage_object_key、source_sha256、archive_object_key UNIQUE、archive_payload_sha256、manifest_sha256、verified_at、finalized_at/by。只在異地物件回讀及 hash 驗證成功後由 finalize_archive 插入，插入後不可 UPDATE／DELETE。 |
| storage_object_lifecycle_events | id PK | archive_record_id、event_kind（PRODUCTION_REMOVED／RESTORED）、event_at/by、details；append-only。 |

同一來源可因異地世代輪替有多筆 archive record，但清除 production bytes 前必須存在涵蓋相同 original key＋source hash 的有效 finalized record；清除／還原另追加 lifecycle event。下載畫面的「線上／已封存／需還原」由來源、finalized archive record 與最新 lifecycle event 推導，不修改 READY artifact 或 APPLIED batch。

## 11. 建議 PostgreSQL 不變條件

除前述欄位 CHECK 外，至少實作：

1. **業務鍵唯一**：institution、department、supplier 的 code、employee_no、item_code 與所有正式單號皆必填並唯一；department code 以 institution_id＋code 為唯一範圍，其餘依前述業務範圍建立唯一索引。
2. **帳號歷史穩定**：所有 actor FK 指向 app_accounts.id；auth_user_id 只作目前登入綁定且有值時唯一。rebind 只能改同一 app_account 的綁定並追加 account_auth_binding_events，不得改歷史 actor 或合併兩個人的帳號。
3. **組織一致**：員工與窗口範圍的 department_id 必須屬於同一 institution_id。
4. **單據彙總一致**：hr_request_items.issue_quantity 必須等於 hr_issue_lines 依品號合計；requested_transfer_quantity 固定等於 issue + increase。
5. **送出上限**：人資需求每個品號 requested amount 不得超過兩倉合計現有量扣除其他 ACTIVE 預留；補庫不建立 reservation。
6. **預留必有覆蓋**：每個品號在 transaction commit 時 combined_on_hand >= ACTIVE reserved；帳實更正造成不足時，必須在同交易把受影響整張需求及其所有預留轉為 INVENTORY_REVIEW_REQUIRED／CONFLICTED。
7. **庫存不為負**：任何過帳後每個 warehouse_id + item_id 的 on_hand_quantity >= 0。
8. **調庫成對且對源相等**：同一 shipment／replenishment posting 的 transfer-out 與 transfer-in 依品號等量反向，絕對值等於來源 actual_transfer_quantity；人資發放流水等於負 issue_quantity，整筆公司總量變化等於負發放量。
9. **實際調庫與版本**：actual transfer 不得超過鎖後 `least(requested, GENERAL on_hand)`；低於最大可調量時短發原因必填；來源 row_version 不同即拒絕舊倉庫草稿。
10. **有效發放與退回**：effective_issued 不得為負；原發放明細的累計原退回＋RETURN 更正必須介於 0 與 effective_issued，並以原發放列鎖序列化。
11. **盤點版本一致**：stocktake.balance_version_snapshot 必須等於 POST 當下 balance.version；不同即要求重新實盤，不得套用舊 counted_quantity。
12. **入庫全數分類**：原始 POSTED receipt line 必須 delivered > 0 且 accepted + rejected = delivered；套用所有 POSTED receipt corrections 後允許完全沖回為 0，但仍須滿足 effective delivered／accepted／rejected >= 0 且 accepted + rejected = delivered；拒收不入庫。
13. **採購累計上限**：effective accepted_to_date 不得超過 ordered_quantity，ordered_quantity 不得降到 effective accepted_to_date 以下；receipt POST、更正與訂購量變更共用 purchase_order_line lock。
14. **採購配置守恆**：各 seasonal_procurement_line 的 current_purchase_limit 由不可變原 final_purchase_quantity 加後續具理由的調整推導；開放／完成 PO 以 ordered quantity、CLOSED_SHORT 以 effective accepted、CANCELLED 以 0 計入配置，合計不得超過目前上限，標記 ordering completed 時必須相等。採購單供應商必須等於該品號已選定供應商。
15. **採購終止明確**：合格量不足且不再補交時只能 CLOSED_SHORT；已有任何 POSTED 收貨紀錄不得 CANCELLED，任何終止狀態禁止後續 receipt。
16. **不重複過帳**：每一來源單只有一個 POSTED inventory_posting；idempotency_key 唯一且綁定 operation、source 與 request_fingerprint，同 key 不同 payload 拒絕。
17. **不重複換季需求**：UNIQUE (campaign_id, employee_id, item_id)。
18. **不重複 ERP 匯出**：每一發放、更正或退回來源明細從 PREPARING snapshot 建立 source link 起，只可進一個相對應批次；GENERATION_FAILED／IMPORT_FAILED 不釋放來源。
19. **來源恰一**：使用 num_nonnulls(...) = 1 限制 posting、ledger source、各 correction source 與 ERP source link 只能有一個來源；inventory_reservations 只允許 source_hr_request_id。
20. **正式內容不可變、生命週期受控**：trigger 阻擋對 POSTED、SHIPPED、APPROVED、APPLIED、READY 的正式內容與明細做任意 UPDATE／DELETE；合法業務修正建立新單、revision 或事件。ERP logical batch 從 PREPARING 起即凍結 export kind、日期／機構 snapshot、source_snapshot_hash、batch lines 與 source links，但 batch header 的白名單生命週期欄位可由具名 RPC 更新：status、active_artifact_id、current_artifact_id、generated／download／import 時間與操作者、成功回執，以及安全化錯誤欄位，用來完成 `PREPARING／GENERATION_FAILED／GENERATED／DOWNLOADED／IMPORT_FAILED／IMPORT_CONFIRMED` 轉換；不得藉此改來源或彙總。READY artifact 的唯一內容外更新例外，是新 revision finalize RPC 在同一交易把舊 current 的 is_current 由 true 降為 false；舊 payload、hash、winner、format、revision 與 READY 狀態仍不可變。
21. **狀態轉換受控**：以 RPC 白名單驗證轉換，避免任意 UPDATE 跳過送出、發貨、核准、過帳、短收結案或成品完成。非單向例外只允許明列的 PO `RECEIVED -> REOPENED`（入庫更正或具理由的訂購量增加）、人資需求 `INVENTORY_REVIEW_REQUIRED -> SUBMITTED`（依最新庫存重驗、增加來源版本並重建 ACTIVE reservations）、ERP `GENERATION_FAILED／IMPORT_FAILED -> PREPARING`（同 frozen snapshot 建立下一 artifact revision）、ERP `IMPORT_FAILED -> IMPORT_CONFIRMED`（保留的 READY revision 重送後取得成功回執），以及失敗匯入 chunk 經人工確認後 `FAILED -> PENDING／RETRY_WAIT` 的同 batch 續跑；每次都須由具名 RPC、相應原因／回執及 audit 支撐。
22. **快照完整**：人資需求 SUBMITTED、核准 APPROVED、採購 ORDERED、發貨 POSTED、匯出 GENERATED 與 artifact READY 前，所需 snapshot／hash／來源版本欄位不得為 NULL；FORMAL document artifact 從 PREPARING 起即須有 source_snapshot_version 及 source_snapshot_hash。
23. **匯入可續跑但只套用一次**：AWAITING_UPLOAD 只能在固定 key 的物件 metadata／大小／MIME／hash 驗證成功後轉 UPLOADED 並建立 PARSE chunks；batch／chunk 的 token、嚴格遞增 lease_generation、未逾期 lease 與 expected cursor_version CAS 全部通過後才能寫進度；UNIQUE row key 防止重送。只有全批驗證成功可 APPLY，APPLIED 批次不得再次建立主檔或期初流水。
24. **PDF 成品版本唯一**：document artifact 的 idempotency key 綁定含來源版本／hash 的 fingerprint；同一文件家族最多一個 PREPARING active 與一個 READY current revision。request／finalize／terminal fail 共鎖 family root 並驗證 active_artifact_id；supersedes 只能指向同一文件與種類的較舊 revision。每個 attempt 有唯一 key／temp object，只有 fencing lease 有效且仍為家族 active 的第一個 finalize winner 可寫 READY；stale revision 不得奪回 current，attempt retry 不新增 revision。
25. **ERP snapshot 與成品分離**：logical batch 的 PREPARING snapshot transaction 先不可變地占用來源並完成 batch command；artifact revision 由另一個具格式版本的冪等 request 建立。每 batch 至多一個 PREPARING active artifact；request、finalize 與 terminal fail 都鎖 batch 並驗證 active_artifact_id，完成後清空。沒有 READY winning artifact 的 batch 不得 GENERATED。每個 artifact revision 最多一個 SUCCEEDED winner、每 batch 最多一個 READY current，GENERATION_FAILED／IMPORT_FAILED 不得讓來源重複入批。
26. **命令結果恰一次**：operation＋idempotency key 唯一且綁定 canonical fingerprint／actor；有效 IN_PROGRESS 回傳進行中，SUCCEEDED 回傳同一 result，payload 不同拒絕。接手與完成須通過 lease generation fencing，business writes 與 success outcome 同交易；外部檔案流程的 business result 是 PREPARING batch／artifact 工作已耐久建立，不是等待 READY，後續完全由 attempt fencing 狀態機管理。
27. **共同鎖序**：所有會讀寫同品號庫存、需求、預留、盤點、更正或收貨的 RPC 必須先依 item_id 排序鎖 inventory_item_locks，再依第 12 節順序鎖後續資料；不得有 reservation → balance 與 balance → reservation 兩種相反順序。
28. **送核版本不可變且單一目前版**：每次人資送執行長審查都建立完整 submission revision 與品號彙總 snapshot；送核與 review 共鎖 campaign，同一活動最多一個 PENDING submission。執行長只能核准該版或填理由退回；PENDING 期間人資不得改需求或重送。退回、重送與最後核准均追加 review／approval 關係，不覆寫舊 submission，APPROVED 後不得再出現新 revision。
29. **父子與業務身份一致**：發貨表頭／來源人資需求／品號彙總列、核准明細／採購決定／PO line 的 item、PO supplier／採購決定 supplier、purchase receipt header／line／PO line、一般退回 header／原需求／原發放 line／employee／item、五類 correction header／原始 parent／原始 line／identity、ERP batch／artifact／attempt／active／current pointer、PDF family／artifact／attempt／active／current／supersedes pointer，全部以複合 FK、鎖後重驗或等效 deferred constraint 強制屬於同一父集合及身份鏈；不接受只存在但屬於其他需求、核准品號、供應商、原單、PO、batch、artifact 或文件的 id。
30. **期初只發布一次**：system_cutover_state singleton 從 PRE_CUTOVER 轉 LIVE、唯一 opening import batch、opening posting 與 balances 必須同交易完成；LIVE 後不得再發布任何期初批次，PRE_CUTOVER 時不得執行任何非期初庫存過帳。
31. **封存不改正式來源**：READY artifact 與 APPLIED import batch 不因封存而 UPDATE；只有 source key／hash 相符且已回讀驗證的 immutable storage_archive_record 才能授權移除 production bytes，清除／還原只追加 lifecycle event。

跨列與跨表合計不能只靠 CHECK；應放在 deferred constraint trigger 或受控 RPC，並撤銷一般登入角色對受保護表的直接寫權。

## 12. 關鍵交易與鎖定順序

所有庫存相關 RPC 共用下列全域順序，不得自行交換：

1. 先 claim／鎖定本次 operation_command；同 key 已成功或仍由有效 lease 執行時直接回傳，不進入後續鎖序。接手 stale claim 必須先增加 lease_generation。
2. 再由輸入或來源草稿讀出候選 item_id，依 item_id 固定排序鎖定 inventory_item_locks。
3. 再鎖來源單頭；若涉及多張來源，依 table purpose＋uuid 固定排序。鎖後重新讀取 item set／row_version；若出現尚未取得的 item lock，整筆 rollback 並以完整集合重試，禁止在中途追加較小排序鍵的 item lock。
4. 鎖定業務合計根列，例如 original_issue_line、seasonal_procurement_line、purchase_order_line；同類依 id 排序。
5. 鎖定 inventory_balances，固定依 item_id＋warehouse_id 排序。
6. 最後鎖定 inventory_reservations，固定依 item_id＋source_hr_request_id 排序，再鎖其他不影響庫存的子列。

operation command、item-level mutex 與後續列鎖必須保持上述順序；item mutex 讓相同品號的需求送出、發貨、補庫、盤點、更正、退回與入庫先序列化，因此任何函式都不得出現先鎖 reservation 再等待 balance 的反向順序。每個制服品號建立時，須在同一交易預建 inventory_item_locks 及兩倉零餘額列。

### 12.1 送出／修改人資需求

在單一 transaction 內：

1. 依第 12 節共同順序鎖定候選 item mutex、hr_request、兩倉 balance 與相同 item_id 的 ACTIVE reservations；更新既有單時在可申請量合計中排除自己的 reservation。
2. 鎖後重新依 item_id 彙總發放量與增庫量，驗證 hr_issue_lines、hr_request_items 及 row_version 未被其他請求改變。
3. 重新計算 available_to_request；任何品號不足即整筆 rollback。
4. 寫入／更新每品號 reservation，凍結快照，增加 hr_request.row_version，設定 SUBMITTED 並寫 audit_event。

發貨前人資可更正。更正必須走同一函式，重算整張單的 reservation、增加 row_version，並清空或失效化對應倉庫草稿中的 actual_transfer_quantity／舊 snapshot；不能只在 UI 改數量。倉庫 POST 前尚未發生正式員工交付，因此人資可在填寫原因後取消，並於同一交易把預留轉為 RELEASED。

人資必須先完成輸入並成功 SUBMITTED，系統才接受本次發放計畫；SUBMITTED 只代表需求已驗證及預留，員工尚未正式領取。倉庫 POST 是「總倉調出＋人資倉調入＋員工正式發放」的同一業務與資料庫鎖點，POST 成功後才可把制服實際交付員工並形成領用歷程。不得先交付再補登，也不得把 SUBMITTED 預留誤報為已發放量。

### 12.2 倉庫發貨

在單一 transaction 內：

1. 依共同順序鎖定 item mutex、來源 request／shipment、兩倉 balances、ACTIVE reservations；不得先鎖 reservation 再等待 balance。
2. 驗證來源仍為 SUBMITTED、reservation 仍 ACTIVE、shipment.source_request_row_version 等於 request.row_version；逐列重驗 shipment／hr_request／hr_request_item／item 的複合同源關係及來源集合完整，再從目前來源重新凍結 requested_transfer snapshot。
3. 依鎖後 GENERAL on_hand 計算 maximum_transfer_quantity，驗證 actual_transfer_quantity、short_ship_reason、人資倉調入後可完成發放，以及過帳後仍覆蓋其他 ACTIVE reservations。
4. 建立一筆 inventory_posting，依來源數量追加不可變且可核對的總倉調出、人資倉調入、人資倉發放 ledger entries。
5. 以同一批 delta 更新 inventory_balances 與 version。
6. 將 reservation CLOSED、shipment POSTED、request SHIPPED，記錄操作者與時間。
7. commit 後才視為正式發放成功，允許員工交付、正式 PDF 或 ERP 批次。

任何一步失敗整筆 rollback；不得出現「流水已寫但餘額未改」或「餘額已扣但單據未發貨」。

補庫發貨同樣先取得 item mutex、來源 replenishment request 與 GENERAL／HR balances，鎖後重算最大可調量並驗證 row_version，但完全不查詢、建立或關閉 inventory_reservations。並行補庫採先 POST 者先用總倉現有量；後一張若舊輸入超過最新最大值，必須退回倉庫重新確認，不能自動縮量或產生負庫存。

### 12.3 採購入庫、盤點、更正與退回

採購入庫、盤點、五類更正與退回皆使用同一過帳骨架：

- 先鎖 item mutex，再鎖來源單、原始業務根列、balance rows，最後依需要鎖 reservations；所有集合皆固定排序。
- 驗證來源狀態、來源累計、row／balance version、權限、idempotency_key＋request_fingerprint 與過帳後不為負。
- 追加 posting／ledger，更新 balance，將來源設 POSTED，寫 audit。
- 交易完成後來源不可變。

額外鎖定及驗證如下：

- purchase receipt POST、PURCHASE_RECEIPT correction、ordered quantity change、seasonal procurement limit change、PO CANCELLED 與 CLOSED_SHORT 都依共同順序鎖 purchase_order header、seasonal_procurement_line 及相關 purchase_order_line；多筆固定依 id 排序。鎖內重驗 PO 狀態與 POSTED receipt／corrections 是否存在，並重算 current_purchase_limit、allocated quantity、effective delivered／accepted／rejected、remaining_to_accept。PO 首次 ORDERED 或多 PO 分拆同樣依此順序鎖全部關聯 PO lines；終止、receipt、更正與配置調整並行時只能有符合鎖後狀態的一方成功。
- HR_ISSUE correction、RETURN correction 與一般退回都先鎖 correction／return parent，再鎖 original_issue_line；鎖內重驗表頭 original_hr_request、原發放明細、employee 與 item 同源，並重算 effective_issued 與所有已退數量。
- WAREHOUSE_TRANSFER correction 鎖原 shipment／replenishment parent 與 line；PURCHASE_RECEIPT correction 先依上一點取得完整 PO／procurement 鎖群，再鎖原 receipt 及 line；STOCKTAKE／RETURN correction 鎖各自原始 parent 與 line。每類都在鎖後重驗 correction header 與原明細的同父複合關係及衍生 identity。
- stocktake POST 必須比較 balance_version_snapshot；版本不同直接以 STALE_COUNT 失敗並要求重新實盤，不能自動更新 book snapshot 後沿用舊 counted_quantity。
- 任何修復帳實的負向過帳若使 combined_on_hand 小於 ACTIVE reserved，必須在同交易依 item_id、request id 排序鎖定並轉換受影響需求及其全部 reservations 為 INVENTORY_REVIEW_REQUIRED／CONFLICTED，再完成真實庫存過帳。

SYSTEM_ADMIN 角色本身不能代替人資或倉庫過帳；同一 app_account 必須另外具有對應的 HR 或 WAREHOUSE 角色。

### 12.4 ERP 批次產生

檔案物件儲存無法與 PostgreSQL 共用同一 ACID transaction，因此採兩階段完成：

1. **PREPARING snapshot transaction**：先 claim `create_erp_export_batch` operation command，再依固定順序鎖候選來源；重新確認來源 SHIPPED 且尚無 source link，依日期＋機構 snapshot 分組、依品號聚合，在同一交易建立 PREPARING batch、明細、source links、source_snapshot_hash，並把 command 設 SUCCEEDED、result 指向 batch。這一步即占用來源，但不選 format_version、不建立 artifact、不填 storage_object_key；失敗則整筆 rollback。
2. **artifact request transaction**：`request_erp_artifact` 使用自己的 operation command／idempotency key，鎖定 batch，驗證其 frozen snapshot、允許的狀態、active_artifact_id 為 NULL 且不存在 PREPARING artifact，選擇 format_version，建立下一個 PREPARING artifact revision、request_fingerprint 與第一個 PENDING attempt，設定 active_artifact_id，並在同一交易把 revision request command 設 SUCCEEDED、result 指向 artifact。後續 renderer 不持有也不更新這兩個已完成 command claim。
3. **render／upload**：job-specific ERP renderer 取得具 lease_generation 的 attempt fencing lease，只讀上述 frozen batch snapshot 與 artifact format_version，產生 payload、上傳至該 attempt 專屬的私有隨機 temp_object_key，計算 SHA-256。Storage 成功不等於資料庫成品成功，attempt 仍不得自行切換 batch 狀態。
4. **GENERATED finalize transaction**：finalize RPC 依序鎖 batch、artifact、attempt，驗證 active_artifact_id 正是本 artifact、同父複合關係、有效 token＋generation＋未逾期 lease、attempt／artifact 狀態、canonical fingerprint、format_version、temp object metadata／hash 與 source_snapshot_hash。只有 `winning_attempt_id IS NULL` 的第一個合法 attempt 可在同一交易設 attempt SUCCEEDED、artifact READY／current、batch GENERATED、清空 active_artifact_id 並設定 current_artifact_id；競爭輸家回傳 winner，不能覆寫 key／hash，也不修改先前 SUCCEEDED 的 operation command。
5. render 可重試錯誤建立同一 PREPARING artifact 的新 attempt；達重試上限時 terminal-fail RPC 也須鎖 batch 並驗證 active_artifact_id，才可將 artifact 設 FAILED、batch 設 GENERATION_FAILED 並清空 active pointer。重試 GENERATION_FAILED 必須保留同一 batch、source links 與 source_snapshot_hash，透過第 2 步建立 superseding PREPARING artifact revision，不能釋放來源或重做分組。暫存競爭輸家與失敗物件只可由引用檢查後的清理工作回收。
6. 鼎新回報匯入失敗只把 GENERATED／DOWNLOADED 批次轉 IMPORT_FAILED，保留 READY artifact revision 與來源；同一 READY revision 重送成功可受控轉 IMPORT_CONFIRMED，需要格式修正則透過第 2 步建立新 revision 並轉 PREPARING。不得另建重複來源批次。

## 13. Supabase RLS 與寫入邊界

### 13.1 基本原則

- public schema 所有業務表啟用 RLS；先對 PUBLIC 與 anon REVOKE ALL，再只為 authenticated 逐表授予畫面必要的 SELECT／非關鍵草稿權限。不得用 `GRANT ALL ON ALL TABLES/FUNCTIONS` 或 future default privilege 意外開放新物件。
- 建立不對 Data API 直接暴露的 private schema，將 private.current_account_id、private.has_role、private.can_manage_employee 及所有共用 RLS helper 放在其中。對 PUBLIC 與 anon 撤銷 schema／function 權限；authenticated 只取得 private schema 的必要 USAGE，並逐一 GRANT EXECUTE 到明確允許的 helper／RPC。新增函式預設不可執行，須經權限清單審查後個別 grant。
- authenticated 的一般畫面可直接 SELECT 經 RLS 授權資料；關鍵寫入一律走逐一授權的 RPC。operation_commands、inventory_postings、inventory_ledger_entries、inventory_balances、inventory_item_locks、inventory_reservations、audit_events、正式 shipment／receipt／correction、approval snapshot、import_batches／chunks／rows、ERP batch／artifact／attempt/content、document artifact／attempt 對 authenticated 撤銷直接 INSERT／UPDATE／DELETE，不因尚在 PREPARING／PENDING 就開放直寫。
- 對外 view 必須使用 PostgreSQL 15 的 security_invoker = true 並驗證底層 RLS，或放在 private schema 後只以受控 RPC 讀取；不可讓 view owner 權限意外繞過 RLS。
- 每個互動式或背景 SECURITY DEFINER 函式宣告固定 `SET search_path = pg_catalog, private`，所有 public／auth 物件均以 schema-qualified 名稱引用；函式 owner 不可是日常登入或 job role。禁止依呼叫者可控制的 search_path、未限定函式名稱或動態 SQL 找物件。
- 互動式 RPC 必須要求 auth.uid() 非 NULL、`auth.jwt()->>'role' = 'authenticated'`，再以 private.current_account_id() 找到唯一啟用 app_account 並檢查其業務角色；必要的高風險操作另檢查 JWT AAL。actor_account_id 永遠由 current_account_id() 寫入，不能接受前端傳入 actor、角色或代辦帳號。
- 資料庫背景工作不得以 Supabase service_role 當通用 worker 身分。分別建立不供人員登入、只由可信任 server job 使用的 job-specific login role（至少 job_import_worker、job_document_renderer、job_erp_renderer、job_storage_cleanup）；各 role 撤銷 public 業務表直接 DML，只授予 CONNECT、private schema 必要 USAGE，以及逐一核准的薄 claim／heartbeat／complete／fail／finalize RPC EXECUTE。RPC 必須檢查 `current_user` 是預期 job role、job／artifact id、lease token＋generation＋expiry、cursor version、來源狀態、fingerprint 與固定操作，不提供任意表名、SQL 或 actor 輸入。
- service_role 僅可由可信任 server 在固定清單內呼叫 Supabase Auth Admin 或 Storage Admin API，例如驗證新 auth.users 身分、上傳／讀取已授權的私有暫存物件、刪除確認無引用的物件，以及由固定備份程式對 allowlist private buckets 做全量 list／read；不可用它連線資料庫執行 import、artifact、ERP 或一般業務 RPC，也不可放進瀏覽器。備份用途仍是 project-wide 高權限例外，必須置於受保護的 CI environment、禁止輸出，且固定程式不得接受任意 bucket／path 或執行 delete／upsert。Storage API 完成後的資料庫 finalize 必須改由對應 job-specific DB role 執行；service_role 絕不能代替使用者發貨、入庫、盤點、核准或 rebind。
- 儲存桶對匯入原檔、ERP 檔與正式 PDF 分別設私有 policy；signed URL 產生前重新依 app_account 與業務角色授權。

### 13.2 角色資料邊界

| 角色 | 建議可見／可寫範圍 |
|---|---|
| SYSTEM_ADMIN | 維護帳號、角色、窗口範圍與各類主檔；可查全域稽核，但不得直接改餘額，也不能只靠管理員角色執行人資、倉庫、採購或執行長的業務動作。 |
| HR | 維護員工、建立與修改發貨前人資需求、補庫、更正、退回、人資倉盤點；可查看履行作業所需的兩倉可申請量。 |
| WAREHOUSE | 讀取待處理需求及必要發放資訊，填實際調庫量、發貨、總倉盤點、採購入庫；不得改發放量或增庫量。 |
| PROCUREMENT | 讀取換季核准彙總、維護供應商、採購決定、採購單與進度；原則上使用彙總 view，不需讀取全體員工個別需求。 |
| CEO | 讀取換季彙總與核准；不寫庫存、員工主檔或採購量。 |
| DEMAND_COORDINATOR | 只讀可用活動／品號，以及 coordinator_scopes 內員工；只在活動開放期間新增或更新自己授權範圍的 seasonal_demand_lines。 |

同一帳號兼任多角色時取權限聯集，但每筆 created_by、posted_by、approved_by 與 audit actor 都記錄 private.current_account_id() 回傳的同一 app_accounts.id；auth.uid() 只用於本次 JWT 到 app_account 的綁定查找，不直接寫入業務表，也不可使用共用帳號。

### 13.3 避免洩漏與繞過

- 窗口查員工時，RLS 同時檢查 institution_id 與 department_id，不接受前端傳入機構作為唯一判斷。
- 換季需求的 HR 全域畫面與窗口範圍畫面使用不同 view／policy；採購及執行長優先只看品號彙總。
- ERP payload、員工匯入原檔與正式 PDF 可能含員工資料，Storage signed URL 必須短效且在簽發前再次驗證角色。
- 停用帳號即使仍有 user_roles，也必須被 private.has_role 判定為無權限；auth_user_id 為 NULL、JWT 不是 authenticated 或找不到唯一 app_account 時一律 fail closed。

## 14. 建議只讀檢視

以下 view 不另保存可被人修改的重複數字：

- v_item_availability：逐品號顯示兩倉各自 on_hand，以及只在合計層成立的 ACTIVE 預留與 available_to_request；不得虛構逐倉預留。
- v_hr_request_item_totals：每張人資需求單依品號的發放量、增庫量、調庫需求量。
- v_pending_warehouse_shipments：待倉庫處理與差異標示資料。
- v_inventory_history：流水連同來源單號、倉庫、品號、操作者與過帳後餘額。
- v_employee_distribution_history：以 employee_id 串接所有發放、更正與退回，顯示歷史 snapshot。
- v_seasonal_demand_summary：活動、機構、部門與品號彙總；RLS 依角色套用。
- v_purchase_order_receipt_progress：原最後採購量、目前採購上限、目前配置／訂購量、effective delivered_to_date、effective accepted_to_date、effective rejected_to_date、remaining_to_accept 及 CLOSED_SHORT 數量。
- v_erp_export_candidates：只包含 SHIPPED 且尚無正式 source link 的發放明細。

所有庫存數字以 ledger／balance 與有效 reservation 為準；報表 view 不得自行維護另一份「Excel 式庫存」。

## 15. 核心關係摘要

    institution 1 ── * department 1 ── * employee
    auth.users identity 0..1 ── 0..1 app_account * ── * role
    app_account * ── * (institution + department) coordinator scope
    app_account 1 ── * immutable auth binding event
    app_account 1 ── * operation_command ── 0..1 immutable business result

    hr_request 1 ── * hr_issue_line * ── 1 employee
    hr_request 1 ── * hr_request_item * ── 1 uniform_item
    hr_request 1 ── 0..1 warehouse_shipment 1 ── * shipment_line
    submitted request item 1 ── 1 active/closed inventory_reservation

    posted business document 1 ── 1 inventory_posting
    inventory_posting 1 ── * immutable ledger_entry
    (warehouse + item) 1 ── 1 inventory_balance projection
    uniform_item 1 ── 1 inventory_item_lock

    original issue/transfer/receipt/stocktake/return line 1 ── * typed correction_line

    seasonal_campaign * ── * employee
    seasonal_campaign * ── * uniform_item
    campaign 1 ── * unique(employee + item) demand_line
    campaign 1 ── * immutable approval_submission 1 ── * submission_line
    approval_submission 1 ── 1 review ── 0..1 final approval
    campaign 1 ── 0..1 final approval 1 ── * approval_line
    approval_line 1 ── 1 procurement decision
    procurement decision 1 ── * immutable purchase-limit change
    procurement decision 1 ── * purchase_order_line
    purchase_order 1 ── * purchase_receipt

    import_batch 1 ── * durable import_chunk 1 ── * import_row range

    shipped issue_line 1 ── 0..1 official ERP source_link
    ERP batch 1 ── * aggregated ERP line 1 ── * source_link
    ERP batch 1 ── * artifact revision 1 ── * render attempt
    business document 1 ── * PDF artifact revision 1 ── * render attempt

這些關係讓「目前主檔」與「當時單據快照」、「需求／預留」與「實際庫存流水」、「原始正式單」與「後續更正」、「ERP 彙總列」與「個別員工來源」彼此分離又可完整追溯。
