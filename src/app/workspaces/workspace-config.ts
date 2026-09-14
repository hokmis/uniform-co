export const workspaceDefinitions = [
  {
    id: "overview",
    label: "總覽",
    icon: "grid",
    eyebrow: "OPERATIONS OVERVIEW",
    description: "集中處理主檔、商品管理與匯入準備，讓正式作業使用同一份資料基礎。",
    modules: [
      { anchor: "overview-dashboard-title", label: "營運總覽", keywords: "總覽 KPI 工作佇列 快速入口 進度 活動" },
      { anchor: "overview-access-title", label: "組織主檔", keywords: "主檔 機構 部門 資料基礎" },
      { anchor: "overview-products-title", label: "商品管理", keywords: "商品 制服品號 品名 尺寸 季別 供應商 MOQ 供應商品號 新增 修改 停用 刪除 匯入 匯出" },
      { anchor: "overview-import-title", label: "耐久匯入", keywords: "匯入 批次 差異 確認 worker" },
    ],
  },
  {
    id: "accounts",
    label: "帳號管理",
    icon: "account",
    eyebrow: "ACCOUNT ADMINISTRATION",
    description: "建立帳號、管理登入身份、角色與需求窗口範圍；所有異動都保留理由與稽核紀錄。",
    modules: [
      { anchor: "accounts-admin-title", label: "帳號與權限管理", keywords: "帳號 登入 密碼 角色 權限 需求窗口 範圍 稽核" },
    ],
  },
  {
    id: "hr",
    label: "人資需求",
    icon: "people",
    eyebrow: "HR OPERATIONS",
    description: "從員工資料、制服需求、預留到退回與人資更正，串起完整發放流程。",
    modules: [
      { anchor: "hr-request-title", label: "需求與發放準備", keywords: "員工 制服需求 發放 預留 增庫 退回" },
      { anchor: "hr-correction-title", label: "人資發放與退回更正", keywords: "更正 發放 退回 差額 來源單據" },
      { anchor: "hr-employee-title", label: "員工主檔管理", keywords: "員工 工號 機構 部門 職稱 到職 離職 新增 修改 停用 刪除 匯入 匯出" },
    ],
  },
  {
    id: "warehouse",
    label: "倉庫作業",
    icon: "warehouse",
    eyebrow: "WAREHOUSE OPERATIONS",
    description: "以模組化方式處理兩倉庫存、發貨、盤點與更正；倉庫名稱固定為人資倉與總倉。",
    modules: [
      { anchor: "warehouse-inventory-title", label: "庫存管理", keywords: "庫存 人資倉 總倉 預留 可申請量 品號 庫存清單 期初 入庫 發貨 盤點 更正 匯出" },
      { anchor: "warehouse-control-title", label: "發貨作業", keywords: "發貨 調庫 人資倉 總倉 POST 實際調庫量" },
      { anchor: "warehouse-stocktake-title", label: "盤點與倉庫更正", keywords: "盤點 fencing 調庫 更正 理由" },
    ],
  },
  {
    id: "procurement",
    label: "採購與入庫",
    icon: "cart",
    eyebrow: "PROCUREMENT & RECEIPT",
    description: "管理換季採購決策、採購差異、入庫驗收與採購入庫更正。",
    modules: [
      { anchor: "procurement-decision-title", label: "採購決策與差異", keywords: "採購 CEO MOQ 供應商 差異 原因碼" },
      { anchor: "procurement-receipt-title", label: "採購入庫與更正", keywords: "到貨 合格 拒收 入庫 驗收 更正" },
    ],
  },
  {
    id: "seasonal",
    label: "換季活動",
    icon: "refresh",
    eyebrow: "SEASONAL CAMPAIGN",
    description: "建立換季活動、凍結適用範圍、收集需求並送交 CEO 審核。",
    modules: [
      { anchor: "seasonal-campaign-title", label: "活動與需求窗口", keywords: "換季 活動 凍結 員工 制服 需求窗口" },
      { anchor: "seasonal-approval-title", label: "換季送核", keywords: "CEO 審核 核准 退回 版本 理由" },
    ],
  },
  {
    id: "reports",
    label: "報表",
    icon: "chart",
    eyebrow: "REPORTING & ARTIFACTS",
    description: "以唯讀報表檢視庫存與流程，並依授權請求正式 PDF 或 ERP artifact。",
    modules: [
      { anchor: "reports-view-title", label: "營運報表", keywords: "唯讀 報表 庫存 採購 流程 view" },
      { anchor: "reports-artifact-title", label: "正式文件與 ERP", keywords: "PDF artifact ERP 批次 匯出 snapshot" },
    ],
  },
] as const;

export type WorkspaceId = (typeof workspaceDefinitions)[number]["id"];
export type WorkspaceDefinition = (typeof workspaceDefinitions)[number];
export type WorkspaceModule = WorkspaceDefinition["modules"][number];

export type WorkspaceSearchResult = {
  workspaceId: WorkspaceId;
  workspaceLabel: string;
  anchor: string;
  label: string;
  keywords: string;
};

const workspaceSearchIndex: WorkspaceSearchResult[] = workspaceDefinitions.flatMap((workspace) =>
  workspace.modules.map((module) => ({
    workspaceId: workspace.id,
    workspaceLabel: workspace.label,
    anchor: module.anchor,
    label: module.label,
    keywords: module.keywords,
  })),
);

export function searchWorkspaceModules(query: string): WorkspaceSearchResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];

  return workspaceSearchIndex
    .filter((module) => `${module.workspaceLabel} ${module.label} ${module.keywords}`.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, 8);
}

export function isWorkspaceId(value: string): value is WorkspaceId {
  return workspaceDefinitions.some((workspace) => workspace.id === value);
}
