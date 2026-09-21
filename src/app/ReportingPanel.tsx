"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterReportRows,
  formatReportValue,
  getReportColumns,
  getReportDefinition,
  reportDefinitions,
  sortReportRows,
  type ReportName,
  type ReportRow,
  type ReportSortDirection,
} from "@/src/domain/reporting-catalog";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { createReadRequestController, shouldPreserveReadSnapshot, type ReadRequestController } from "@/src/domain/read-refresh";
import { usePanelActivity } from "./RetainedPanelSet";
import ManagementCatalogTable from "./ManagementCatalogTable";
import { useWorkspaceSession } from "./workspace-session";

export default function ReportingPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [reportName, setReportName] = useState<ReportName>("v_item_availability");
  const [loadedReportName, setLoadedReportName] = useState<ReportName>("v_item_availability");
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [query, setQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<ReportSortDirection>("asc");
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [message, setMessage] = useState(() => client
    ? "正在讀取品號可用量…"
    : "預覽模式：設定 Supabase env 並登入後，才能讀取目前帳號可見的報表");
  const [dataLoading, setDataLoading] = useState(false);
  const rowsRef = useRef<ReportRow[]>([]);
  const readControllerRef = useRef<ReadRequestController | null>(null);
  const loadedReportNameRef = useRef<ReportName>("v_item_availability");
  const [dataSnapshotAccountId, setDataSnapshotAccountId] = useState<string | null>(null);
  const dataSnapshotAccountIdRef = useRef<string | null>(null);

  const report = getReportDefinition(reportName);
  const loadedReport = getReportDefinition(loadedReportName);
  const reportColumns = report.columns.join(",");
  const hasCurrentDataSnapshot = Boolean(
    identityReady
      && dataSnapshotAccountId
      && dataSnapshotAccountId === accountId,
  );
  const visibleRows = useMemo(() => hasCurrentDataSnapshot ? rows : [], [hasCurrentDataSnapshot, rows]);
  const columns = useMemo(() => getReportColumns(loadedReportName, visibleRows), [loadedReportName, visibleRows]);
  const filteredRows = useMemo(() => filterReportRows(visibleRows, query), [query, visibleRows]);
  const sortedRows = useMemo(
    () => sortReportRows(filteredRows, sortColumn, sortDirection),
    [filteredRows, sortColumn, sortDirection],
  );
  const displayMessage = identityError ?? message;

  useEffect(() => {
    if (!identityReady || !client) {
      return;
    }
    const supabase = client;
    const readController = readControllerRef.current ?? createReadRequestController();
    readControllerRef.current = readController;
    const readSequence = readController.begin();
    let active = true;
    async function load() {
      setDataLoading(true);
      setMessage(`正在讀取${report.label}…`);
      try {
        const [result] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from(reportName).select(reportColumns).limit(200)] as const,
        );
        const { data, error } = result;
        if (!active || !readController.isCurrent(readSequence)) return;
        if (error) {
          const preserveSnapshot = dataSnapshotAccountIdRef.current === accountId
            && shouldPreserveReadSnapshot(rowsRef.current, [error]);
          if (!preserveSnapshot) {
            rowsRef.current = [];
            setRows([]);
            loadedReportNameRef.current = reportName;
            setLoadedReportName(reportName);
            setLastUpdatedAt(null);
            dataSnapshotAccountIdRef.current = null;
            setDataSnapshotAccountId(null);
          }
          setMessage(preserveSnapshot
            ? loadedReportNameRef.current === reportName
              ? `${report.label}暫時無法更新，仍顯示上次已載入資料；請稍後重新整理。`
              : `無法載入${report.label}，仍顯示上一份${getReportDefinition(loadedReportNameRef.current).label}；請稍後重新整理。`
            : `報表載入失敗：${safeSupabaseReadErrorMessage(error)}`);
          return;
        }
        const nextRows = (data ?? []) as unknown as ReportRow[];
        rowsRef.current = nextRows;
        setRows(nextRows);
        dataSnapshotAccountIdRef.current = accountId;
        setDataSnapshotAccountId(accountId);
        loadedReportNameRef.current = reportName;
        setLoadedReportName(reportName);
        setLastUpdatedAt(new Date());
        setMessage(`已載入 ${nextRows.length} 筆（最多 200 筆）；資料由即時 view 計算，不另存報表副本`);
      } finally {
        if (active && readController.isCurrent(readSequence)) setDataLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accountId, client, identityError, identityReady, panelActive, reloadToken, report.label, reportColumns, reportName]);

  function changeReport(nextReport: ReportName) {
    if (nextReport === reportName) return;
    setQuery("");
    setSortColumn(null);
    setSortDirection("asc");
    setPage(1);
    setMessage(`正在切換至${getReportDefinition(nextReport).label}…`);
    setReportName(nextReport);
  }

  function toggleSort(column: string) {
    if (sortColumn === column) setSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
    setPage(1);
  }

  return (
    <section className="panel reporting-panel" aria-label="只讀營運報表" aria-busy={dataLoading}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">REPORTS / READ ONLY</p>
          <h2>庫存、發放、換季、採購與稽核報表</h2>
          <p className="auth-message">欄位名稱與常用狀態統一轉為中文；原始 view 欄位與資料權限不變。</p>
        </div>
        <span className="status-pill">依權限即時</span>
      </div>

      <div className="reporting-toolbar">
        <label className="field"><span>營運報表</span><select value={reportName} onChange={(event) => changeReport(event.target.value as ReportName)}>{reportDefinitions.map((definition) => <option key={definition.name} value={definition.name}>{definition.label}</option>)}</select></label>
        <label className="field"><span>搜尋目前結果</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="輸入單號、品號、名稱、狀態或數量…" /></label>
        <div className="field reporting-refresh"><span>&nbsp;</span><button className="secondary-button" type="button" onClick={() => setReloadToken((value) => value + 1)}>{dataLoading ? "讀取中…" : "重新整理"}</button></div>
      </div>

      <div className="reporting-description" role="note"><strong>{loadedReport.label}</strong><span>{loadedReport.description}</span>{dataLoading && loadedReportName !== reportName ? <span className="muted">正在載入新的報表資料…</span> : null}</div>
      <div className="management-catalog-metrics reporting-metrics" aria-label="營運報表摘要">
        <div className="metric"><span>載入筆數</span><strong>{visibleRows.length}</strong><small>目前角色可讀取，最多 200 筆</small></div>
        <div className="metric"><span>符合搜尋</span><strong>{filteredRows.length}</strong><small>{query ? `搜尋「${query}」` : "尚未套用搜尋條件"}</small></div>
        <div className="metric"><span>中文欄位</span><strong>{columns.length}</strong><small>依目前報表定義顯示</small></div>
        <div className="metric"><span>更新時間</span><strong className="reporting-updated-time">{lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—"}</strong><small>按重新整理取得最新 view</small></div>
      </div>

      <div className="management-catalog-result reporting-result">
        <p className="muted" role="status">{displayMessage}；符合條件 {sortedRows.length} 筆</p>
        {query ? <button className="text-button product-filter-reset" type="button" onClick={() => { setQuery(""); setPage(1); }}>清除搜尋</button> : null}
      </div>

      <ManagementCatalogTable<ReportRow, string>
        ariaLabel={loadedReport.label}
        rows={sortedRows}
        rowKey={(_, index) => `${loadedReportName}-${index}`}
        page={page}
        onPageChange={setPage}
        sortKey={sortColumn ?? ""}
        sortDirection={sortDirection}
        onSort={toggleSort}
        loading={dataLoading && visibleRows.length === 0}
        defaultPageSize={25}
        pageSizeOptions={[25, 50, 100]}
        tableClassName="reporting-table"
        emptyState={<p className="empty-state">{dataLoading ? "正在讀取報表…" : identityError ?? "尚無符合條件的資料，或目前帳號沒有此報表的讀取權限。"}</p>}
        columns={columns.map((column, index) => ({
          id: column.key,
          label: column.label,
          sortKey: column.key,
          locked: index === 0,
          className: "reporting-cell",
          render: (row: ReportRow) => {
            const displayValue = formatReportValue(column.key, row[column.key]);
            return <span title={displayValue}>{displayValue}</span>;
          },
        }))}
      />
    </section>
  );
}
