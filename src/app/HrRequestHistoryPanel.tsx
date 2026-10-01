"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "./ManagementCatalogTable";
import {
  filterHrRequestHistory,
  getDefaultHrRequestDateRange,
  hrRequestStatuses,
  hrRequestStatusLabel,
  sortHrRequestHistory,
  type HrRequestHistoryRow,
  type HrRequestHistorySortDirection,
  type HrRequestHistorySortKey,
  type HrRequestStatusFilter,
} from "@/src/domain/hr-request-history";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import { shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { loadHrRequestHistoryFallback, loadHrRequestHistoryDetailFallback } from "@/src/lib/hr-request-history-fallback";
import { loadOrganizationMasterData } from "@/src/lib/master-data-cache";
import {
  buildPivotTableData,
  generatePivotXlsx,
  downloadPivotXlsx,
  type RawIssueLineInput,
  type ItemStockInfo,
} from "@/src/domain/hr-request-pivot-export";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

type RequestItem = {
  id: string;
  item_id: string;
  item_code_snapshot: string | null;
  item_name_snapshot: string | null;
  unit_snapshot: string | null;
  issue_quantity: number;
  increase_quantity: number;
  requested_transfer_quantity: number;
};

type IssueLine = {
  id: string;
  line_no: number;
  employee_no_snapshot: string | null;
  employee_name_snapshot: string | null;
  institution_code_snapshot: string | null;
  department_code_snapshot: string | null;
  institution_name_snapshot?: string | null;
  department_name_snapshot?: string | null;
  item_code_snapshot: string | null;
  item_name_snapshot: string | null;
  size_snapshot: string | null;
  unit_snapshot: string | null;
  quantity: number;
};

type Reservation = { item_id: string; quantity: number; status: string; closed_at: string | null };

type HistoryRow = {
  id: string;
  request_no: string;
  status: HrRequestHistoryRow["status"];
  distribution_date: string;
  row_version: number;
  created_at: string;
  submitted_at: string | null;
  shipped_at: string | null;
  cancelled_at: string | null;
  note: string | null;
  shipment_no: string | null;
  shipment_status: HrRequestHistoryRow["shipmentStatus"];
  active_reserved_quantity: number;
};

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function HrRequestHistoryPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const [rows, setRows] = useState<HrRequestHistoryRow[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<HrRequestStatusFilter>("ALL");
  const defaultDateRange = useMemo(() => getDefaultHrRequestDateRange(), []);
  const [startDate, setStartDate] = useState(defaultDateRange.startDate);
  const [endDate, setEndDate] = useState(defaultDateRange.endDate);
  const [sortKey, setSortKey] = useState<HrRequestHistorySortKey>("distribution_date");
  const [sortDirection, setSortDirection] = useState<HrRequestHistorySortDirection>("desc");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState("");
  const [items, setItems] = useState<RequestItem[]>([]);
  const [issueLines, setIssueLines] = useState<IssueLine[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [orgMap, setOrgMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rangeExporting, setRangeExporting] = useState(false);
  const [message, setMessage] = useState("");
  const hasSession = isAuthenticated;
  const rowsRef = useRef<HrRequestHistoryRow[]>([]);
  const selectedIdRef = useRef("");
  const refreshScheduledRef = useRef(false);
  const historyReadSequenceRef = useRef(0);
  const detailReadSequenceRef = useRef(0);
  const detailSnapshotRef = useRef<{ requestId: string; items: RequestItem[]; issueLines: IssueLine[]; reservations: Reservation[] } | null>(null);
  const [dataSnapshotAccountId, setDataSnapshotAccountId] = useState<string | null>(null);
  const dataSnapshotAccountIdRef = useRef<string | null>(null);
  const [detailLoadedForRequestId, setDetailLoadedForRequestId] = useState<string | null>(null);

  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const hasCurrentDataSnapshot = Boolean(
    identityReady
      && dataSnapshotAccountId
      && dataSnapshotAccountId === accountId,
  );
  const visibleRows = useMemo(() => hasCurrentDataSnapshot ? rows : [], [hasCurrentDataSnapshot, rows]);
  const dateRangeLabel = useMemo(() => {
    if (startDate && endDate) {
      return startDate === endDate ? startDate : `${startDate} ～ ${endDate}`;
    }
    if (startDate) return `${startDate} 起`;
    if (endDate) return `至 ${endDate}`;
    return "";
  }, [endDate, startDate]);
  const filteredRows = useMemo(
    () => filterHrRequestHistory(visibleRows, query, statusFilter, { startDate, endDate }),
    [endDate, query, startDate, statusFilter, visibleRows],
  );
  const sortedRows = useMemo(() => sortHrRequestHistory(filteredRows, sortKey, sortDirection), [filteredRows, sortDirection, sortKey]);
  const selected = useMemo(() => visibleRows.find((row) => row.id === selectedId) ?? null, [selectedId, visibleRows]);
  const parsedUnitMap = useMemo(() => {
    let map: Record<string, string> = {};
    if (selected?.note) {
      const match = selected.note.match(/<!--unit_map:(.*?)-->/);
      if (match) {
        try {
          map = JSON.parse(match[1]);
        } catch {}
      }
    }
    if (Object.keys(map).length === 0 && selected && typeof window !== "undefined") {
      try {
        const cached = localStorage.getItem(`hr_request_units_${selected.id}`)
          || localStorage.getItem(`hr_request_units_${selected.requestNo}`);
        if (cached) map = JSON.parse(cached);
      } catch {}
    }
    return map;
  }, [selected]);
  const activeReserved = reservations.filter((row) => row.status === "ACTIVE").reduce((sum, row) => sum + numberValue(row.quantity), 0);

  function handleExportSelected() {
    if (!selected) return;
    if (issueLines.length === 0) {
      setMessage("目前選取的需求單沒有發放明細可供匯出。");
      return;
    }
    const rawLines: RawIssueLineInput[] = issueLines.map((line) => {
      const selectedCode = parsedUnitMap[line.line_no] || parsedUnitMap[String(line.line_no)];
      const unitCode = selectedCode || line.department_code_snapshot || line.institution_code_snapshot || "";
      const unitName = (selectedCode && orgMap.get(selectedCode))
        || (unitCode === line.department_code_snapshot ? line.department_name_snapshot : null)
        || (unitCode === line.institution_code_snapshot ? line.institution_name_snapshot : null)
        || orgMap.get(unitCode)
        || line.department_name_snapshot
        || line.institution_name_snapshot
        || unitCode;
      return {
        itemCode: line.item_code_snapshot || "",
        itemName: line.item_name_snapshot || "",
        size: line.size_snapshot || "",
        unit: line.unit_snapshot || "件",
        institutionCodeOrName: unitName || unitCode,
        quantity: numberValue(line.quantity),
      };
    });

    const stockMap = new Map<string, ItemStockInfo>();
    for (const item of items) {
      if (item.item_code_snapshot) {
        stockMap.set(item.item_code_snapshot, {
          itemCode: item.item_code_snapshot,
          increaseQuantity: numberValue(item.increase_quantity),
        });
      }
    }

    const pivotData = buildPivotTableData(rawLines, stockMap);
    const xlsxBytes = generatePivotXlsx(pivotData, {
      title: `${selected.requestNo} 制服領用統計表`,
      dateRangeLabel: selected.distributionDate || dateRangeLabel,
    });

    downloadPivotXlsx(xlsxBytes, `${selected.requestNo}-領用統計表.xlsx`);
    setMessage(`已成功匯出需求單 ${selected.requestNo} 的制服領用統計表 (Excel)`);
  }

  async function handleExportRange() {
    if (!client) {
      setMessage("預覽模式：尚未連接資料庫，無法匯出。");
      return;
    }
    const targetRows = sortedRows.filter((r) => r.status !== "CANCELLED");
    if (targetRows.length === 0) {
      setMessage("目前篩選條件下沒有有效（非取消）的需求單可供匯出。");
      return;
    }
    setRangeExporting(true);
    setMessage(`正在讀取 ${targetRows.length} 張需求單之明細資料以產生彙總表…`);

    try {
      const targetIds = targetRows.map((r) => r.id);
      const [detailResult] = await retrySupabaseQueriesAfterSessionRefresh(
        client,
        async () => [
          await client
            .from("v_hr_request_history_detail")
            .select("request_id,detail_kind,detail_id,item_id,item_code_snapshot,item_name_snapshot,unit_snapshot,issue_quantity,increase_quantity,requested_transfer_quantity,line_no,employee_no_snapshot,employee_name_snapshot,institution_code_snapshot,department_code_snapshot,size_snapshot,quantity,reservation_status,closed_at")
            .in("request_id", targetIds)
            .order("request_id")
            .order("detail_kind")
            .order("line_no"),
        ] as const,
      );

      if (detailResult.error) {
        setMessage(`區間明細讀取失敗：${safeSupabaseReadErrorMessage(detailResult.error)}`);
        setRangeExporting(false);
        return;
      }

      type DetailRow = {
        request_id: string;
        detail_kind: "ITEM" | "ISSUE" | "RESERVATION";
        line_no: number | null;
        item_code_snapshot: string | null;
        item_name_snapshot: string | null;
        size_snapshot: string | null;
        unit_snapshot: string | null;
        quantity: number | null;
        increase_quantity: number | null;
        institution_code_snapshot: string | null;
        department_code_snapshot: string | null;
        institution_name_snapshot?: string | null;
        department_name_snapshot?: string | null;
      };

      const details = (detailResult.data ?? []) as DetailRow[];

      const unitMapByRequestId = new Map<string, Record<string, string>>();
      for (const req of targetRows) {
        let map: Record<string, string> = {};
        if (req.note) {
          const match = req.note.match(/<!--unit_map:(.*?)-->/);
          if (match) {
            try {
              map = JSON.parse(match[1]);
            } catch {}
          }
        }
        if (Object.keys(map).length === 0 && typeof window !== "undefined") {
          try {
            const cached = localStorage.getItem(`hr_request_units_${req.id}`)
              || localStorage.getItem(`hr_request_units_${req.requestNo}`);
            if (cached) map = JSON.parse(cached);
          } catch {}
        }
        unitMapByRequestId.set(req.id, map);
      }

      const rawLines: RawIssueLineInput[] = [];
      const stockMap = new Map<string, ItemStockInfo>();

      for (const d of details) {
        if (d.detail_kind === "ISSUE") {
          const reqUnitMap = unitMapByRequestId.get(d.request_id) || {};
          const lineNo = numberValue(d.line_no);
          const selectedCode = reqUnitMap[lineNo] || reqUnitMap[String(lineNo)];
          const unitCode = selectedCode || d.department_code_snapshot || d.institution_code_snapshot || "";
          const unitName = (selectedCode && orgMap.get(selectedCode))
            || (unitCode === d.department_code_snapshot ? d.department_name_snapshot : null)
            || (unitCode === d.institution_code_snapshot ? d.institution_name_snapshot : null)
            || orgMap.get(unitCode)
            || d.department_name_snapshot
            || d.institution_name_snapshot
            || unitCode;

          rawLines.push({
            itemCode: d.item_code_snapshot || "",
            itemName: d.item_name_snapshot || "",
            size: d.size_snapshot || "",
            unit: d.unit_snapshot || "件",
            institutionCodeOrName: unitName || unitCode,
            quantity: numberValue(d.quantity),
          });
        } else if (d.detail_kind === "ITEM") {
          const itemCode = d.item_code_snapshot;
          if (itemCode) {
            const existing = stockMap.get(itemCode);
            const inc = numberValue(d.increase_quantity);
            stockMap.set(itemCode, {
              itemCode,
              increaseQuantity: (existing?.increaseQuantity || 0) + inc,
            });
          }
        }
      }

      if (rawLines.length === 0) {
        setMessage("選取的區間需求單中沒有任何發放明細。");
        setRangeExporting(false);
        return;
      }

      const pivotData = buildPivotTableData(rawLines, stockMap);
      const rangeTitle = dateRangeLabel ? `平日制服領用統計表（${dateRangeLabel}）` : "平日制服領用統計表";
      const xlsxBytes = generatePivotXlsx(pivotData, {
        title: rangeTitle,
        dateRangeLabel: dateRangeLabel || `${startDate || "全部"} ～ ${endDate || "全部"}`,
      });

      const fileDateStr = `${startDate || "all"}_${endDate || "all"}`;
      downloadPivotXlsx(xlsxBytes, `平日制服領用統計表-${fileDateStr}.xlsx`);
      setMessage(`已成功匯出 ${targetRows.length} 張需求單之彙總領用統計表 (Excel)`);
    } catch (err) {
      setMessage(`匯出發生例外錯誤：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRangeExporting(false);
    }
  }

  async function loadRows(nextSelectedId = selectedIdRef.current) {
    if (!client) return;
    if (identityLoading) return;
    if (identityError || !accountId || !hasSession) {
      historyReadSequenceRef.current += 1;
      detailReadSequenceRef.current += 1;
      rowsRef.current = [];
      setRows([]);
      dataSnapshotAccountIdRef.current = null;
      setDataSnapshotAccountId(null);
      setSelectedId("");
      detailSnapshotRef.current = null;
      setDetailLoadedForRequestId(null);
      setMessage("目前登入帳號尚未完成工作區身份查核，請重新整理後再試。");
      return;
    }
    const readSequence = ++historyReadSequenceRef.current;
    setLoading(true);
    const [historyResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      () => Promise.all([
        client.from("v_hr_request_history")
          .select("id,request_no,status,distribution_date,row_version,created_at,submitted_at,shipped_at,cancelled_at,note,shipment_no,shipment_status,active_reserved_quantity")
          .order("created_at", { ascending: false })
          .limit(500),
      ]),
    );
    if (readSequence !== historyReadSequenceRef.current) return;
    let historyData = historyResult.data;
    let historyError = historyResult.error;

    if (historyError) {
      const fallback = await loadHrRequestHistoryFallback(client);
      if (!fallback.error && fallback.data) {
        historyData = fallback.data as unknown as typeof historyResult.data;
        historyError = null;
      }
    }

    if (historyError) {
      const preserveSnapshot = shouldPreserveReadSnapshot(rowsRef.current, [historyError]);
      const sameAccountSnapshot = dataSnapshotAccountIdRef.current === accountId;
      const canPreserveSnapshot = sameAccountSnapshot && preserveSnapshot;
      if (!canPreserveSnapshot) {
        rowsRef.current = [];
        setRows([]);
        dataSnapshotAccountIdRef.current = null;
        setDataSnapshotAccountId(null);
        setSelectedId("");
        detailSnapshotRef.current = null;
        setDetailLoadedForRequestId(null);
      }
      setMessage(canPreserveSnapshot ? staleReadSnapshotMessage("需求單清單") : `需求單查詢失敗：${safeSupabaseReadErrorMessage(historyError)}`);
      setLoading(false);
      return;
    }
    const loaded = (historyData ?? []).map((row) => {
      const historyRow = row as unknown as HistoryRow;
      return {
        id: historyRow.id,
        requestNo: historyRow.request_no,
        status: historyRow.status,
        distributionDate: historyRow.distribution_date,
        rowVersion: numberValue(historyRow.row_version),
        createdAt: historyRow.created_at,
        submittedAt: historyRow.submitted_at,
        shippedAt: historyRow.shipped_at,
        cancelledAt: historyRow.cancelled_at,
        note: historyRow.note,
        shipmentNo: historyRow.shipment_no,
        shipmentStatus: historyRow.shipment_status,
        activeReservedQuantity: numberValue(historyRow.active_reserved_quantity),
      } satisfies HrRequestHistoryRow;
    });
    const resolvedSelectedId = loaded.some((row) => row.id === nextSelectedId) ? nextSelectedId : "";
    rowsRef.current = loaded;
    setRows(loaded);
    dataSnapshotAccountIdRef.current = accountId;
    setDataSnapshotAccountId(accountId);
    setSelectedId(resolvedSelectedId);
    if (!resolvedSelectedId) {
      detailReadSequenceRef.current += 1;
      detailSnapshotRef.current = null;
      setDetailLoadedForRequestId(null);
      setItems([]);
      setIssueLines([]);
      setReservations([]);
    } else if (resolvedSelectedId === selectedIdRef.current) {
      void loadDetail(resolvedSelectedId);
    }
    setMessage(`已載入 ${loaded.length} 張需求單；狀態、預留與發貨資訊來自目前資料庫。`);
    setLoading(false);
  }

  async function loadDetail(requestId: string) {
    if (!client || !requestId || identityLoading || identityError || !accountId || !hasSession || dataSnapshotAccountIdRef.current !== accountId) return;
    const readSequence = ++detailReadSequenceRef.current;
    const previousSnapshot = detailSnapshotRef.current;
    const sameRequestSnapshot = previousSnapshot?.requestId === requestId;
    if (!sameRequestSnapshot) setDetailLoadedForRequestId(null);
    setDetailLoading(true);
    const [detailResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("v_hr_request_history_detail").select("request_id,detail_kind,detail_id,item_id,item_code_snapshot,item_name_snapshot,unit_snapshot,issue_quantity,increase_quantity,requested_transfer_quantity,line_no,employee_no_snapshot,employee_name_snapshot,institution_code_snapshot,department_code_snapshot,size_snapshot,quantity,reservation_status,closed_at").eq("request_id", requestId).order("detail_kind").order("line_no")] as const,
    );
    if (readSequence !== detailReadSequenceRef.current) return;
    let detailData = detailResult.data;
    let detailError = detailResult.error;

    if (detailError) {
      const fallback = await loadHrRequestHistoryDetailFallback(client, requestId);
      if (!fallback.error && fallback.data) {
        detailData = fallback.data as unknown as typeof detailResult.data;
        detailError = null;
      }
    }

    if (detailError) {
      const snapshotRows = previousSnapshot ? [...previousSnapshot.items, ...previousSnapshot.issueLines, ...previousSnapshot.reservations] : [];
      const preserveSnapshot = sameRequestSnapshot && shouldPreserveReadSnapshot(snapshotRows, [detailError]);
      if (!preserveSnapshot) {
        detailSnapshotRef.current = null;
        setDetailLoadedForRequestId(null);
        setItems([]);
        setIssueLines([]);
        setReservations([]);
      }
      setMessage(preserveSnapshot ? staleReadSnapshotMessage("需求單明細") : `需求單明細載入失敗：${safeSupabaseReadErrorMessage(detailError)}`);
    } else {
      const detailRows = (detailData ?? []) as Array<{
        request_id: string;
        detail_kind: "ITEM" | "ISSUE" | "RESERVATION";
        detail_id: string;
        item_id: string;
        item_code_snapshot: string | null;
        item_name_snapshot: string | null;
        unit_snapshot: string | null;
        issue_quantity: number | null;
        increase_quantity: number | null;
        requested_transfer_quantity: number | null;
        line_no: number | null;
        employee_no_snapshot: string | null;
        employee_name_snapshot: string | null;
        institution_code_snapshot: string | null;
        institution_name_snapshot?: string | null;
        department_code_snapshot: string | null;
        department_name_snapshot?: string | null;
        size_snapshot: string | null;
        quantity: number | null;
        reservation_status: string | null;
        closed_at: string | null;
      }>;
      const nextItems = detailRows.filter((row) => row.detail_kind === "ITEM").map((row) => ({
        id: row.detail_id,
        item_id: row.item_id,
        item_code_snapshot: row.item_code_snapshot,
        item_name_snapshot: row.item_name_snapshot,
        unit_snapshot: row.unit_snapshot,
        issue_quantity: numberValue(row.issue_quantity),
        increase_quantity: numberValue(row.increase_quantity),
        requested_transfer_quantity: numberValue(row.requested_transfer_quantity),
      }));
      const nextIssueLines = detailRows.filter((row) => row.detail_kind === "ISSUE").map((row) => ({
        id: row.detail_id,
        line_no: numberValue(row.line_no),
        employee_no_snapshot: row.employee_no_snapshot,
        employee_name_snapshot: row.employee_name_snapshot,
        institution_code_snapshot: row.institution_code_snapshot,
        institution_name_snapshot: row.institution_name_snapshot ?? null,
        department_code_snapshot: row.department_code_snapshot,
        department_name_snapshot: row.department_name_snapshot ?? null,
        item_code_snapshot: row.item_code_snapshot,
        item_name_snapshot: row.item_name_snapshot,
        size_snapshot: row.size_snapshot,
        unit_snapshot: row.unit_snapshot,
        quantity: numberValue(row.quantity),
      }));
      const nextReservations = detailRows.filter((row) => row.detail_kind === "RESERVATION").map((row) => ({
        item_id: row.item_id,
        quantity: numberValue(row.quantity),
        status: row.reservation_status ?? "CLOSED",
        closed_at: row.closed_at,
      }));
      detailSnapshotRef.current = { requestId, items: nextItems, issueLines: nextIssueLines, reservations: nextReservations };
      setItems(nextItems);
      setIssueLines(nextIssueLines);
      setReservations(nextReservations);
      setDetailLoadedForRequestId(requestId);
    }
    setDetailLoading(false);
  }

  useEffect(() => {
    if (!client || !panelActive) return;
    let active = true;
    loadOrganizationMasterData(client)
      .then((orgData) => {
        if (!active) return;
        const nextMap = new Map<string, string>();
        for (const dept of orgData?.departments ?? []) {
          if (dept.code) nextMap.set(dept.code, dept.name || dept.code);
        }
        for (const inst of orgData?.institutions ?? []) {
          if (inst.code && !nextMap.has(inst.code)) nextMap.set(inst.code, inst.name || inst.code);
        }
        setOrgMap(nextMap);
      })
      .catch(() => {
        // non-blocking master data load
      });
    return () => { active = false; };
  }, [client, panelActive]);

  useEffect(() => {
    if (!client || !panelActive) return;
    let active = true;
    async function loadInitialRows() {
      if (active) await loadRows("");
    }
    void loadInitialRows();
    return () => { active = false; };
    // Initial load waits for the shared workspace identity; the refresh button remains explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, client, hasSession, identityError, identityLoading, panelActive]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!client || !panelActive) return;
    let active = true;
    const refreshHistory = () => {
      if (refreshScheduledRef.current) return;
      refreshScheduledRef.current = true;
      queueMicrotask(() => {
        refreshScheduledRef.current = false;
        if (active && panelActive) void loadRows();
      });
    };
    window.addEventListener(hrRequestWorkflowChangedEvent, refreshHistory);
    return () => {
      active = false;
      refreshScheduledRef.current = false;
      window.removeEventListener(hrRequestWorkflowChangedEvent, refreshHistory);
    };
    // The event listener intentionally uses the current loader; workflow events refresh the read-only view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, client, hasSession, identityError, identityLoading, panelActive]);

  useEffect(() => {
    let active = true;
    async function loadSelectedDetail() {
      if (active && panelActive && selectedId) await loadDetail(selectedId);
    }
    void loadSelectedDetail();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, client, hasSession, identityError, identityLoading, panelActive, selectedId]);

  function toggleSort(nextKey: HrRequestHistorySortKey) {
    if (sortKey === nextKey) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSortKey(nextKey); setSortDirection("asc"); }
    setPage(1);
  }

  if (!client) {
    return <section className="panel" aria-label="人資需求單查詢"><div className="panel-heading"><div><p className="eyebrow">REQUEST HISTORY</p><h2>需求單查詢</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 HR 或倉庫帳號後，這裡會顯示需求單狀態、明細、預留及發貨結果。</p></section>;
  }

  return <section className="panel hr-request-history-panel" aria-label="人資需求單查詢">
    <div className="panel-heading"><div><p className="eyebrow">REQUEST HISTORY</p><h2>需求單查詢與明細</h2></div><span className="status-pill">唯讀查詢</span></div>
    <p className="auth-message">送出後會先保留庫存；倉庫確認完成後才會成為已發放。此清單可追蹤需求、預留、發貨與取消狀態。</p>
    <div className="inventory-toolbar hr-request-history-toolbar">
      <label className="field"><span>搜尋需求單／備註／發貨單</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="例如 HR-2026 或新人" /></label>
      <label className="field"><span>需求狀態</span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as HrRequestStatusFilter); setPage(1); }}><option value="ALL">全部狀態</option>{hrRequestStatuses.map((status) => <option key={status} value={status}>{hrRequestStatusLabel(status)}</option>)}</select></label>
      <label className="field">
        <span>起始日期</span>
        <input
          type="date"
          value={startDate}
          onChange={(event) => { setStartDate(event.target.value); setPage(1); }}
          aria-label="依起始年月日查詢"
        />
      </label>
      <label className="field">
        <span>結束日期</span>
        <input
          type="date"
          value={endDate}
          onChange={(event) => { setEndDate(event.target.value); setPage(1); }}
          aria-label="依結束年月日查詢"
        />
      </label>
      <div className="inventory-toolbar-action" style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
        <button className="secondary-button" type="button" onClick={() => void loadRows()}>{loading ? "讀取中…" : "重新整理"}</button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void handleExportRange()}
          disabled={loading || rangeExporting || sortedRows.length === 0}
          title="匯出目前篩選區間內所有需求單的二維交叉領用統計總表 (Excel)"
        >
          {rangeExporting ? "匯出中…" : "匯出區間領用統計 (Excel)"}
        </button>
      </div>
    </div>
    <div className="management-catalog-result">
      <p className="muted" role="status">{message || "尚未載入"}；符合條件 {sortedRows.length} 張{dateRangeLabel ? `（${dateRangeLabel}）` : ""}</p>
      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
        {(startDate !== defaultDateRange.startDate || endDate !== defaultDateRange.endDate) ? (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setStartDate(defaultDateRange.startDate);
              setEndDate(defaultDateRange.endDate);
              setPage(1);
            }}
          >
            套用預設區間
          </button>
        ) : null}
        {(query || statusFilter !== "ALL" || startDate || endDate) ? (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setQuery("");
              setStatusFilter("ALL");
              setStartDate("");
              setEndDate("");
              setPage(1);
            }}
          >
            清除篩選
          </button>
        ) : null}
      </div>
    </div>
    <ManagementCatalogTable<HrRequestHistoryRow, HrRequestHistorySortKey>
      ariaLabel="人資需求單查詢"
      rows={sortedRows}
      rowKey={(row) => row.id}
      page={page}
      onPageChange={setPage}
      sortKey={sortKey}
      sortDirection={sortDirection}
      onSort={toggleSort}
      loading={loading && visibleRows.length === 0}
      defaultPageSize={10}
      pageSizeOptions={[5, 10, 25, 50]}
      tableClassName="hr-request-history-table"
      emptyState={<p className="empty-state">目前沒有符合條件的需求單。</p>}
      columns={[
        { id: "request", label: "需求單", locked: true, render: (row) => <><strong>{row.requestNo}</strong><span className="table-secondary">發放日 {row.distributionDate}</span></>, sortKey: "request_no" },
        { id: "status", label: "狀態", sortKey: "status", render: (row) => <span className={`status-pill ${row.status === "SHIPPED" ? "success" : row.status === "CANCELLED" ? "danger" : ""}`}>{hrRequestStatusLabel(row.status)}</span> },
        { id: "shipment", label: "發貨", render: (row) => row.shipmentNo ? `${row.shipmentNo}／${row.shipmentStatus === "POSTED" ? "已完成" : "草稿"}` : "尚未建立" },
        { id: "reserved", label: "有效預留", render: (row) => `${row.activeReservedQuantity}`, className: "numeric-cell" },
        { id: "version", label: "版本", sortKey: "row_version", render: (row) => row.rowVersion, className: "numeric-cell" },
        { id: "action", label: "明細", locked: true, render: (row) => <button className="text-button" type="button" onClick={() => setSelectedId(row.id)}>{selectedId === row.id ? "目前明細" : "查看"}</button> },
      ] satisfies readonly ManagementCatalogColumn<HrRequestHistoryRow, HrRequestHistorySortKey>[]}
    />
    {selected ? <div className="panel hr-request-history-detail" aria-live="polite">
      <div className="panel-heading">
        <div><p className="eyebrow">REQUEST DETAIL</p><h3>{selected.requestNo}</h3></div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button
            className="secondary-button"
            type="button"
            onClick={handleExportSelected}
            disabled={detailLoading || issueLines.length === 0}
            title="將此張需求單明細匯出為二維交叉領用統計表 (Excel)"
          >
            匯出此單領用總表 (Excel)
          </button>
          <span className={`status-pill ${selected.status === "SHIPPED" ? "success" : selected.status === "CANCELLED" ? "danger" : ""}`}>{hrRequestStatusLabel(selected.status)}</span>
        </div>
      </div>
      <div className="metric-grid"><div className="metric"><span>發放日期</span><strong>{selected.distributionDate}</strong></div><div className="metric"><span>有效預留</span><strong>{activeReserved}</strong></div><div className="metric"><span>發貨單</span><strong>{selected.shipmentNo ?? "—"}</strong></div><div className="metric"><span>資料版本</span><strong>{selected.rowVersion}</strong></div></div>
      {selected.note ? (() => {
        const cleanNote = selected.note.replace(/<!--unit_map:.*?-->/g, "").trim();
        return cleanNote ? <p className="auth-message">備註：{cleanNote}</p> : null;
      })() : null}
      {detailLoading ? <p className="muted">明細讀取中…</p> : detailLoadedForRequestId !== selectedId ? <p className="auth-message">目前需求的明細尚未載入，請重新整理後再試。</p> : <>
        <h4>品號彙總</h4>
        <div className="summary-list">{items.map((item) => <div className="summary-row" key={item.id}><span><strong>{item.item_code_snapshot ?? item.item_id}</strong><small>{item.item_name_snapshot ?? "制服品號"}／{item.unit_snapshot ?? "—"}</small></span><span>發放 {numberValue(item.issue_quantity)} ＋ 增庫 {numberValue(item.increase_quantity)}</span><strong>需求 {numberValue(item.requested_transfer_quantity)} {item.unit_snapshot ?? "件"}</strong></div>)}</div>
        <h4>發放明細</h4>
        <div className="summary-list">{issueLines.map((line) => {
          const selectedCode = parsedUnitMap[line.line_no] || parsedUnitMap[String(line.line_no)];
          const unitCode = selectedCode || line.department_code_snapshot || line.institution_code_snapshot || "";
          const unitName = (selectedCode && orgMap.get(selectedCode))
            || (unitCode === line.department_code_snapshot ? line.department_name_snapshot : null)
            || (unitCode === line.institution_code_snapshot ? line.institution_name_snapshot : null)
            || orgMap.get(unitCode)
            || line.department_name_snapshot
            || line.institution_name_snapshot
            || "";

          const unitDisplay = unitName && unitName !== unitCode ? `${unitCode}｜${unitName}` : (unitCode || "—");
          return (
            <div className="summary-row" key={line.id}>
              <span>
                <strong>{unitDisplay}</strong>
                <small>{[line.item_code_snapshot ?? "—", line.item_name_snapshot, line.size_snapshot].filter(Boolean).join(" ")}</small>
              </span>
              <strong>{numberValue(line.quantity)} {line.unit_snapshot ?? ""}</strong>
            </div>
          );
        })}</div>
        <p className="muted">預留紀錄：{reservations.length} 筆；有效 {reservations.filter((row) => row.status === "ACTIVE").length} 筆，已關閉／釋放 {reservations.filter((row) => row.status !== "ACTIVE").length} 筆。</p>
      </>}
    </div> : null}
  </section>;
}
