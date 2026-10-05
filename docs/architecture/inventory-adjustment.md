# 庫存調整單

調整單使用差額，不是盤點的實盤量。每張單限定一個已明確選取的啟用倉庫；HR 管理人資倉，WAREHOUSE 管理總倉，SYSTEM_ADMIN 包含兩者。非零整數差額與原因必填；品號不得重複，每張最多 1000 筆。

CSV 欄位為 `item_code,quantity_delta,reason`，也接受「品號,調整數量,原因」。先預覽再確認；錯誤列阻止整張過帳。純數字正負號合法，公式與非數字運算拒絕。CSV 不走 durable worker。

`complete_inventory_adjustment` 在單一交易依品號排序鎖定庫存，驗證最新餘額及兩倉合計已保留量，建立不可修改的單據、明細、ADJUSTMENT posting、MANUAL_ADJUSTMENT ledger 與稽核。減量不得造成負庫存或侵占 ACTIVE reservations；需要處理實際盤差／請領衝突時使用既有盤點流程。資料庫自行計算完整 payload 指紋，重試同鍵不重複扣庫。

前台送出前保存完整 payload 與重試鍵；結果未知時鎖住原內容並只重試同次操作。身份切換清除可見草稿，恢復資訊以 Auth user 與帳號隔離。完成後通知庫存刷新，異動紀錄保留單號。

部署僅執行 `supabase/migrations/0140_inventory_adjustments.sql`，不使用整批 db push。驗收使用 rollback-only SQL，覆蓋正負差額、流水、冪等、異常回滾與權限；不得提交測試庫存。
