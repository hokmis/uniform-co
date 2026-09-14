"use client";

import { useState } from "react";
import EmployeeCatalogPanel, { type EmployeeEditRequest } from "./EmployeeCatalogPanel";
import EmployeeImportPanel from "./EmployeeImportPanel";
import EmployeeMasterEditorPanel from "./EmployeeMasterEditorPanel";
import ModuleWorkbench from "./ModuleWorkbench";

type EmployeeScreen = "CATALOG" | "EDITOR" | "IMPORT";
type EmployeeTab = Exclude<EmployeeScreen, "EDITOR">;
type EditorIntent = "EDIT" | "DEACTIVATE";

export default function EmployeeManagementPanel() {
  const [screen, setScreen] = useState<EmployeeScreen>("CATALOG");
  const [editRequest, setEditRequest] = useState<EmployeeEditRequest | null>(null);
  const [editorIntent, setEditorIntent] = useState<EditorIntent>("EDIT");
  const [catalogRefreshToken, setCatalogRefreshToken] = useState(0);
  const [notice, setNotice] = useState("");

  function openCatalog() {
    setScreen("CATALOG");
    setEditRequest(null);
    setEditorIntent("EDIT");
  }

  function createEmployee() {
    setEditRequest(null);
    setEditorIntent("EDIT");
    setNotice("");
    setScreen("EDITOR");
  }

  function editEmployee(employee: EmployeeEditRequest, intent: EditorIntent = "EDIT") {
    setEditRequest(employee);
    setEditorIntent(intent);
    setNotice("");
    setScreen("EDITOR");
  }

  function finishEmployee(employeeNo: string, status: "ACTIVE" | "INACTIVE") {
    setCatalogRefreshToken((value) => value + 1);
    setNotice(status === "ACTIVE"
      ? `員工 ${employeeNo} 已保存並重新載入清單。`
      : `員工 ${employeeNo} 已停用；既有需求、發放與稽核歷史仍保留。`);
    openCatalog();
  }

  function selectScreen(nextScreen: EmployeeTab) {
    setScreen(nextScreen);
    setEditRequest(null);
    setEditorIntent("EDIT");
    setNotice("");
  }

  const activeTab: EmployeeTab = screen === "EDITOR" ? "CATALOG" : screen;
  const catalogContent = screen === "EDITOR"
    ? <EmployeeMasterEditorPanel
      key={`${editRequest?.id ?? "new"}-${editorIntent}`}
      editRequest={editRequest}
      intent={editorIntent}
      onCancel={openCatalog}
      onSaved={finishEmployee}
    />
    : <EmployeeCatalogPanel
      refreshToken={catalogRefreshToken}
      onEdit={(employee) => editEmployee(employee)}
      onDeactivate={(employee) => editEmployee(employee, "DEACTIVATE")}
    />;

  return (
    <ModuleWorkbench
      idPrefix="employee-management"
      eyebrow="EMPLOYEE MANAGEMENT"
      title={screen === "EDITOR" ? editRequest ? "編輯員工" : "新增員工" : "員工主檔管理"}
      headingId="hr-employee-title"
      description="集中查詢、新增、修改、停用、匯入與匯出員工主檔；停用取代刪除，避免破壞需求與發放歷史。"
      activeTabId={activeTab}
      onTabChange={(tabId) => selectScreen(tabId as EmployeeTab)}
      actions={screen === "EDITOR"
        ? <button className="secondary-button" type="button" onClick={openCatalog}>返回員工清單</button>
        : <>
          <button className="primary-button" type="button" onClick={createEmployee}>＋ 新增員工</button>
          <button className="secondary-button" type="button" onClick={() => selectScreen("IMPORT")}>員工匯入</button>
        </>}
      feedback={notice ? <p className="success-note product-management-notice" role="status">{notice}</p> : null}
      tabs={[
        { id: "CATALOG", label: "員工清單", content: catalogContent },
        {
          id: "IMPORT",
          label: "批次匯入",
          content: <div className="workspace-panel-grid workspace-panel-grid--balanced employee-import-grid">
            <EmployeeImportPanel />
            <section className="panel product-boundary-card" aria-label="員工主檔管理規則">
              <div className="panel-heading">
                <div><p className="eyebrow">DATA CONTRACT</p><h2>員工資料規則</h2></div>
                <span className="status-pill">HR ONLY</span>
              </div>
              <div className="summary-list">
                <div className="summary-row"><span><strong>員工工號</strong><small>建立後不可修改；新增遇到既有工號會拒絕，必須從清單載入後編輯。</small></span></div>
                <div className="summary-row"><span><strong>單筆與批次分流</strong><small>日常修正使用完整單筆表單；大量資料使用 CSV 預覽、差異確認與原子套用。</small></span></div>
                <div className="summary-row"><span><strong>停用代替刪除</strong><small>離職員工不再供新流程選用，但需求、發放、退回及稽核證據永久保留。</small></span></div>
                <div className="summary-row"><span><strong>權限與稽核</strong><small>保存與匯出都要求 HR 角色、冪等鍵與 metadata 稽核；瀏覽器不取得 service-role。</small></span></div>
              </div>
            </section>
          </div>,
        },
      ]}
    />
  );
}
