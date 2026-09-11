"use client";

import { useMemo, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "@/src/app/ManagementCatalogTable";
import {
  ALL_CORRECTION_HISTORY_STATUSES,
  correctionHistoryStatusLabel,
  correctionHistoryStatuses,
  filterCorrectionHistory,
  sortCorrectionHistory,
  type CorrectionHistoryRow,
  type CorrectionHistorySortDirection,
  type CorrectionHistorySortKey,
} from "@/src/domain/correction-history";

type Props = {
  ariaLabel: string;
  rows: readonly CorrectionHistoryRow[];
  deltaLabel: string;
};

function formatPostedAt(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Taipei" }).format(date);
}

export default function CorrectionHistoryTable({ ariaLabel, rows, deltaLabel }: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(ALL_CORRECTION_HISTORY_STATUSES);
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<CorrectionHistorySortKey>("correction_no");
  const [sortDirection, setSortDirection] = useState<CorrectionHistorySortDirection>("desc");
  const statuses = useMemo(() => correctionHistoryStatuses(rows), [rows]);
  const selectedStatus = status === ALL_CORRECTION_HISTORY_STATUSES || statuses.includes(status) ? status : ALL_CORRECTION_HISTORY_STATUSES;
  const filteredRows = useMemo(() => filterCorrectionHistory(rows, query, selectedStatus), [rows, query, selectedStatus]);
  const sortedRows = useMemo(() => sortCorrectionHistory(filteredRows, sortKey, sortDirection), [filteredRows, sortDirection, sortKey]);

  function handleQueryChange(value: string) {
    setQuery(value);
    setPage(1);
  }

  function handleStatusChange(value: string) {
    setStatus(value);
    setPage(1);
  }

  function handleSort(nextKey: CorrectionHistorySortKey) {
    if (sortKey === nextKey) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSortKey(nextKey); setSortDirection("asc"); }
    setPage(1);
  }

  function clearFilters() {
    setQuery("");
    setStatus(ALL_CORRECTION_HISTORY_STATUSES);
    setPage(1);
  }

  const columns: readonly ManagementCatalogColumn<CorrectionHistoryRow, CorrectionHistorySortKey>[] = [
    { id: "correction_no", label: "更正單號", sortKey: "correction_no", render: (row) => row.correctionNo, locked: true },
    { id: "status", label: "狀態", sortKey: "status", render: (row) => correctionHistoryStatusLabel(row.status) },
    { id: "delta", label: deltaLabel, sortKey: "delta", render: (row) => row.deltaText },
    { id: "reason", label: "原因", sortKey: "reason", render: (row) => row.reason },
    { id: "posted_at", label: "過帳時間", sortKey: "posted_at", render: (row) => formatPostedAt(row.postedAt), defaultVisible: false },
  ];

  return <div className="correction-history-browser">
    <div className="correction-history-heading">
      <div><h3>更正歷史</h3><p className="muted">只讀取目前來源明細的更正紀錄；草稿與已過帳資料都可查詢。</p></div>
      <span className="status-pill">共 {rows.length} 筆</span>
    </div>
    <div className="management-catalog-filters correction-history-filters">
      <label className="field"><span>搜尋更正單號／原因</span><input value={query} onChange={(event) => handleQueryChange(event.target.value)} placeholder="輸入關鍵字" /></label>
      <label className="field"><span>狀態</span><select value={selectedStatus} onChange={(event) => handleStatusChange(event.target.value)}><option value={ALL_CORRECTION_HISTORY_STATUSES}>全部狀態</option>{statuses.map((value) => <option key={value} value={value}>{correctionHistoryStatusLabel(value)}</option>)}</select></label>
    </div>
    <div className="management-catalog-result"><p className="muted" aria-live="polite">符合篩選：{filteredRows.length} 筆</p>{query || selectedStatus !== ALL_CORRECTION_HISTORY_STATUSES ? <button className="text-button" type="button" onClick={clearFilters}>清除篩選</button> : null}</div>
    <ManagementCatalogTable
      ariaLabel={ariaLabel}
      rows={sortedRows}
      rowKey={(row) => row.id}
      columns={columns}
      page={page}
      onPageChange={setPage}
      sortKey={sortKey}
      sortDirection={sortDirection}
      onSort={handleSort}
      defaultPageSize={10}
      pageSizeOptions={[5, 10, 25, 50]}
      emptyState={<p className="empty-state">{rows.length === 0 ? "尚無此來源的更正紀錄。" : "沒有符合目前篩選的更正紀錄。"}</p>}
      tableClassName="correction-history-table"
    />
  </div>;
}
