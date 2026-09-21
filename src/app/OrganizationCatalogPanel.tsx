"use client";

import { useCallback, useMemo, useState } from "react";
import {
  filterOrganizationCatalog,
  sortOrganizationCatalog,
  type OrganizationCatalogEntry,
  type OrganizationCatalogSortDirection,
  type OrganizationCatalogSortKey,
  type OrganizationCatalogStatus,
  type OrganizationEntityType,
} from "@/src/domain/organization-management";
import { invalidateMasterDataCache, loadOrganizationMasterData } from "@/src/lib/master-data-cache";
import { safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import type { AccountScopedReadOutcome } from "@/src/domain/account-scoped-read";
import ManagementCatalogTable from "./ManagementCatalogTable";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";
import { useAccountScopedReadSnapshot } from "./use-account-scoped-read-snapshot";

type InstitutionSource = { id: string; code: string; name: string; is_active: boolean };
type DepartmentSource = { id: string; institution_id: string; code: string; name: string; is_active: boolean };
const EMPTY_ORGANIZATION_ROWS: OrganizationCatalogEntry[] = [];

export type OrganizationEditRequest = OrganizationCatalogEntry;

type Props = {
  refreshToken?: number;
  onEdit: (entry: OrganizationEditRequest) => void;
  onDeactivate: (entry: OrganizationEditRequest) => void;
};

function buildRows(institutions: InstitutionSource[], departments: DepartmentSource[]): OrganizationCatalogEntry[] {
  const institutionById = new Map(institutions.map((institution) => [institution.id, institution]));
  return [
    ...institutions.map((institution) => ({
      id: institution.id,
      entityType: "INSTITUTIONS" as const,
      institutionCode: institution.code,
      institutionName: institution.name,
      code: institution.code,
      name: institution.name,
      isActive: institution.is_active,
    })),
    ...departments.map((department) => {
      const institution = institutionById.get(department.institution_id);
      return {
        id: department.id,
        entityType: "DEPARTMENTS" as const,
        institutionCode: institution?.code ?? department.institution_id,
        institutionName: institution?.name ?? "所屬課室部門不可讀取",
        code: department.code,
        name: department.name,
        isActive: department.is_active,
      };
    }),
  ];
}

export default function OrganizationCatalogPanel({ refreshToken = 0, onEdit, onDeactivate }: Props) {
  const { client, accountId, identityError, identityLoading, isAuthenticated } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);
  const [query, setQuery] = useState("");
  const [entityType, setEntityType] = useState<"ALL" | OrganizationEntityType>("ALL");
  const [status, setStatus] = useState<OrganizationCatalogStatus>("ALL");
  const [sortKey, setSortKey] = useState<OrganizationCatalogSortKey>("code");
  const [sortDirection, setSortDirection] = useState<OrganizationCatalogSortDirection>("asc");
  const [page, setPage] = useState(1);
  const readOrganizations = useCallback(async (): Promise<AccountScopedReadOutcome<OrganizationCatalogEntry[]>> => {
    if (!client) {
      return { status: "failure", errors: [], message: "組織主檔尚未連線。請設定 Supabase 並登入後重試。" };
    }
    const sourceResult = await loadOrganizationMasterData(client);
    if (sourceResult.errors.length > 0) {
      return {
        status: "failure",
        errors: sourceResult.errors,
        message: `組織主檔載入失敗：${safeSupabaseReadErrorMessage(sourceResult.errors[0])}`,
      };
    }

    const institutions = sourceResult.institutions as InstitutionSource[];
    const departments = sourceResult.departments as DepartmentSource[];
    return {
      status: "success",
      data: buildRows(institutions, departments),
      message: `已載入 ${institutions.length} 個機構、${departments.length} 個部門；停用資料是否可見由目前角色與資料權限決定`,
    };
  }, [client]);
  const {
    data: visibleRows,
    hasCurrentSnapshot: hasCurrentDataSnapshot,
    loading: dataLoading,
    message,
    reload,
  } = useAccountScopedReadSnapshot({
    accountId: accountId ?? null,
    enabled: identityReady,
    refreshKey: refreshToken,
    emptyData: EMPTY_ORGANIZATION_ROWS,
    resourceLabel: "組織主檔",
    initialMessage: client ? "正在確認工作區身份…" : "預覽模式：設定 Supabase env 並登入後，才能讀取目前帳號可見的組織主檔",
    read: readOrganizations,
  });

  const displayMessage = identityError ?? message;

  const filteredRows = useMemo(
    () => sortOrganizationCatalog(filterOrganizationCatalog(visibleRows, { query, entityType, status }), sortKey, sortDirection),
    [entityType, query, sortDirection, sortKey, status, visibleRows],
  );
  const institutionCount = visibleRows.filter((row) => row.entityType === "INSTITUTIONS").length;
  const departmentCount = visibleRows.filter((row) => row.entityType === "DEPARTMENTS").length;

  function selectEntityType(nextType: "ALL" | OrganizationEntityType) {
    setEntityType(nextType);
    setPage(1);
  }

  function toggleSort(nextKey: OrganizationCatalogSortKey) {
    if (sortKey === nextKey) setSortDirection((value) => value === "asc" ? "desc" : "asc");
    else {
      setSortKey(nextKey);
      setSortDirection("asc");
    }
    setPage(1);
  }

  return (
    <section className="panel organization-catalog-panel" aria-label="組織主檔清單" aria-busy={dataLoading}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ORGANIZATION DIRECTORY</p>
          <h2>課室部門與報局單位清單</h2>
          <p className="auth-message">比照管理清單模式搜尋、排序並進入獨立編輯表單；刪除語意為停用，既有員工、單據與稽核歷史不會被移除。</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => { if (client) invalidateMasterDataCache(client, "organization"); reload(); }}>{dataLoading ? "讀取中…" : "重新整理"}</button>
      </div>

      <div className="management-catalog-metrics" aria-label="組織主檔摘要">
        <div className="metric"><span>全部主檔</span><strong>{visibleRows.length}</strong><small>目前角色可讀取資料</small></div>
        <div className="metric"><span>啟用中</span><strong>{visibleRows.filter((row) => row.isActive).length}</strong><small>可供新作業選擇</small></div>
        <div className="metric"><span>課室部門</span><strong>{institutionCount}</strong><small>組織歸屬第一層</small></div>
        <div className="metric"><span>報局單位</span><strong>{departmentCount}</strong><small>獨立維護（免綁定）</small></div>
      </div>

      <nav className="management-category-tabs" aria-label="組織主檔類型">
        <button className={entityType === "ALL" ? "active" : ""} type="button" onClick={() => selectEntityType("ALL")}>全部 <span>{visibleRows.length}</span></button>
        <button className={entityType === "INSTITUTIONS" ? "active" : ""} type="button" onClick={() => selectEntityType("INSTITUTIONS")}>課室部門 <span>{institutionCount}</span></button>
        <button className={entityType === "DEPARTMENTS" ? "active" : ""} type="button" onClick={() => selectEntityType("DEPARTMENTS")}>報局單位 <span>{departmentCount}</span></button>
      </nav>

      <div className="management-catalog-filters">
        <label className="field"><span>搜尋組織</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜尋課室部門代碼、課室部門名稱、報局單位代碼或報局單位名稱…" /></label>
        <label className="field"><span>啟用狀態</span><select value={status} onChange={(event) => { setStatus(event.target.value as OrganizationCatalogStatus); setPage(1); }}><option value="ALL">全部狀態</option><option value="ACTIVE">啟用</option><option value="INACTIVE">停用</option></select></label>
      </div>

      <div className="management-catalog-result">
        <p className="muted" role="status">{displayMessage}；符合條件 {filteredRows.length} 筆</p>
        {(query || entityType !== "ALL" || status !== "ALL") ? <button className="text-button" type="button" onClick={() => { setQuery(""); setEntityType("ALL"); setStatus("ALL"); setPage(1); }}>清除篩選</button> : null}
      </div>
      {dataLoading ? <p className="sr-only" role="status" aria-live="polite">正在讀取課室部門與報局單位清單…</p> : null}

      <ManagementCatalogTable<OrganizationCatalogEntry, OrganizationCatalogSortKey>
        ariaLabel="組織主檔清單"
        rows={filteredRows}
        rowKey={(row) => `${row.entityType}:${row.id}`}
        page={page}
        onPageChange={setPage}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={toggleSort}
        loading={dataLoading && visibleRows.length === 0}
        emptyState={<p className="empty-state">尚無符合條件的組織主檔。請調整篩選，或使用上方新增按鈕建立第一筆資料。</p>}
        columns={[
          { id: "type", label: "類型", sortKey: "type", render: (row) => <span className="status-pill">{row.entityType === "INSTITUTIONS" ? "課室部門" : "報局單位"}</span> },
          { id: "code", label: "代碼", sortKey: "code", locked: true, render: (row) => <strong>{row.code}</strong> },
          { id: "name", label: "名稱", sortKey: "name", render: (row) => row.name },
          { id: "status", label: "狀態", render: (row) => <span className={`status-pill ${row.isActive ? "success" : ""}`}>{row.isActive ? "啟用" : "停用"}</span> },
          { id: "actions", label: "功能", locked: true, render: (row) => <div className="management-table-actions"><button className="management-row-action" type="button" onClick={() => onEdit(row)}>編輯</button><button className="management-row-action danger" type="button" onClick={() => onDeactivate(row)} disabled={!row.isActive}>{row.isActive ? "停用" : "已停用"}</button></div> },
        ]}
      />
    </section>
  );
}
