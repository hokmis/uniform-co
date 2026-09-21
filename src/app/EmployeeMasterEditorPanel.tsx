"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  emptyEmployeeEditorForm,
  employeeEditorPayload,
  validateEmployeeEditor,
  type EmployeeEditorForm,
  type EmploymentStatus,
} from "@/src/domain/employee-management";
import { prepareOperationAttempt, type OperationAttempt } from "@/src/domain/operation-attempt";
import { canonicalFingerprint } from "@/src/lib/fingerprint";
import { invalidateEmployeeDirectory } from "@/src/lib/employee-directory-read";
import { invalidateMasterDataCache, loadOrganizationMasterData } from "@/src/lib/master-data-cache";
import { safeSupabaseMutationErrorMessage, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import type { EmployeeEditRequest } from "./EmployeeCatalogPanel";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

type InstitutionSource = { id: string; code: string; name: string; is_active: boolean };
type DepartmentSource = { id: string; institution_id: string; code: string; name: string; is_active: boolean };

type Props = {
  editRequest?: EmployeeEditRequest | null;
  intent?: "EDIT" | "DEACTIVATE";
  onCancel: () => void;
  onSaved: (employeeNo: string, status: EmploymentStatus) => void;
};

function formForEmployee(employee: EmployeeEditRequest | null | undefined): EmployeeEditorForm {
  if (!employee) return emptyEmployeeEditorForm;
  return {
    employeeNo: employee.employeeNo,
    name: employee.name,
    institutionCode: employee.institutionCode,
    departmentCode: employee.departmentCode,
    employmentStatus: employee.employmentStatus,
    jobTitle: employee.jobTitle,
    hireDate: employee.hireDate,
    terminationDate: employee.terminationDate,
    note: employee.note,
  };
}

export default function EmployeeMasterEditorPanel({ editRequest, intent = "EDIT", onCancel, onSaved }: Props) {
  const { client, accountId, identityError, identityLoading, isAuthenticated } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);
  const confirmationOnly = intent === "DEACTIVATE";
  const [form, setForm] = useState<EmployeeEditorForm>(() => ({
    ...formForEmployee(editRequest),
    employmentStatus: confirmationOnly ? "INACTIVE" : formForEmployee(editRequest).employmentStatus,
  }));
  const [institutions, setInstitutions] = useState<InstitutionSource[]>([]);
  const [departments, setDepartments] = useState<DepartmentSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [message, setMessage] = useState(() => confirmationOnly && editRequest
    ? `即將停用 ${editRequest.employeeNo}｜${editRequest.name}；歷史需求與發放紀錄會完整保留`
    : editRequest
      ? `已載入 ${editRequest.employeeNo}｜${editRequest.name}；工號建立後不可修改`
      : client ? "正在讀取機構與部門主檔…" : "預覽模式：登入 HR 帳號並套用 0079 SQL 後才能保存員工主檔");
  const operationRef = useRef<OperationAttempt | null>(null);

  useEffect(() => {
    if (!identityReady || !client) return;
    const supabase = client;
    let active = true;
    async function loadSources() {
      setDataLoading(true);
      try {
        const sourceResult = await loadOrganizationMasterData(supabase);
        if (!active) return;
        if (sourceResult.errors.length > 0) {
          setMessage(`組織主檔載入失敗：${safeSupabaseReadErrorMessage(sourceResult.errors[0])}`);
          return;
        }
        setInstitutions(sourceResult.institutions as InstitutionSource[]);
        setDepartments(sourceResult.departments as DepartmentSource[]);
        setMessage(confirmationOnly && editRequest
          ? `請確認停用 ${editRequest.employeeNo}｜${editRequest.name}；此操作不會刪除歷史資料`
          : editRequest
            ? `已載入 ${editRequest.employeeNo}；可修改姓名、歸屬、職稱、日期、狀態與備註`
            : "新增模式：工號建立後不可修改；機構與部門必須使用啟用中的主檔");
      } finally {
        if (active) setDataLoading(false);
      }
    }
    void loadSources();
    return () => { active = false; };
  }, [client, confirmationOnly, editRequest, identityReady, panelActive]);

  const selectedInstitution = institutions.find((institution) => institution.code === form.institutionCode);
  const institutionOptions = useMemo(() => institutions.filter((institution) => institution.is_active || institution.code === form.institutionCode), [form.institutionCode, institutions]);
  const departmentOptions = useMemo(() => departments.filter((department) =>
    department.is_active || department.code === form.departmentCode), [departments, form.departmentCode]);

  function updateField<K extends keyof EmployeeEditorForm>(field: K, value: EmployeeEditorForm[K]) {
    operationRef.current = null;
    setForm((current) => ({ ...current, [field]: value }));
  }

  function selectInstitution(code: string) {
    operationRef.current = null;
    setForm((current) => ({ ...current, institutionCode: code }));
  }

  function selectStatus(status: EmploymentStatus) {
    operationRef.current = null;
    setForm((current) => ({
      ...current,
      employmentStatus: status,
      terminationDate: status === "ACTIVE" ? "" : current.terminationDate,
    }));
  }

  async function save() {
    const formToSave = confirmationOnly ? { ...form, employmentStatus: "INACTIVE" as const } : form;
    const validationError = validateEmployeeEditor(formToSave);
    if (validationError) {
      setMessage(validationError);
      return;
    }
    if (!identityReady || !client) {
      setMessage("預覽模式：登入 HR 帳號並套用 0079 SQL 後才能保存員工主檔");
      return;
    }
    setBusy(true);
    let requestStarted = false;
    try {
      const payload = employeeEditorPayload(formToSave);
      const fingerprint = await canonicalFingerprint({ employeeId: editRequest?.id ?? null, payload });
      const operation = prepareOperationAttempt(operationRef.current, fingerprint, () => crypto.randomUUID());
      operationRef.current = operation;
      requestStarted = true;
      const { error } = await client.rpc("save_employee_master", {
        p_employee_id: editRequest?.id ?? null,
        p_employee_no: payload.employeeNo,
        p_name: payload.name,
        p_institution_code: payload.institutionCode,
        p_department_code: payload.departmentCode,
        p_employment_status: payload.employmentStatus,
        p_job_title: payload.jobTitle,
        p_hire_date: payload.hireDate,
        p_termination_date: payload.terminationDate,
        p_note: payload.note,
        p_idempotency_key: `EMPLOYEE-MASTER-${operation.key}`,
        p_request_fingerprint: operation.fingerprint,
      });
      if (error) {
        setMessage(safeSupabaseMutationErrorMessage(error, "保存失敗或結果未知；修正資料後重試，未變更的資料會沿用同一冪等鍵。"));
        return;
      }
      operationRef.current = null;
      invalidateEmployeeDirectory(client);
      invalidateMasterDataCache(client, "employee");
      onSaved(payload.employeeNo, payload.employmentStatus);
    } catch {
      setMessage(requestStarted
        ? "保存結果尚未確認；請以相同資料重試，系統會沿用同一冪等鍵。"
        : "尚未送出保存；無法產生安全的操作指紋，請再試一次。");
    } finally {
      setBusy(false);
    }
  }

  const fieldDisabled = busy || confirmationOnly;

  return (
    <section className="panel employee-editor-panel" aria-label="員工主檔新增修改停用" aria-busy={dataLoading}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">EMPLOYEE FORM</p>
          <h2>{confirmationOnly ? "停用員工" : editRequest ? "編輯員工" : "新增員工"}</h2>
          <p className="auth-message">單筆保存走 HR 專用冪等 RPC；不允許瀏覽器直接新增、修改或刪除員工資料。</p>
        </div>
        <span className={`status-pill ${confirmationOnly ? "danger" : editRequest ? "success" : ""}`}>{confirmationOnly ? "停用確認" : editRequest ? "修改模式" : "新增模式"}</span>
      </div>
      {confirmationOnly ? <div className="product-deactivate-warning"><strong>停用後不會刪除歷史資料</strong><span>員工將不再提供新需求或換季活動選用；既有需求、發放、退回及稽核紀錄仍可追溯。</span></div> : null}
      {dataLoading ? <p className="auth-message" role="status" aria-live="polite">正在載入課室部門與報局單位選項；其他欄位仍可先行填寫。</p> : null}
      <div className="form-grid employee-editor-grid">
        <label className="field"><span>員工工號</span><input value={form.employeeNo} onChange={(event) => updateField("employeeNo", event.target.value)} disabled={fieldDisabled || Boolean(editRequest)} maxLength={100} /></label>
        <label className="field"><span>姓名</span><input value={form.name} onChange={(event) => updateField("name", event.target.value)} disabled={fieldDisabled} maxLength={255} /></label>
        <label className="field"><span>課室部門</span><select value={form.institutionCode} onChange={(event) => selectInstitution(event.target.value)} disabled={fieldDisabled || (dataLoading && !form.institutionCode)}><option value="">請選擇課室部門</option>{institutionOptions.map((institution) => <option key={institution.id} value={institution.code}>{institution.code}｜{institution.name}{institution.is_active ? "" : "（停用）"}</option>)}</select></label>
        <label className="field"><span>報局單位</span><select value={form.departmentCode} onChange={(event) => updateField("departmentCode", event.target.value)} disabled={fieldDisabled || dataLoading}><option value="">請選擇報局單位</option>{departmentOptions.map((department) => <option key={department.id} value={department.code}>{department.code}｜{department.name}{department.is_active ? "" : "（停用）"}</option>)}</select></label>
        <label className="field"><span>在職狀態</span><select value={form.employmentStatus} onChange={(event) => selectStatus(event.target.value as EmploymentStatus)} disabled={fieldDisabled}><option value="ACTIVE">在職</option><option value="INACTIVE">離職／停用</option></select></label>
        <label className="field"><span>職稱（選填）</span><input value={form.jobTitle} onChange={(event) => updateField("jobTitle", event.target.value)} disabled={fieldDisabled} maxLength={255} /></label>
        <label className="field"><span>到職日（選填）</span><input type="date" value={form.hireDate} onChange={(event) => updateField("hireDate", event.target.value)} disabled={fieldDisabled} /></label>
        <label className="field"><span>離職日（選填）</span><input type="date" value={form.terminationDate} onChange={(event) => updateField("terminationDate", event.target.value)} disabled={fieldDisabled || form.employmentStatus === "ACTIVE"} /></label>
        <label className="field employee-editor-note"><span>備註（選填）</span><textarea value={form.note} onChange={(event) => updateField("note", event.target.value)} disabled={fieldDisabled} maxLength={4000} rows={4} /></label>
      </div>
      <div className="button-row">
        <button className={confirmationOnly ? "danger-button" : "primary-button"} type="button" onClick={() => void save()} disabled={busy || (dataLoading && !form.institutionCode)}>{busy ? "保存中…" : dataLoading && !form.institutionCode ? "載入選項中…" : confirmationOnly ? "確認停用" : editRequest ? "儲存修改" : "新增員工"}</button>
        <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消並返回清單</button>
      </div>
      <p className={message.includes("失敗") || message.includes("不可") || identityError ? "auth-message" : "success-note"} role="status">{identityError ?? message}</p>
    </section>
  );
}
