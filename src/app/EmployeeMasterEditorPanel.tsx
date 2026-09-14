"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  emptyEmployeeEditorForm,
  employeeEditorPayload,
  validateEmployeeEditor,
  type EmployeeEditorForm,
  type EmploymentStatus,
} from "@/src/domain/employee-management";
import { canonicalFingerprint } from "@/src/lib/fingerprint";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import type { EmployeeEditRequest } from "./EmployeeCatalogPanel";

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
  const client = getSupabaseBrowserClient();
  const confirmationOnly = intent === "DEACTIVATE";
  const [form, setForm] = useState<EmployeeEditorForm>(() => ({
    ...formForEmployee(editRequest),
    employmentStatus: confirmationOnly ? "INACTIVE" : formForEmployee(editRequest).employmentStatus,
  }));
  const [institutions, setInstitutions] = useState<InstitutionSource[]>([]);
  const [departments, setDepartments] = useState<DepartmentSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(() => confirmationOnly && editRequest
    ? `即將停用 ${editRequest.employeeNo}｜${editRequest.name}；歷史需求與發放紀錄會完整保留`
    : editRequest
      ? `已載入 ${editRequest.employeeNo}｜${editRequest.name}；工號建立後不可修改`
      : client ? "正在讀取機構與部門主檔…" : "預覽模式：登入 HR 帳號並套用 0079 SQL 後才能保存員工主檔");
  const operationRef = useRef<{ key: string; fingerprint: string } | null>(null);

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function loadSources() {
      const [institutionResult, departmentResult] = await Promise.all([
        supabase.from("institutions").select("id,code,name,is_active").order("code").limit(1000),
        supabase.from("departments").select("id,institution_id,code,name,is_active").order("code").limit(5000),
      ]);
      if (!active) return;
      if (institutionResult.error || departmentResult.error) {
        setMessage(`組織主檔載入失敗：${institutionResult.error?.message ?? departmentResult.error?.message ?? "未知錯誤"}`);
        return;
      }
      setInstitutions((institutionResult.data ?? []) as InstitutionSource[]);
      setDepartments((departmentResult.data ?? []) as DepartmentSource[]);
      setMessage(confirmationOnly && editRequest
        ? `請確認停用 ${editRequest.employeeNo}｜${editRequest.name}；此操作不會刪除歷史資料`
        : editRequest
          ? `已載入 ${editRequest.employeeNo}；可修改姓名、歸屬、職稱、日期、狀態與備註`
          : "新增模式：工號建立後不可修改；機構與部門必須使用啟用中的主檔");
    }
    void loadSources();
    return () => { active = false; };
  }, [client, confirmationOnly, editRequest]);

  const selectedInstitution = institutions.find((institution) => institution.code === form.institutionCode);
  const institutionOptions = useMemo(() => institutions.filter((institution) => institution.is_active || institution.code === form.institutionCode), [form.institutionCode, institutions]);
  const departmentOptions = useMemo(() => departments.filter((department) =>
    department.institution_id === selectedInstitution?.id
    && (department.is_active || department.code === form.departmentCode)), [departments, form.departmentCode, selectedInstitution?.id]);

  function updateField<K extends keyof EmployeeEditorForm>(field: K, value: EmployeeEditorForm[K]) {
    operationRef.current = null;
    setForm((current) => ({ ...current, [field]: value }));
  }

  function selectInstitution(code: string) {
    operationRef.current = null;
    setForm((current) => ({ ...current, institutionCode: code, departmentCode: "" }));
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
    if (!client) {
      setMessage("預覽模式：登入 HR 帳號並套用 0079 SQL 後才能保存員工主檔");
      return;
    }
    setBusy(true);
    const payload = employeeEditorPayload(formToSave);
    const fingerprint = await canonicalFingerprint({ employeeId: editRequest?.id ?? null, payload });
    const operation = operationRef.current?.fingerprint === fingerprint
      ? operationRef.current
      : { key: crypto.randomUUID(), fingerprint };
    operationRef.current = operation;
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
    setBusy(false);
    if (error) {
      setMessage(`保存失敗或結果未知：${error.message}；請確認已執行 0079 SQL，修正資料後再重試`);
      return;
    }
    operationRef.current = null;
    onSaved(payload.employeeNo, payload.employmentStatus);
  }

  const fieldDisabled = busy || confirmationOnly;

  return (
    <section className="panel employee-editor-panel" aria-label="員工主檔新增修改停用">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">EMPLOYEE FORM</p>
          <h2>{confirmationOnly ? "停用員工" : editRequest ? "編輯員工" : "新增員工"}</h2>
          <p className="auth-message">單筆保存走 HR 專用冪等 RPC；不允許瀏覽器直接新增、修改或刪除員工資料。</p>
        </div>
        <span className={`status-pill ${confirmationOnly ? "danger" : editRequest ? "success" : ""}`}>{confirmationOnly ? "停用確認" : editRequest ? "修改模式" : "新增模式"}</span>
      </div>
      {confirmationOnly ? <div className="product-deactivate-warning"><strong>停用後不會刪除歷史資料</strong><span>員工將不再提供新需求或換季活動選用；既有需求、發放、退回及稽核紀錄仍可追溯。</span></div> : null}
      <div className="form-grid employee-editor-grid">
        <label className="field"><span>員工工號</span><input value={form.employeeNo} onChange={(event) => updateField("employeeNo", event.target.value)} disabled={fieldDisabled || Boolean(editRequest)} maxLength={100} /></label>
        <label className="field"><span>姓名</span><input value={form.name} onChange={(event) => updateField("name", event.target.value)} disabled={fieldDisabled} maxLength={255} /></label>
        <label className="field"><span>機構</span><select value={form.institutionCode} onChange={(event) => selectInstitution(event.target.value)} disabled={fieldDisabled}><option value="">請選擇機構</option>{institutionOptions.map((institution) => <option key={institution.id} value={institution.code}>{institution.code}｜{institution.name}{institution.is_active ? "" : "（停用）"}</option>)}</select></label>
        <label className="field"><span>部門</span><select value={form.departmentCode} onChange={(event) => updateField("departmentCode", event.target.value)} disabled={fieldDisabled || !form.institutionCode}><option value="">請選擇部門</option>{departmentOptions.map((department) => <option key={department.id} value={department.code}>{department.code}｜{department.name}{department.is_active ? "" : "（停用）"}</option>)}</select></label>
        <label className="field"><span>在職狀態</span><select value={form.employmentStatus} onChange={(event) => selectStatus(event.target.value as EmploymentStatus)} disabled={fieldDisabled}><option value="ACTIVE">在職</option><option value="INACTIVE">離職／停用</option></select></label>
        <label className="field"><span>職稱（選填）</span><input value={form.jobTitle} onChange={(event) => updateField("jobTitle", event.target.value)} disabled={fieldDisabled} maxLength={255} /></label>
        <label className="field"><span>到職日（選填）</span><input type="date" value={form.hireDate} onChange={(event) => updateField("hireDate", event.target.value)} disabled={fieldDisabled} /></label>
        <label className="field"><span>離職日（選填）</span><input type="date" value={form.terminationDate} onChange={(event) => updateField("terminationDate", event.target.value)} disabled={fieldDisabled || form.employmentStatus === "ACTIVE"} /></label>
        <label className="field employee-editor-note"><span>備註（選填）</span><textarea value={form.note} onChange={(event) => updateField("note", event.target.value)} disabled={fieldDisabled} maxLength={4000} rows={4} /></label>
      </div>
      <div className="button-row">
        <button className={confirmationOnly ? "danger-button" : "primary-button"} type="button" onClick={() => void save()} disabled={busy}>{busy ? "保存中…" : confirmationOnly ? "確認停用" : editRequest ? "儲存修改" : "新增員工"}</button>
        <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消並返回清單</button>
      </div>
      <p className={message.includes("失敗") || message.includes("不可") ? "auth-message" : "success-note"} role="status">{message}</p>
    </section>
  );
}
