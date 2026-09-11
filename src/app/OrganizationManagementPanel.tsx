"use client";

import { useState } from "react";
import type { OrganizationEntityType } from "@/src/domain/organization-management";
import MasterDataPanel from "./MasterDataPanel";
import ModuleWorkbench from "./ModuleWorkbench";
import OrganizationCatalogPanel, { type OrganizationEditRequest } from "./OrganizationCatalogPanel";
import OrganizationMasterEditorPanel from "./OrganizationMasterEditorPanel";

type OrganizationScreen = "CATALOG" | "EDITOR" | "IMPORT_EXPORT";
type OrganizationTab = Exclude<OrganizationScreen, "EDITOR">;

export default function OrganizationManagementPanel() {
  const [screen, setScreen] = useState<OrganizationScreen>("CATALOG");
  const [editorEntityType, setEditorEntityType] = useState<OrganizationEntityType>("INSTITUTIONS");
  const [editRequest, setEditRequest] = useState<OrganizationEditRequest | null>(null);
  const [editorIntent, setEditorIntent] = useState<"EDIT" | "DEACTIVATE">("EDIT");
  const [catalogRefreshToken, setCatalogRefreshToken] = useState(0);
  const [notice, setNotice] = useState("");

  function openCatalog() {
    setScreen("CATALOG");
    setEditRequest(null);
    setEditorIntent("EDIT");
  }

  function createEntity(entityType: OrganizationEntityType) {
    setEditorEntityType(entityType);
    setEditRequest(null);
    setEditorIntent("EDIT");
    setNotice("");
    setScreen("EDITOR");
  }

  function editEntity(request: OrganizationEditRequest, intent: "EDIT" | "DEACTIVATE" = "EDIT") {
    setEditorEntityType(request.entityType);
    setEditRequest(request);
    setEditorIntent(intent);
    setNotice("");
    setScreen("EDITOR");
  }

  function finishEditor(stableKey: string, isActive: boolean) {
    setCatalogRefreshToken((value) => value + 1);
    setNotice(isActive ? `組織主檔 ${stableKey} 已保存並重新載入清單。` : `組織主檔 ${stableKey} 已停用；既有員工、單據與歷史仍保留。`);
    openCatalog();
  }

  function selectTab(tab: OrganizationTab) {
    setScreen(tab);
    setEditRequest(null);
    setEditorIntent("EDIT");
    setNotice("");
  }

  const activeTab: OrganizationTab = screen === "EDITOR" ? "CATALOG" : screen;
  const catalogContent = screen === "EDITOR"
    ? <OrganizationMasterEditorPanel
      key={`${editorEntityType}:${editRequest?.id ?? "new"}:${editorIntent}`}
      entityType={editorEntityType}
      editRequest={editRequest}
      intent={editorIntent}
      onCancel={openCatalog}
      onSaved={finishEditor}
    />
    : <OrganizationCatalogPanel
      refreshToken={catalogRefreshToken}
      onEdit={(request) => editEntity(request)}
      onDeactivate={(request) => editEntity(request, "DEACTIVATE")}
    />;

  return (
    <ModuleWorkbench
      idPrefix="organization-management"
      eyebrow="ORGANIZATION MANAGEMENT"
      title={screen === "EDITOR" ? editRequest ? "編輯組織主檔" : "新增組織主檔" : "組織主檔管理"}
      description="比照 SPSV29 的管理操作，將清單與新增／修改表單分離；資料保存仍沿用本系統受保護的主檔 RPC、RLS、冪等與稽核契約。"
      activeTabId={activeTab}
      onTabChange={(tabId) => selectTab(tabId as OrganizationTab)}
      actions={screen === "EDITOR"
        ? <button className="secondary-button" type="button" onClick={openCatalog}>返回組織清單</button>
        : <>
          <button className="primary-button" type="button" onClick={() => createEntity("INSTITUTIONS")}>＋ 新增機構</button>
          <button className="secondary-button" type="button" onClick={() => createEntity("DEPARTMENTS")}>＋ 新增部門</button>
          <button className="secondary-button" type="button" onClick={() => selectTab("IMPORT_EXPORT")}>匯入／匯出</button>
        </>}
      feedback={notice ? <p className="success-note organization-management-notice" role="status">{notice}</p> : null}
      tabs={[
        { id: "CATALOG", label: "組織清單", content: catalogContent },
        {
          id: "IMPORT_EXPORT",
          label: "匯入／匯出",
          content: <div className="workspace-panel-grid workspace-panel-grid--balanced organization-import-grid">
            <MasterDataPanel allowedEntityTypes={["INSTITUTIONS", "DEPARTMENTS"]} />
            <section className="panel organization-boundary-card" aria-label="組織主檔管理說明">
              <div className="panel-heading"><div><p className="eyebrow">DATA CONTRACT</p><h2>組織資料規則</h2></div><span className="status-pill">MASTER DATA</span></div>
              <div className="summary-list">
                <div className="summary-row"><span><strong>穩定代碼</strong><small>修改模式不變更機構／部門代碼，避免誤建立另一筆主檔或破壞外部對照。</small></span></div>
                <div className="summary-row"><span><strong>部門隸屬</strong><small>部門固定隸屬一個機構；需要移轉時建立新部門並停用舊關係。</small></span></div>
                <div className="summary-row"><span><strong>大量匯入</strong><small>此處適合小批次 CSV／JSON；大型檔案請使用「耐久匯入」保留批次、差異與恢復狀態。</small></span></div>
                <div className="summary-row"><span><strong>停用代替刪除</strong><small>既有員工、需求、單據與稽核紀錄完整保留，停用資料不再供新流程選用。</small></span></div>
              </div>
            </section>
          </div>,
        },
      ]}
    />
  );
}
