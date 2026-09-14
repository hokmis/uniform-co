# uniform-co 新人開發交接報告

> 專案：`Kevin72333/uniform-co`  
> 交接模式：同一個 GitHub Repository，由新人使用獨立分支開發  
> 新人開發分支：`dev-newbie`  
> 正式分支：`main`  
> 預計獨立開發期間：約 3 個月  
> 文件日期：2026-08-29

---

## 1. 交接目的

本文件用來讓第一次接觸 GitHub、Vercel、Supabase 的新人，可以在不影響正式環境的前提下，接手 `uniform-co` 專案進行約三個月的獨立開發。

這次採用的方式不是 Fork，也不是另外複製一套 Repository，而是：

- 原專案仍由專案擁有者持有。
- 將新人加入 GitHub Repository 協作者。
- 正式程式碼維持在 `main`。
- 新人只在 `dev-newbie` 開發。
- Vercel 的 Production 繼續使用 `main`。
- 新人的 `dev-newbie` 更新由 Vercel 產生 Preview Deployment。
- Supabase 可以共用同一個專案，但新人不取得 Production 高權限 Secret。
- 三個月後，由新人建立 Pull Request，專案擁有者審核後再合併回 `main`。

此架構的主要目的，是讓新人可以正常開發、測試與推送，同時降低誤改正式網站、正式分支或高權限後端設定的風險。

---

## 2. 整體架構

```text
GitHub: Kevin72333/uniform-co
│
├─ main
│   └─ 正式版本
│       └─ Vercel Production
│           └─ https://uniform-co.vercel.app
│
└─ dev-newbie
    └─ 新人三個月開發分支
        └─ Vercel Preview Deployment

Supabase
└─ 可由 Production / Preview 共用同一個 Supabase Project
    ├─ Public URL：可提供給前端
    ├─ Anon / Publishable Key：可提供給前端
    └─ Service Role / 高權限 Secret：不得提供給新人或放入前端
```

---

## 3. 新人需要先準備的帳號與軟體

新人一開始沒有任何帳號時，先完成以下項目。

### 3.1 必要帳號

1. GitHub 帳號
2. Vercel 帳號

Supabase 是否需要獨立帳號，依專案擁有者是否希望讓新人登入 Supabase Dashboard 而定。

若新人只需要開發前端與透過既有 API / Supabase Client 操作，原則上不必先授予 Supabase Dashboard 管理權限。

### 3.2 本機軟體

建議安裝：

- Git
- Node.js
- npm
- VS Code 或其他程式編輯器
- Chrome / Edge

安裝完成後，可在終端機確認：

```bash
git --version
node --version
npm --version
```

---

## 4. 專案擁有者一次性設定

以下內容原則上只需要在交接開始前設定一次。

### 4.1 將新人加入 GitHub Repository

Repository：

```text
https://github.com/Kevin72333/uniform-co
```

操作方向：

1. 進入 GitHub Repository。
2. 開啟 `Settings`。
3. 進入 Collaborators / Access 管理區。
4. 邀請新人的 GitHub 帳號。
5. 新人接受邀請。

新人不需要另外 Fork Repository。

---

### 4.2 建立新人開發分支

由專案擁有者從最新 `main` 建立：

```bash
git switch main
git pull origin main
git switch -c dev-newbie
git push -u origin dev-newbie
```

完成後 GitHub 應同時存在：

```text
main
dev-newbie
```

---

### 4.3 保護 main 分支

建議在 GitHub 對 `main` 設定 Branch Protection / Ruleset。

至少應做到：

- 不讓新人直接把一般開發內容推進 `main`。
- 正式修改透過 Pull Request 合併。
- 合併前由專案擁有者檢查。
- 若專案已有 CI，要求必要檢查通過後再合併。

新人日常開發只使用：

```text
dev-newbie
```

---

## 5. Vercel 設定

### 5.1 Production 維持 main

Vercel Production Branch 應維持：

```text
main
```

正式網址仍由 `main` 部署，例如：

```text
https://uniform-co.vercel.app
```

因此新人推送 `dev-newbie` 時，不應直接取代正式網站。

---

### 5.2 dev-newbie 使用 Preview Deployment

新人執行：

```bash
git push origin dev-newbie
```

Vercel 會依 Git 整合建立 Preview Deployment。

新人應使用 Preview URL 檢查自己的修改，不要把正式 Production URL 當成自己的開發測試網址。

---

### 5.3 Vercel Environment Variables

若 Preview 與 Production 要共用同一個 Supabase Project，可以讓 Preview 使用同一組「公開用途」的 Supabase Client 設定。

常見欄位例如：

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

實際變數名稱以專案目前程式碼與 Vercel 設定為準。

重要原則：

