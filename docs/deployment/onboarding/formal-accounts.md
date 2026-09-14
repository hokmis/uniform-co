# 第一批正式帳號／角色／需求窗口清單

這是公司核准與建立帳號用的空白清單，不是匯入檔。請勿填入或保存密碼、service role、Auth Admin key 或其他 secret，也不要把填妥後的真實清單提交到 Git。

## 帳號與角色

`login_name` 必須是 2–50 個小寫英文字母或數字。`role_codes` 只能從下列六個角色選擇，可多選：

`SYSTEM_ADMIN`、`HR`、`WAREHOUSE`、`PROCUREMENT`、`CEO`、`DEMAND_COORDINATOR`

| login_name | display_name | contact email（選填） | role_codes |
| --- | --- | --- | --- |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

## DEMAND_COORDINATOR 機構／部門範圍

只為具有 `DEMAND_COORDINATOR` 角色的帳號填寫。機構與部門必須已存在於正式主檔；同一帳號需要多個範圍時，每個「機構＋部門」各填一列。

| login_name | institutionCode | departmentCode |
| --- | --- | --- |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |

## 建立順序

1. 公司先核准第一批帳號、角色與需求窗口範圍。
2. 第一位 `SYSTEM_ADMIN` 由 DB owner 在受保護環境 seed `app_accounts`／`user_roles`。
3. 使用第一位 `SYSTEM_ADMIN` 登入後，其餘帳號透過「帳號管理」workspace 建立。
4. 角色透過受保護帳號管理流程設定；`DEMAND_COORDINATOR` 再設定機構／部門 scope。
5. 在 staging 逐一驗證登入、允許／拒絕權限與最後一位 `SYSTEM_ADMIN` 防線後，才套用 production 名單。
