"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  employeeCatalogExportRows,
  filterEmployeeCatalog,
  sortEmployeeCatalog,
  type EmployeeCatalogEntry,
  type EmployeeCatalogSortDirection,
  type EmployeeCatalogSortKey,
  type EmployeeCatalogStatus,
} from "@/src/domain/employee-management";
import { masterRowsToCsv } from "@/src/domain/master-data";
import { canonicalFingerprint } from "@/src/lib/fingerprint";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import ManagementCatalogTable from "./ManagementCatalogTable";

type InstitutionSource = { id: string; code: string; name: string; is_active: boolean };
type DepartmentSource = { id: string; institution_id: string; code: string; name: string; is_active: boolean };
type EmployeeSource = { id: string; employee_no: string; name: string; institution_id: string; department_id: string; employment_status: "ACTIVE" | "INACTIVE"; job_title: string | null; hire_date: string | null; termination_date: string | null; note: string | null };

export type EmployeeEditRequest = EmployeeCatalogEntry;

type Props = {
  refreshToken?: number;
  onEdit: (entry: EmployeeEditRequest) => void;
  onDeactivate: (entry: EmployeeEditRequest) => void;
};

function buildRows(employees: EmployeeSource[], institutions: InstitutionSource[], departments: DepartmentSource[]): EmployeeCatalogEntry[] {
  const institutionById = new Map(institutions.map((row) => [row.id, row]));
  const departmentById = new Map(departments.map((row) => [row.id, row]));
  return employees.map((employee) => {
    const institution = institutionById.get(employee.institution_id);
    const department = departmentById.get(employee.department_id);
    return {
      id: employee.id,
      employeeNo: employee.employee_no,
      name: employee.name,
      institutionCode: institution?.code ?? employee.institution_id,
      institutionName: institution?.name ?? "機構不可讀取",
      departmentCode: department?.code ?? employee.department_id,
      departmentName: department?.name ?? "部門不可讀取",
      employmentStatus: employee.employment_status,
      jobTitle: employee.job_title ?? "",
      hireDate: employee.hire_date ?? "",
      terminationDate: employee.termination_date ?? "",
      note: employee.note ?? "",
    };
  });
}