- `NEXT_PUBLIC_*` 內容會進入瀏覽器端，必須視為公開資料。
- Supabase Service Role Key 不得放在 `NEXT_PUBLIC_*`。
- DB Password、Service Role、部署 Secret、管理員 Token 等高權限資料不得交給新人任意使用。
- Production-only Secret 不要因為新人開發方便就直接複製到 Preview。

---

## 6. Supabase 共用方式

這次可以採用「不同 Vercel Deployment，共用同一個 Supabase Project」。

### 6.1 可以共用的內容

在 Supabase RLS 與權限設計正確的前提下，可共用：

- Supabase Project URL
- Anon / Publishable Key
- Auth
- PostgreSQL 資料
- Storage
- 既有 RPC / API

### 6.2 不應交給新人的內容

除非有明確管理需求，否則不要提供：

- Service Role Key
- Database Password
- Supabase Owner 級權限
- 正式備份金鑰
- Production Secret
- CI/CD 高權限 Token
- Vercel Owner 帳號密碼

### 6.3 共用正式資料庫的風險

Preview 若直接連正式 Supabase，代表新人在 Preview 做的「新增、修改、刪除」操作可能真的影響同一份資料。

因此必須遵守：

- 使用專門的測試帳號。
- 測試時避免任意刪除正式資料。
- 不任意修改 RLS。
- 不任意執行破壞性 migration。
- 不把 Service Role 搬到前端。
- 遇到 migration、權限、Storage Policy、Auth 設定等高風險修改時，先交由專案擁有者確認。

若後續開發開始大量修改資料表或需要大量測試資料，應再考慮另建 Staging Supabase，而不是持續直接測正式資料。

---

## 7. 新人第一次開始工作的完整流程

### 7.1 註冊 GitHub

新人先建立 GitHub 帳號，並把 GitHub 使用者名稱提供給專案擁有者。

接受 Repository 邀請後，即可 Clone。

### 7.2 Clone 專案

```bash
git clone https://github.com/Kevin72333/uniform-co.git
cd uniform-co
```

### 7.3 切換到新人分支

```bash
git switch dev-newbie
git pull origin dev-newbie
```

確認目前分支：

```bash
git branch --show-current
```

應顯示：

```text
dev-newbie
```

如果顯示 `main`，先不要開始修改。

### 7.4 安裝套件

```bash
npm install
```

### 7.5 建立本機環境變數

依專案目前的 `.env.example`、README 或擁有者提供的欄位建立：

```text
.env.local
```

例如：

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

不要把 `.env.local`、密碼、Token、Service Role Key commit 到 GitHub。

### 7.6 啟動本機開發

```bash
npm run dev
```

再依終端機顯示的 Local URL 開啟網站。

---

## 8. 新人每天的標準工作流程

每天開始工作：

```bash
git switch dev-newbie
git pull origin dev-newbie
git status
```

修改程式後，先在本機測試。

準備保存進度：

```bash
git status
git add .
git commit -m "feat: 說明這次完成的功能"
git push origin dev-newbie
```

推送完成後：

1. 到 GitHub 確認 commit 已上傳。
2. 到 Vercel 確認 Preview Deployment 成功。
3. 打開 Preview URL 測試。
4. 若失敗，先修正 `dev-newbie`，不要直接改 `main`。

---

## 9. 建議的 Git Commit 寫法

功能新增：

```bash
git commit -m "feat: 新增制服申請功能"
```

錯誤修正：

```bash
git commit -m "fix: 修正庫存數量顯示"
```

UI 調整：

```bash
git commit -m "style: 調整需求列表版面"
```

文件修改：

```bash
git commit -m "docs: 更新操作說明"
```

避免使用無法理解的訊息，例如：

```text
update
test
123
改一下
```

---

## 10. 新人可做與不可做的事項

### 10.1 可以做

- 修改 `dev-newbie` 內的程式。
- Commit 到自己的 `dev-newbie`。
- Push `dev-newbie`。
- 使用 Vercel Preview 測試。
- 使用專案提供的測試帳號登入。
- 執行一般開發測試。
- 建立 Pull Request 讓擁有者審查。

### 10.2 未經確認不要做

- 直接修改或 Push `main`。
- 將 `dev-newbie` 自行 merge 到 `main`。
- 修改 Vercel Production Branch。
- 刪除 Vercel Project。
- 刪除 Supabase Project。
- 修改正式 Auth / RLS / Storage Policy。
- 執行可能刪資料的 SQL / migration。
- Reset 正式資料庫。
- 將 Service Role Key 放到前端。
- 將 `.env.local` 或秘密金鑰 push 到 GitHub。
- 修改 GitHub Actions 高權限 Secret。
- Force Push 正式分支。

---

## 11. 三個月開發期間的管理方式

建議新人三個月期間都使用同一條 `dev-newbie` 分支。

專案擁有者可以定期：

