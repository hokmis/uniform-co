"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  normalizeCatalogPageSize,
  resolveCatalogPageWindow,
  resolveVisibleCatalogColumnIds,
  toggleCatalogColumnId,
} from "@/src/domain/management-catalog";

export type ManagementCatalogColumn<Row, SortKey extends string> = {
  id: string;
  label: string;
  render: (row: Row) => ReactNode;
  sortKey?: SortKey;
  className?: string;
  defaultVisible?: boolean;
  locked?: boolean;
};

type Props<Row, SortKey extends string> = {
  ariaLabel: string;
  rows: readonly Row[];
  rowKey: (row: Row, absoluteIndex: number) => string;
  columns: readonly ManagementCatalogColumn<Row, SortKey>[];
  page: number;
  onPageChange: (page: number) => void;
  sortKey: SortKey;
  sortDirection: "asc" | "desc";
  onSort: (key: SortKey) => void;
  emptyState: ReactNode;
  defaultPageSize?: number;
  pageSizeOptions?: readonly number[];
  tableClassName?: string;
};

export default function ManagementCatalogTable<Row, SortKey extends string>({
  ariaLabel,
  rows,
  rowKey,
  columns,
  page,
  onPageChange,
  sortKey,
  sortDirection,
  onSort,
  emptyState,
  defaultPageSize = 25,
  pageSizeOptions = [10, 25, 50, 100],
  tableClassName = "",
}: Props<Row, SortKey>) {
  const columnIds = useMemo(() => columns.map((column) => column.id), [columns]);
  const lockedIds = useMemo(() => columns.filter((column) => column.locked).map((column) => column.id), [columns]);
  const defaultVisibleIds = useMemo(
    () => resolveVisibleCatalogColumnIds(columnIds, columns.filter((column) => column.defaultVisible !== false).map((column) => column.id), lockedIds),
    [columnIds, columns, lockedIds],
  );
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set(defaultVisibleIds));
  const [pageSize, setPageSize] = useState(() => normalizeCatalogPageSize(defaultPageSize, pageSizeOptions, defaultPageSize));
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const window = resolveCatalogPageWindow(rows.length, page, pageSize);
  const visibleColumns = columns.filter((column) => visibleIds.has(column.id) || column.locked);
  const pageRows = rows.slice((window.currentPage - 1) * pageSize, window.currentPage * pageSize);

  function setAllColumnsVisible() {
    setVisibleIds(new Set(columnIds));
  }

  function resetColumns() {
    setVisibleIds(new Set(defaultVisibleIds));
  }

  function changePageSize(value: number) {
    setPageSize(normalizeCatalogPageSize(value, pageSizeOptions, defaultPageSize));
    onPageChange(1);
  }

  function sortMark(key: SortKey) {
    if (sortKey !== key) return "↕";
    return sortDirection === "asc" ? "↑" : "↓";
  }

  if (rows.length === 0) return <>{emptyState}</>;

  return (
    <div className={`management-catalog-browser management-catalog-browser--${density}`}>
      <div className="management-catalog-viewbar" aria-label={`${ariaLabel}顯示設定`}>
        <p className="muted" aria-live="polite">顯示第 {window.start}–{window.end} 筆，共 {rows.length} 筆</p>
        <div className="management-catalog-view-actions">
          <label>
            <span>每頁</span>
            <select value={pageSize} onChange={(event) => changePageSize(Number(event.target.value))}>
              {pageSizeOptions.map((size) => <option key={size} value={size}>{size} 筆</option>)}
            </select>
          </label>
          <button className="secondary-button management-density-button" type="button" onClick={() => setDensity((value) => value === "comfortable" ? "compact" : "comfortable")}>
            {density === "comfortable" ? "緊湊顯示" : "舒適顯示"}
          </button>
          <details className="management-column-settings">
            <summary className="secondary-button">欄位顯示</summary>
            <div className="management-column-popover">
              <div className="management-column-popover-heading"><strong>顯示欄位</strong><button type="button" onClick={setAllColumnsVisible}>全部顯示</button></div>
              {columns.map((column) => <label key={column.id}>
                <input
                  type="checkbox"
                  checked={visibleIds.has(column.id) || column.locked}
                  disabled={column.locked}
                  onChange={() => setVisibleIds((current) => new Set(toggleCatalogColumnId(columnIds, current, column.id, lockedIds)))}
                />
                <span>{column.label}</span>
                {column.locked ? <small>固定</small> : null}
              </label>)}
              <button className="text-button management-column-reset" type="button" onClick={resetColumns}>恢復預設欄位</button>
            </div>
          </details>
        </div>
      </div>

      <div className={`table-scroll management-catalog-table ${tableClassName}`.trim()}>
        <table>
          <thead><tr>{visibleColumns.map((column) => <th key={column.id} className={column.className} aria-sort={column.sortKey && sortKey === column.sortKey ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}>
            {column.sortKey
              ? <button className="table-sort-button" type="button" onClick={() => onSort(column.sortKey as SortKey)}>{column.label} {sortMark(column.sortKey)}</button>
              : column.label}
          </th>)}</tr></thead>
          <tbody>{pageRows.map((row, index) => <tr key={rowKey(row, (window.currentPage - 1) * pageSize + index)}>{visibleColumns.map((column) => <td key={column.id} className={column.className}>{column.render(row)}</td>)}</tr>)}</tbody>
        </table>
      </div>

      <div className="management-pagination" aria-label={`${ariaLabel}分頁`}>
        <span>第 {window.currentPage}／{window.pageCount} 頁</span>
        <div>
          <button className="secondary-button" type="button" disabled={window.currentPage <= 1} onClick={() => onPageChange(1)}>第一頁</button>
          <button className="secondary-button" type="button" disabled={window.currentPage <= 1} onClick={() => onPageChange(window.currentPage - 1)}>上一頁</button>
          <button className="secondary-button" type="button" disabled={window.currentPage >= window.pageCount} onClick={() => onPageChange(window.currentPage + 1)}>下一頁</button>
          <button className="secondary-button" type="button" disabled={window.currentPage >= window.pageCount} onClick={() => onPageChange(window.pageCount)}>最後頁</button>
        </div>
      </div>
    </div>
  );
}
