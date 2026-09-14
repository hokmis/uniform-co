# 外部驗收資料／維運責任空白清單

這份清單用來整理正式上線仍需由公司、鼎新窗口或維運負責人提供的資料。Repository 只保存這份空白範本；填妥後請複製到 `docs/deployment/onboarding/private/` 或公司受保護文件系統，不要把真實聯絡方式、production project ref、secret、金鑰、備份目的地 credential 或正式業務檔案提交到 Git。

## 1. 鼎新 ERP 成功匯入樣本與欄位規格

| 項目 | 待提供／確認內容 |
| --- | --- |
| 鼎新產品／模組與版本 |  |
| 匯入作業名稱 |  |
| 成功匯入的原始樣本檔 |  |
| 樣本檔格式與編碼 |  |
| 欄位順序、名稱、型別、長度 |  |
| 必填／可空白規則 |  |
| 日期、數字、小數與負數格式 |  |
| 單號／機構／品號等代碼對照 |  |
| 重複匯入／沖銷／錯誤回報規則 |  |
| 鼎新端驗收負責人 |  |
| staging 成功匯入證據位置 |  |

正式 mapping 只有在「系統輸出檔 → 鼎新 staging／測試環境成功匯入 → 筆數與金額／數量核對一致」後才算驗收，不能只靠欄位名稱推測格式。

## 2. 公司抬頭、Logo、正式列印與簽名欄位

| 項目 | 待提供／確認內容 |
| --- | --- |
| 公司正式抬頭 |  |
| 統編／地址／電話等需印欄位 |  |
| 正式 Logo 原始檔 |  |
| Logo 使用限制／留白規範 |  |
| 指定中文字型／英文字型 |  |
| A4 邊界、頁首頁尾與頁碼規則 |  |
| 各單據必要欄位與排序 |  |
| 簽名／核章角色名稱與欄位 |  |
| 是否需要日期／騎縫／浮水印 |  |
| 公司版面核准人 |  |
| 最終 PDF 樣張核准日期 |  |

Logo、字型授權檔與正式 PDF 樣張若包含公司內部資訊，請以受保護方式交付，不要因方便驗收就直接加入公開或可廣泛存取的 repository。

## 3. 異地備份、金鑰保管與 RPO／RTO

| 項目 | 待提供／確認內容 |
| --- | --- |
| 核准的異地備份服務／區域 |  |
| 備份目的地 owner |  |
| 第一位加密金鑰保管人 |  |
| 第二位加密金鑰保管人 |  |
| 維運通知信箱／群組 |  |
| 暫定 RPO |  |
| 暫定 RTO |  |
| RPO／RTO 業務接受人 |  |
| 還原演練核准人 |  |
| 最近一次從零還原演練證據位置 |  |

這份文件只記「責任與決策」，不記 access token、password、private key、service role key、加密金鑰內容或可直接登入的連線字串。正式排程備份只能在異地目的地、加密程序、雙人金鑰保管與還原演練都完成後再啟用。

## 4. 三年容量預估與正式保存年限

| 類別 | 現況／第一年估計 | 三年估計 | 公司正式保存年限 | 估算／核准人 |
| --- | --- | --- | --- | --- |
| 員工主檔筆數 |  |  |  |  |
| 制服品號／供應商主檔筆數 |  |  |  |  |
| 每月需求／發貨／退回交易筆數 |  |  |  |  |
| 每年換季／採購／入庫交易筆數 |  |  |  |  |
| 每月 durable import 次數／最大檔案 |  |  |  |  |
| 每月 PDF artifact 數量／平均大小 |  |  |  |  |
| 每月 ERP artifact 數量／平均大小 |  |  |  |  |
| audit／archive 成長量 |  |  |  |  |
| database 預估容量 |  |  |  |  |
| private Storage 預估容量 |  |  |  |  |
| 備份 generation 預估容量 |  |  |  |  |

容量 assumptions 可由 `templates/capacity-assumptions.example.json` 複製到受保護的 `private/capacity-assumptions.json` 後填寫，再執行 `npm run capacity:plan -- --input docs/deployment/onboarding/private/capacity-assumptions.json --json`。估算完成後，應回到 `docs/architecture/data-retention.md` 核對 retention、封存、Storage 與備份策略；若實際容量超出目前方案假設，必須先調整方案或架構再進 production acceptance。

正式容量簽核另外記錄以下 staging evidence；不可用 model-only estimate 代填：

| 實測證據 | 結果／證據位置 |
| --- | --- |
| 三年 synthetic `pg_database_size`、table／index／TOAST bytes |  |
| 三年 synthetic private Storage bucket bytes |  |
| 主要查詢／匯入／PDF／ERP／並行庫存尖峰 |  |
| 完整備份＋從零還原演練 |  |
| 30 天備份＋演練 egress quota ratio（必須 < 60%） |  |
| 30 天 GitHub Actions minutes quota ratio（必須 < 60%） |  |
| `capacityValidation.status=VALIDATED` 輸出位置 |  |

## 5. GitHub／Vercel／Supabase owner 與移交

| 項目 | Primary owner | Backup owner | 驗證／移交狀態 |
| --- | --- | --- | --- |
| GitHub repository owner |  |  |  |
| GitHub Actions／Environment 維護 |  |  |  |
| Vercel project owner |  |  |  |
| Supabase staging project owner |  |  |  |
| Supabase production project owner |  |  |  |
| DNS／公司網域 owner（若適用） |  |  |  |
| 備份／還原維運 owner |  |  |  |
| renderer／import worker 維運 owner |  |  |  |

正式移交至少要驗證 primary 與 backup owner 都能在自己的授權範圍內登入、查看部署／失敗通知並依 runbook 執行必要操作。不要在本清單保存 recovery code、2FA seed、password 或其他登入憑證。

## 6. 最終驗收簽核

| Gate | 結果／證據位置 | 驗收人 | 日期 |
| --- | --- | --- | --- |
| 鼎新成功匯入 |  |  |  |
| 正式 PDF 樣式 |  |  |  |
| 第一批帳號／角色／scope |  |  |  |
| staging migration／RLS／Storage／worker／renderer smoke |  |  |  |
| 從零備份還原演練 |  |  |  |
| RPO／RTO 接受 |  |  |  |
| 三年容量／保存政策 |  |  |  |
| owner／backup owner 移交 |  |  |  |
| production cutover 核准 |  |  |  |

上述簽核完成後，將每一項對應到受保護的 `private/release-evidence.json`。可從 `templates/release-evidence.example.json` 複製，但正式檔必須使用 `evidenceKind=RELEASE_EVIDENCE`，每個 passed gate 都要使用該 gate 核准的 evidence source 並填入非 secret 的 evidence path／ID。執行 `npm run deployment:release-gate -- --input docs/deployment/onboarding/private/release-evidence.json --json`；只有輸出 `status=READY` 才代表 release evidence 集合完整。

未完成的 Gate 保持未完成，不以「程式已具備功能」取代真實 staging、第三方系統、業務資料或維運責任人的正式驗收。Release gate harness 完成也不等於 production cutover 已驗收；版本化 template 永遠是 `NOT_READY`。