export default function EmployeeCatalogPanel({ refreshToken = 0, onEdit, onDeactivate }: Props) {
  const client = getSupabaseBrowserClient();
  const [rows, setRows] = useState<EmployeeCatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<EmployeeCatalogStatus>("ALL");
  const [institutionCode, setInstitutionCode] = useState("");
  const [sortKey, setSortKey] = useState<EmployeeCatalogSortKey>("employeeNo");
  const [sortDirection, setSortDirection] = useState<EmployeeCatalogSortDirection>("asc");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [message, setMessage] = useState(() => client ? "正在讀取員工主檔…" : "預覽模式：登入後才能讀取受 RLS 保護的員工主檔");
  const exportOperation = useRef<{ key: string; fingerprint: string } | null>(null);

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      setBusy(true);
      const [employeeResult, institutionResult, departmentResult] = await Promise.all([
        supabase.from("employees").select("id,employee_no,name,institution_id,department_id,employment_status,job_title,hire_date,termination_date,note").order("employee_no").limit(10000),
        supabase.from("institutions").select("id,code,name,is_active").order("code").limit(1000),
        supabase.from("departments").select("id,institution_id,code,name,is_active").order("code").limit(5000),
      ]);
      if (!active) return;
      setBusy(false);
      if (employeeResult.error || institutionResult.error || departmentResult.error) {
        setRows([]);
        setMessage(`員工主檔載入失敗：${employeeResult.error?.message ?? institutionResult.error?.message ?? departmentResult.error?.message ?? "未知錯誤"}`);
        return;
      }
      const nextRows = buildRows((employeeResult.data ?? []) as EmployeeSource[], (institutionResult.data ?? []) as InstitutionSource[], (departmentResult.data ?? []) as DepartmentSource[]);
      setRows(nextRows);
      exportOperation.current = null;
      setMessage(`已載入 ${nextRows.length} 位員工；停用資料是否可見由目前角色與 RLS 決定`);
    }
    void load();
    return () => { active = false; };
  }, [client, refreshToken, reloadToken]);

  const filteredRows = useMemo(() => filterEmployeeCatalog(rows, { query, status, institutionCode }), [institutionCode, query, rows, status]);
  const sortedRows = useMemo(() => sortEmployeeCatalog(filteredRows, sortKey, sortDirection), [filteredRows, sortDirection, sortKey]);
  const institutionOptions = [...new Map(rows.map((row) => [row.institutionCode, row.institutionName])).entries()].sort(([left], [right]) => left.localeCompare(right, "zh-Hant", { numeric: true }));

  function toggleSort(nextKey: EmployeeCatalogSortKey) {
    if (sortKey === nextKey) setSortDirection((value) => value === "asc" ? "desc" : "asc");
    else { setSortKey(nextKey); setSortDirection("asc"); }
    setPage(1);
  }

  async function exportEmployees() {
    if (!client) {
      setMessage("預覽模式：登入 HR 帳號並套用 0079 SQL 後才能匯出員工主檔");
      return;
    }
    setBusy(true);
    const exportRows = employeeCatalogExportRows(sortedRows);
    const fingerprint = await canonicalFingerprint({ report: "EMPLOYEE_MASTER", rows: exportRows });
    const operation = exportOperation.current?.fingerprint === fingerprint
      ? exportOperation.current
      : { key: crypto.randomUUID(), fingerprint };
    exportOperation.current = operation;
    const auditResult = await client.rpc("record_employee_master_export", {
      p_row_count: exportRows.length,
      p_idempotency_key: `EMPLOYEE-EXPORT-${operation.key}`,
      p_request_fingerprint: operation.fingerprint,
    });
    if (auditResult.error) {
      setBusy(false);
      setMessage(`匯出稽核失敗，未產生檔案：${auditResult.error.message}；請確認已執行 0079 SQL 後重試`);
      return;
    }
    const blob = new Blob([masterRowsToCsv(exportRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `employees-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    exportOperation.current = null;
    setBusy(false);
    setMessage(`已匯出目前篩選結果 ${exportRows.length} 筆；匯出事件已記錄`);
  }

  return (
    <section className="panel employee-catalog-panel" aria-label="員工主檔清單">
      <div className="panel-heading">
        <div><p className="eyebrow">EMPLOYEE DIRECTORY</p><h2>員工清單</h2><p className="auth-message">集中查詢完整員工欄位並進入獨立編輯表單；刪除語意為離職停用，不移除歷史單據。</p></div>
        <div className="employee-catalog-actions"><button className="secondary-button" type="button" onClick={() => void exportEmployees()} disabled={busy}>{busy ? "處理中…" : "匯出篩選結果"}</button><button className="secondary-button" type="button" onClick={() => setReloadToken((value) => value + 1)} disabled={busy}>重新整理</button></div>
      </div>
      <div className="management-catalog-metrics" aria-label="員工主檔摘要">
        <div className="metric"><span>全部員工</span><strong>{rows.length}</strong><small>目前角色可讀取資料</small></div>
        <div className="metric"><span>在職</span><strong>{rows.filter((row) => row.employmentStatus === "ACTIVE").length}</strong><small>可供新需求與活動選用</small></div>
        <div className="metric"><span>離職／停用</span><strong>{rows.filter((row) => row.employmentStatus === "INACTIVE").length}</strong><small>保留歷史，不供新流程選用</small></div>
        <div className="metric"><span>機構數</span><strong>{institutionOptions.length}</strong><small>依目前可讀員工統計</small></div>
      </div>
      <div className="employee-catalog-filters">
        <label className="field"><span>搜尋員工</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜尋工號、姓名、機構、部門或職稱…" /></label>
        <label className="field"><span>在職狀態</span><select value={status} onChange={(event) => { setStatus(event.target.value as EmployeeCatalogStatus); setPage(1); }}><option value="ALL">全部狀態</option><option value="ACTIVE">在職</option><option value="INACTIVE">離職／停用</option></select></label>
        <label className="field"><span>機構</span><select value={institutionCode} onChange={(event) => { setInstitutionCode(event.target.value); setPage(1); }}><option value="">全部機構</option>{institutionOptions.map(([code, name]) => <option key={code} value={code}>{code}｜{name}</option>)}</select></label>
      </div>
      <div className="management-catalog-result"><p className="muted" role="status">{message}；符合條件 {sortedRows.length} 筆</p>{query || status !== "ALL" || institutionCode ? <button className="text-button product-filter-reset" type="button" onClick={() => { setQuery(""); setStatus("ALL"); setInstitutionCode(""); setPage(1); }}>清除篩選</button> : null}</div>
      <ManagementCatalogTable<EmployeeCatalogEntry, EmployeeCatalogSortKey>
        ariaLabel="員工主檔清單"
        rows={sortedRows}
        rowKey={(row) => row.id}
        page={page}
        onPageChange={setPage}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={toggleSort}
        tableClassName="employee-catalog-table"
        emptyState={<p className="empty-state">尚無符合條件的員工主檔。</p>}
        columns={[
          { id: "employee-no", label: "工號", sortKey: "employeeNo", locked: true, render: (row) => <strong>{row.employeeNo}</strong> },
          { id: "name", label: "姓名", sortKey: "name", render: (row) => row.name },
          { id: "institution", label: "機構", sortKey: "institution", render: (row) => `${row.institutionCode}｜${row.institutionName}` },
          { id: "department", label: "部門", sortKey: "department", render: (row) => `${row.departmentCode}｜${row.departmentName}` },
          { id: "job-title", label: "職稱", render: (row) => row.jobTitle || "—" },
          { id: "hire-date", label: "到職日", sortKey: "hireDate", render: (row) => row.hireDate || "—" },
          { id: "termination-date", label: "離職日", defaultVisible: false, render: (row) => row.terminationDate || "—" },
          { id: "note", label: "備註", defaultVisible: false, className: "management-note-cell", render: (row) => row.note || "—" },
          { id: "status", label: "狀態", sortKey: "status", render: (row) => <span className={`status-pill ${row.employmentStatus === "ACTIVE" ? "success" : ""}`}>{row.employmentStatus === "ACTIVE" ? "在職" : "離職／停用"}</span> },
          { id: "actions", label: "功能", locked: true, render: (row) => <div className="management-table-actions"><button className="management-row-action" type="button" onClick={() => onEdit(row)}>編輯</button><button className="management-row-action danger" type="button" onClick={() => onDeactivate(row)} disabled={row.employmentStatus === "INACTIVE"}>{row.employmentStatus === "ACTIVE" ? "停用" : "已停用"}</button></div> },
        ]}
      />
    </section>
  );
}
