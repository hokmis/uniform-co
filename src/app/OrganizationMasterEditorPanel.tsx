"use client";

import { useEffect, useState } from "react";
import {
  emptyOrganizationEditorForm,
  organizationEditorImportRow,
  organizationEditorKey,
  validateOrganizationEditor,
  type OrganizationEditorForm,
  type OrganizationEntityType,
} from "@/src/domain/organization-management";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import type { OrganizationEditRequest } from "./OrganizationCatalogPanel";

type Institution = { id: string; code: string; name: string; is_active: boolean };

type Props = {
  entityType: OrganizationEntityType;
  editRequest?: OrganizationEditRequest | null;
  intent?: "EDIT" | "DEACTIVATE";
  onCancel: () => void;
  onSaved: (stableKey: string, isActive: boolean) => void;
};

function formFromRequest(request: OrganizationEditRequest | null | undefined): OrganizationEditorForm {
  if (!request) return emptyOrganizationEditorForm;
  return {
    institutionCode: request.entityType === "DEPARTMENTS" ? request.institutionCode : "",
    code: request.code,
    name: request.name,
    isActive: request.isActive,
  };
}

export default function OrganizationMasterEditorPanel({
  entityType,
  editRequest,
  intent = "EDIT",
  onCancel,
  onSaved,
}: Props) {
  const client = getSupabaseBrowserClient();
  const [form, setForm] = useState(() => formFromRequest(editRequest));
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(() => intent === "DEACTIVATE" && editRequest
    ? `即將停用 ${organizationEditorKey(entityType, formFromRequest(editRequest))}；請確認後執行`
    : editRequest
      ? `已載入 ${organizationEditorKey(entityType, formFromRequest(editRequest))}；穩定代碼不可在修改模式變更`
      : client ? `新增${entityType === "INSTITUTIONS" ? "機構" : "部門"}模式` : "預覽模式：登入後才能保存組織主檔");
  const confirmationOnly = intent === "DEACTIVATE";
  const keyLocked = Boolean(editRequest);

  useEffect(() => {
    if (!client || entityType !== "DEPARTMENTS") return;
    const supabase = client;
    let active = true;
    void supabase.from("institutions").select("id,code,name,is_active").order("code").limit(1000).then((result) => {
      if (!active) return;
      if (result.error) setMessage(`機構清單載入失敗：${result.error.message}`);
      else setInstitutions((result.data ?? []) as Institution[]);
    });
    return () => { active = false; };
  }, [client, entityType]);

  function updateField(field: keyof OrganizationEditorForm, value: string | boolean) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function save(formToSave = form) {
    const validationError = validateOrganizationEditor(entityType, formToSave);
    if (validationError) {
      setMessage(validationError);
      return;
    }
    if (!client) {
      setMessage("預覽模式：設定 Supabase env 並登入 HR 帳號後，才會由 apply_master_import 保存主檔");
      return;
    }
    const row = organizationEditorImportRow(entityType, formToSave);
    const stableKey = organizationEditorKey(entityType, formToSave);
    setBusy(true);
    const { data, error } = await client.rpc("apply_master_import", {
      p_entity_type: entityType,
      p_source_filename: `organization-editor-${entityType.toLowerCase()}.json`,
      p_rows: [row],
      p_idempotency_key: `ORGANIZATION-MASTER-${crypto.randomUUID()}`,
      p_request_fingerprint: JSON.stringify({ entityType, stableKey, row }),
    });
    setBusy(false);
    if (error) {
      setMessage(`保存失敗或結果未知：${error.message}；請返回清單重新整理，確認後再重試`);
      return;
    }
    const result = data as { status?: string; error_message?: string | null } | null;
    if (result?.status === "FAILED") {
      setMessage(`保存被伺服器拒絕：${result.error_message ?? "請查看主檔匯入批次錯誤"}`);
      return;
    }
    onSaved(stableKey, formToSave.isActive);
  }

  const entityLabel = entityType === "INSTITUTIONS" ? "機構" : "部門";
  return (
    <section className="panel organization-editor-panel" aria-label={`${entityLabel}新增修改停用`}>
      <div className="panel-heading">
        <div><p className="eyebrow">ORGANIZATION EDITOR</p><h2>{intent === "DEACTIVATE" ? `停用${entityLabel}` : editRequest ? `編輯${entityLabel}` : `新增${entityLabel}`}</h2></div>
        <span className={`status-pill ${editRequest?.isActive ? "success" : ""}`}>{editRequest ? editRequest.isActive ? "啟用中" : "已停用" : "新增模式"}</span>
      </div>
      <p className="auth-message">清單與表單分離；保存仍透過既有整批驗證／原子 upsert RPC。正式刪除以停用取代，穩定代碼與歷史關聯不會被改寫。</p>

      <div className="form-grid">
        {entityType === "DEPARTMENTS" ? <label className="field"><span>所屬機構</span><select value={form.institutionCode} onChange={(event) => updateField("institutionCode", event.target.value)} disabled={busy || keyLocked || confirmationOnly}><option value="">請選擇機構</option>{institutions.filter((institution) => institution.is_active || institution.code === form.institutionCode).map((institution) => <option key={institution.id} value={institution.code}>{institution.code}｜{institution.name}{institution.is_active ? "" : "（停用）"}</option>)}</select></label> : null}
        <label className="field"><span>{entityLabel}代碼</span><input value={form.code} onChange={(event) => updateField("code", event.target.value)} disabled={busy || keyLocked || confirmationOnly} maxLength={100} /></label>
        <label className="field"><span>{entityLabel}名稱</span><input value={form.name} onChange={(event) => updateField("name", event.target.value)} disabled={busy || confirmationOnly} maxLength={255} /></label>
      </div>
      {!confirmationOnly ? <label className="checkbox-field"><input type="checkbox" checked={form.isActive} onChange={(event) => updateField("isActive", event.target.checked)} disabled={busy} />啟用此主檔，供新的員工、權限範圍與作業流程選用</label> : null}
      {confirmationOnly ? <div className="danger-zone-inline" role="alert"><strong>停用不會刪除歷史</strong><p>停用後不再供新作業選用；既有員工歸屬、單據快照與稽核紀錄仍保留。</p></div> : null}
      <div className="button-row">
        {confirmationOnly
          ? <button className="danger-button" type="button" onClick={() => void save({ ...form, isActive: false })} disabled={busy}>{busy ? "停用中…" : "確認停用"}</button>
          : <button className="primary-button" type="button" onClick={() => void save()} disabled={busy}>{busy ? "保存中…" : editRequest ? "儲存修改" : `新增${entityLabel}`}</button>}
        <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消並返回清單</button>
      </div>
      <p className={message.includes("失敗") || message.includes("拒絕") || message.includes("必須") || message.includes("不可") ? "auth-message" : "success-note"} role="status">{message}</p>
    </section>
  );
}