- 查看 GitHub commit。
- 查看 Vercel Preview。
- 檢查是否誤碰 Production。
- 每隔一段時間讓新人同步最新 `main`。
- 針對 migration、RLS、Auth、Storage 等高風險項目先審查。

若 `main` 在三個月期間仍有其他正式修改，新人需要定期同步，以降低最後一次合併的衝突量。

常見方式為：

```bash
git switch dev-newbie
git fetch origin
git merge origin/main
```

若發生 conflict，不確定如何處理時，先不要硬改或使用破壞性 Git 指令，交由專案擁有者協助確認。

---

## 12. 三個月後交回專案

新人完成最後一輪修改後，先更新分支：

```bash
git switch dev-newbie
git pull origin dev-newbie
```

執行專案驗證：

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

確認沒有未提交修改：

```bash
git status
```

最後推送：

```bash
git push origin dev-newbie
```

然後在 GitHub 建立 Pull Request：

```text
base: main
compare: dev-newbie
```

專案擁有者檢查：

- 功能是否符合需求。
- CI / test 是否通過。
- Vercel Preview 是否正常。
- 是否有誤提交 Secret。
- 是否包含高風險 migration。
- RLS / Auth / Storage 是否符合原安全契約。
- 是否有不應刪除的正式資料或功能。
- README / AGENTS.md 是否需要同步更新。

確認後才 merge 到 `main`。

`main` 更新後，再由 Vercel Production 部署正式版本。

---

## 13. 專案擁有者交接前 Checklist

- [ ] 新人已建立 GitHub 帳號。
- [ ] 新人已被加入 `Kevin72333/uniform-co`。
- [ ] `dev-newbie` 已建立。
- [ ] `main` 已設定適當保護規則。
- [ ] Vercel Production Branch 仍為 `main`。
- [ ] `dev-newbie` Push 可以正常建立 Vercel Preview。
- [ ] Preview 所需公開環境變數已設定。
- [ ] 未將 Production 高權限 Secret 提供給新人。
- [ ] 已建立新人可用的系統測試帳號。
- [ ] 新人知道正式網址與 Preview URL 的差別。
- [ ] 新人知道不得直接 Push / Merge `main`。
- [ ] 新人知道 `.env.local` 不可提交。
- [ ] 新人知道 migration / RLS / Auth / Storage 修改須先確認。
- [ ] 已告知三個月後用 Pull Request 交回。

---

## 14. 新人第一天 Checklist

- [ ] GitHub 帳號已建立。
- [ ] 已接受 Repository 邀請。
- [ ] Git 已安裝。
- [ ] Node.js / npm 已安裝。
- [ ] 已 Clone Repository。
- [ ] 已切換 `dev-newbie`。
- [ ] 已執行 `npm install`。
- [ ] 已建立 `.env.local`。
- [ ] `npm run dev` 可正常啟動。
- [ ] 可使用測試帳號登入。
- [ ] 已完成第一次測試 commit。
- [ ] 已成功 push 到 `dev-newbie`。
- [ ] 已看過一次 Vercel Preview。

---

## 15. 新人每日快速指令表

### 開始工作

```bash
cd uniform-co
git switch dev-newbie
git pull origin dev-newbie
git status
```

### 本機啟動

```bash
npm run dev
```

### 保存工作

```bash
git status
git add .
git commit -m "feat: 說明這次完成的功能"
git push origin dev-newbie
```

### 交付前檢查

```bash
npm test
npm run lint
npm run typecheck
npm run build
git status
```

---

## 16. 問題排除原則

### Push 失敗

先確認目前分支：

```bash
git branch --show-current
```

應為：

```text
dev-newbie
```

再執行：

```bash
git pull origin dev-newbie
```

處理完衝突後再 Push。

### Vercel Preview 失敗

依序檢查：

1. Vercel Build Log。
2. 環境變數是否存在。
3. `npm run build` 在本機是否成功。
4. 是否引用只有本機才有的檔案或 Secret。

### Supabase 無法登入或讀資料

依序確認：

1. Supabase URL 是否正確。
2. Public / Anon Key 是否正確。
3. 使用者帳號是否有效。
4. RLS 是否允許該角色執行操作。
5. 不要為了讓功能「先能跑」就關閉 RLS 或改用 Service Role 放到前端。

---

## 17. 最終交接原則

這次交接最重要的規則可以濃縮成五句話：

1. 新人只開發 `dev-newbie`。
2. 正式 `main` 由專案擁有者控制。
3. 新人測試看 Vercel Preview，不直接把開發中的內容當 Production。
4. Supabase 可以共用，但高權限 Secret 不共用，正式資料操作要保守。
5. 三個月後以 Pull Request 交回，由擁有者審核後才合併 `main`。

這樣可以兼顧「新人能獨立工作」與「三個月後專案能安全收回」。

