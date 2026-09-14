"use client";

import type { WorkspaceId } from "./workspaces/workspace-config";

type Props = {
  onNavigate: (workspaceId: WorkspaceId, anchor: string) => void;
  onOpenOpeningImport?: () => void;
};

export default function InventoryOperationHub({ onNavigate, onOpenOpeningImport }: Props) {
  return (
    <section className="panel" aria-label="庫存管理操作入口">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">INVENTORY OPERATIONS</p>
          <h2>庫存異動操作入口</h2>
        </div>
        <span className="status-pill">POST / AUDIT</span>
      </div>
      <p className="auth-message">庫存管理不直接編輯餘額。每個新增、修改、取消或更正都必須留在對應的草稿／POST 流程，避免把帳面數字與不可變流水拆開。</p>
      <div className="summary-list">
        <div className="summary-row"><span><strong>期初庫存</strong><small>只在 PRE_CUTOVER 使用；透過耐久匯入預覽後一次發布。</small></span><button className="secondary-button" type="button" onClick={() => onOpenOpeningImport?.()}>前往期初匯入</button></div>
        <div className="summary-row"><span><strong>發貨與交付</strong><small>建立理貨草稿、修改實際調庫量，再 POST 完成發放與扣帳。</small></span><button className="secondary-button" type="button" onClick={() => onNavigate("warehouse", "warehouse-control-title")}>建立發貨草稿</button></div>
        <div className="summary-row"><span><strong>盤點與倉庫更正</strong><small>以帳面版本 fencing；已過帳資料只能新增更正，不刪除原流水。</small></span><button className="secondary-button" type="button" onClick={() => onNavigate("warehouse", "warehouse-stocktake-title")}>前往盤點／更正</button></div>
        <div className="summary-row"><span><strong>採購入庫</strong><small>合格量 POST 後才增加總倉；未完成草稿可修改，已 POST 用更正。</small></span><button className="secondary-button" type="button" onClick={() => onNavigate("procurement", "procurement-receipt-title")}>前往採購入庫</button></div>
      </div>
    </section>
  );
}
