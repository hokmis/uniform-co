"use client";

import { useEffect, useMemo, useState } from "react";
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
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import ManagementCatalogTable from "./ManagementCatalogTable";

export default function ReportingPanel() {
  const client = getSupabaseBrowserClient();
  const [reportName, setReportName] = useState<ReportName>("v_item_availability");
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [query, setQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<ReportSortDirection>("asc");
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [message, setMessage] = useState(() => client
    ? "正在讀取品號可用量…"
    : "預覽模式：設定 Supabase env 並登入後，才能讀取受 RLS 保護的報表");
  const [busy, setBusy] = useState(false);

  const report = getReportDefinition(reportName);
  const columns = useMemo(() => getReportColumns(reportName, rows), [reportName, rows]);
  const filteredRows = useMemo(() => filterReportRows(rows, query), [query, rows]);
  const sortedRows = useMemo(
    () => sortReportRows(filteredRows, sortColumn, sortDirection),
    [filteredRows, sortColumn, sortDirection],
  );

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      setBusy(true);
      setMessage(`正在讀取${report.label}…`);
      const { data, error } = await supabase.from(reportName).select("*").limit(200);
      if (!active) return;
      setBusy(false);
      if (error) {
        setRows([]);
        setLastUpdatedAt(null);
        setMessage(`報表載入失敗：${error.message}`);
        return;
      }
      const nextRows = (data ?? []) as ReportRow[];
      setRows(nextRows);
      setLastUpdatedAt(new Date());
      setMessage(`已載入 ${nextRows.length} 筆（最多 200 筆）；資料由即時 view 計算，不另存報表副本`);
    }
    void load();
    return () => { active = false; };
  }, [client, reloadToken, report.label, reportName]);

  function changeReport(nextReport: ReportName) {
    setRows([]);
    setQuery("");
    setSortColumn(null);
    setSortDirection("asc");
    setPage(1);
    setLastUpdatedAt(null);
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
    <section className="panel reporting-panel" aria-label="只讀營運報表">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">REPORTS / READ ONLY</p>
          <h2>庫存、發放、換季、採購與稽核報表</h2>
          <p className="auth-message">欄位名稱與常用狀態統一轉為中文；原始 view 欄位與資料權限不變。</p>
        </div>
        <span className="status-pill">RLS / 即時</span>
      </div>

      <div className="reporting-toolbar">
        <label className="field"><span>營運報表</span><select value={reportName} onChange={(event) => changeReport(event.target.value as ReportName)} disabled={busy}>{reportDefinitions.map((definition) => <option key={definition.name} value={definition.name}>{definition.label}</option>)}</select></label>
        <label className="field"><span>搜尋目前結果</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="輸入單號、品號、名稱、狀態或數量…" /></label>
        <div className="field reporting-refresh"><span>&nbsp;</span><button className="secondary-button" type="button" onClick={() => setReloadToken((value) => value + 1)} disabled={busy}>{busy ? "讀取中…" : "重新整理"}</button></div>
      </div>

      <div className="reporting-description" role="note"><strong>{report.label}</strong><span>{report.description}</span></div>
      <div className="management-catalog-metrics reporting-metrics" aria-label="營運報表摘要">
        <div className="metric"><span>載入筆數</span><strong>{rows.length}</strong><small>目前角色可讀取，最多 200 筆</small></div>
        <div className="metric"><span>符合搜尋</span><strong>{filteredRows.length}</strong><small>{query ? `搜尋「${query}」` : "尚未套用搜尋條件"}</small></div>
        <div className="metric"><span>中文欄位</span><strong>{columns.length}</strong><small>依目前報表定義顯示</small></div>
        <div className="metric"><span>更新時間</span><strong className="reporting-updated-time">{lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—"}</strong><small>按重新整理取得最新 view</small></div>
      </div>

      <div className="management-catalog-result reporting-result">
        <p className="muted" role="status">{message}；符合條件 {sortedRows.length} 筆</p>
        {query ? <button className="text-button product-filter-reset" type="button" onClick={() => { setQuery(""); setPage(1); }}>清除搜尋</button> : null}
      </div>

      <ManagementCatalogTable<ReportRow, string>
        ariaLabel={report.label}
        rows={sortedRows}
        rowKey={(_, index) => `${reportName}-${index}`}
        page={page}
        onPageChange={setPage}
        sortKey={sortColumn ?? ""}
        sortDirection={sortDirection}
        onSort={toggleSort}
        defaultPageSize={25}
        pageSizeOptions={[25, 50, 100]}
        tableClassName="reporting-table"
        emptyState={<p className="empty-state">{busy ? "正在讀取報表…" : "尚無符合條件的資料，或目前帳號沒有此報表的讀取權限。"}</p>}
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
