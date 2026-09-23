"use client";

import { useEffect, useRef, useState } from "react";
import {
  emptyOrganizationEditorForm,
  organizationEditorImportRow,
  organizationEditorKey,
  validateOrganizationEditor,
  type OrganizationInstitutionOption,
  type OrganizationEditorForm,
  type OrganizationEntityType,
} from "@/src/domain/organization-management";
import { prepareOperationAttempt, type OperationAttempt } from "@/src/domain/operation-attempt";
import { invalidateEmployeeDirectory } from "@/src/lib/employee-directory-read";
import { invalidateMasterDataCache, loadOrganizationMasterData } from "@/src/lib/master-data-cache";
import { shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import type { OrganizationEditRequest } from "./OrganizationCatalogPanel";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

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
  const { client, accountId, identityError, identityLoading, isAuthenticated } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);
  const [form, setForm] = useState(() => formFromRequest(editRequest));
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [institutionSnapshotReady, setInstitutionSnapshotReady] = useState(false);
  const institutionsRef = useRef<Institution[]>([]);
  const [busy, setBusy] = useState(false);
  const operationRef = useRef<OperationAttempt | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [message, setMessage] = useState(() => intent === "DEACTIVATE" && editRequest
    ? `即將停用 ${organizationEditorKey(entityType, formFromRequest(editRequest))}；請確認後執行`
    : editRequest
      ? `已載入 ${organizationEditorKey(entityType, formFromRequest(editRequest))}；穩定代碼不可在修改模式變更`
      : client ? `新增${entityType === "INSTITUTIONS" ? "課室部門" : "單位"}模式` : "預覽模式：登入後才能保存組織主檔");
  const confirmationOnly = intent === "DEACTIVATE";
  const keyLocked = Boolean(editRequest);

  useEffect(() => {
    if (!identityReady || !client || entityType !== "DEPARTMENTS") return;
    const supabase = client;
    let active = true;
    async function loadInstitutions() {
      setDataLoading(true);
      try {
        const sourceResult = await loadOrganizationMasterData(supabase);
        if (!active) return;
        if (sourceResult.errors.length > 0) {
          const preserveSnapshot = shouldPreserveReadSnapshot(institutionsRef.current, sourceResult.errors);
          if (!preserveSnapshot) {
            setInstitutionSnapshotReady(false);
            institutionsRef.current = [];
            setInstitutions([]);
          }
          setMessage(preserveSnapshot ? staleReadSnapshotMessage("機構選項") : "機構清單載入失敗；請重新整理後再試。保存部門前必須先取得有效機構選項。");
        } else {
          const loadedInstitutions = sourceResult.institutions as Institution[];
          institutionsRef.current = loadedInstitutions;
          setInstitutions(loadedInstitutions);
          setInstitutionSnapshotReady(true);
        }
      } finally {
        if (active) setDataLoading(false);
      }
    }
    void loadInstitutions();
    return () => { active = false; };
  }, [client, entityType, identityReady, panelActive]);

  function updateField(field: keyof OrganizationEditorForm, value: string | boolean) {
    operationRef.current = null;
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function save(formToSave = form) {
    const validationError = validateOrganizationEditor(entityType, formToSave);
    if (validationError) {
      setMessage(validationError);
      return;
    }
    if (!identityReady || !client) {
      setMessage("預覽模式：設定 Supabase env 並登入 HR 帳號後，才會由 apply_master_import 保存主檔");
      return;
    }
    const parentInstitution = entityType === "DEPARTMENTS"
      ? institutions.find((institution) => institution.code === formToSave.institutionCode.trim())
      : undefined;
    if (entityType === "DEPARTMENTS" && (!parentInstitution || !parentInstitution.is_active)) {
      setMessage("所屬課室部門不存在、已停用或尚未載入；請重新整理課室部門清單後再試。");
      return;
    }
    const row = organizationEditorImportRow(entityType, formToSave, parentInstitution
      ? { id: parentInstitution.id, code: parentInstitution.code, isActive: parentInstitution.is_active } satisfies OrganizationInstitutionOption
      : undefined);
    const stableKey = organizationEditorKey(entityType, formToSave);
    setBusy(true);
    try {
      const fingerprint = JSON.stringify({ entityType, stableKey, row });
      const operation = prepareOperationAttempt(operationRef.current, fingerprint, () => crypto.randomUUID());
      operationRef.current = operation;
      const { data, error } = await client.rpc("apply_master_import", {
        p_entity_type: entityType,
        p_source_filename: `organization-editor-${entityType.toLowerCase()}.json`,
        p_rows: [row],
        p_idempotency_key: `ORGANIZATION-MASTER-${operation.key}`,
        p_request_fingerprint: operation.fingerprint,
      });
      if (error) {
        setMessage(safeSupabaseMutationErrorMessage(error, "保存失敗或結果未知；請以相同資料重試，系統會沿用同一冪等鍵。"));
        return;
      }
      const rpcValue = Array.isArray(data) ? data[0] : data;
      const result = typeof rpcValue === "object" && rpcValue !== null
        ? rpcValue as { status?: string; error_message?: string | null }
        : null;
      if (result?.status === "FAILED") {
        setMessage("保存被伺服器拒絕；修正資料後再試，未變更的資料重試會沿用同一冪等鍵。");
        return;
      }
      if (result?.status !== "APPLIED") {
        setMessage("保存結果尚未確認；請以相同資料重試，系統會沿用同一冪等鍵。");
        return;
      }
      operationRef.current = null;
      invalidateEmployeeDirectory(client);
      invalidateMasterDataCache(client, "organization");
      onSaved(stableKey, formToSave.isActive);
    } catch {
      setMessage("保存結果尚未確認；請以相同資料重試，系統會沿用同一冪等鍵。");
    } finally {
      setBusy(false);
    }
  }

  const entityLabel = entityType === "INSTITUTIONS" ? "課室部門" : "單位";
  return (
    <section className="panel organization-editor-panel" aria-label={`${entityLabel}新增修改停用`} aria-busy={dataLoading}>
      <div className="panel-heading">
        <div><p className="eyebrow">ORGANIZATION EDITOR</p><h2>{intent === "DEACTIVATE" ? `停用${entityLabel}` : editRequest ? `編輯${entityLabel}` : `新增${entityLabel}`}</h2></div>
        <span className={`status-pill ${editRequest?.isActive ? "success" : ""}`}>{editRequest ? editRequest.isActive ? "啟用中" : "已停用" : "新增模式"}</span>
      </div>
      <p className="auth-message">清單與表單分離；保存仍透過既有整批驗證／原子 upsert RPC。正式刪除以停用取代，穩定代碼與歷史關聯不會被改寫。</p>
      {dataLoading ? <p className="auth-message" role="status" aria-live="polite">正在載入可選課室部門；代碼與名稱仍可先行填寫。</p> : null}

      <div className="form-grid">
        {entityType === "DEPARTMENTS" ? <label className="field"><span>所屬課室部門</span><select value={form.institutionCode} onChange={(event) => updateField("institutionCode", event.target.value)} disabled={busy || (dataLoading && !institutionSnapshotReady) || keyLocked || confirmationOnly}><option value="">請選擇課室部門</option>{institutions.filter((institution) => institution.is_active || institution.code === form.institutionCode).map((institution) => <option key={institution.id} value={institution.code}>{institution.code}｜{institution.name}{institution.is_active ? "" : "（停用）"}</option>)}</select></label> : null}
        <label className="field"><span>{entityLabel}代碼</span><input value={form.code} onChange={(event) => updateField("code", event.target.value)} disabled={busy || keyLocked || confirmationOnly} maxLength={100} /></label>
        <label className="field"><span>{entityLabel}名稱</span><input value={form.name} onChange={(event) => updateField("name", event.target.value)} disabled={busy || confirmationOnly} maxLength={255} /></label>
      </div>
      {!confirmationOnly ? <label className="checkbox-field"><input type="checkbox" checked={form.isActive} onChange={(event) => updateField("isActive", event.target.checked)} disabled={busy} />啟用此主檔，供新的員工、權限範圍與作業流程選用</label> : null}
      {confirmationOnly ? <div className="danger-zone-inline" role="alert"><strong>停用不會刪除歷史</strong><p>停用後不再供新作業選用；既有員工歸屬、單據快照與稽核紀錄仍保留。</p></div> : null}
      <div className="button-row">
        {confirmationOnly
          ? <button className="danger-button" type="button" onClick={() => void save({ ...form, isActive: false })} disabled={busy}>{busy ? "停用中…" : "確認停用"}</button>
          : <button className="primary-button" type="button" onClick={() => void save()} disabled={busy || (entityType === "DEPARTMENTS" && !institutionSnapshotReady)}>{busy ? "保存中…" : entityType === "DEPARTMENTS" && !institutionSnapshotReady ? "載入機構中…" : editRequest ? "儲存修改" : `新增${entityLabel}`}</button>}
        <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消並返回清單</button>
      </div>
      <p className={message.includes("失敗") || message.includes("拒絕") || message.includes("必須") || message.includes("不可") || message.includes("未確認") || message.includes("未知") || identityError ? "auth-message" : "success-note"} role="status">{identityError ?? message}</p>
    </section>
  );
}
