"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "./ManagementCatalogTable";
import {
  filterHrRequestHistory,
  getDefaultHrRequestDateRange,
  hrRequestStatuses,
  hrRequestStatusLabel,
  shiftHrRequestDateRange,
  sortHrRequestHistory,
  type HrRequestHistoryRow,
  type HrRequestHistorySortDirection,
  type HrRequestHistorySortKey,
  type HrRequestStatusFilter,
} from "@/src/domain/hr-request-history";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import { shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import {
  retrySupabaseQueriesAfterSessionRefresh,
  retrySupabaseRpcAfterSessionRefresh,
  safeSupabaseMutationErrorMessage,
  safeSupabaseReadErrorMessage,
} from "@/src/lib/supabase-session";
import { loadHrRequestHistoryFallback, loadHrRequestHistoryDetailFallback } from "@/src/lib/hr-request-history-fallback";
import { loadOrganizationMasterData } from "@/src/lib/master-data-cache";
import { canCancelHrRequest } from "@/src/domain/hr-request-cancellation";
import {
  buildPivotTableData,
  generatePivotXlsx,
  downloadPivotXlsx,
  HR_REQUEST_ALLOWED_DEPARTMENTS,
  type RawIssueLineInput,
  type ItemStockInfo,
} from "@/src/domain/hr-request-pivot-export";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";
import HrRequestDetailModal from "./HrRequestDetailModal";

type RequestItem = {
  id: string;
  item_id: string;
  item_code_snapshot: string | null;
  item_name_snapshot: string | null;
  unit_snapshot: string | null;
  issue_quantity: number;
  increase_quantity: number;
  requested_transfer_quantity: number;
  actual_transfer_quantity?: number | null;
  short_ship_reason_code?: string | null;
  short_ship_reason_label?: string | null;
  short_ship_note?: string | null;
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
  const { client, isAuthenticated, accountId, roles, identityError, identityLoading } = useWorkspaceSession();
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
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelMessage, setCancelMessage] = useState("");
  const cancelOperationsRef = useRef<Map<string, { requestId: string; reason: string; key: string }>>(new Map());
  const cancelFlightRef = useRef(false);
  const [modalOpen, setModalOpen] = useState(false);
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

  async function handleExportRange() {
    if (!client) {
      setMessage("預覽模式：尚未連接資料庫，無法匯出。");
      return;
    }
    const targetRows = sortedRows.filter((r) => r.status !== "CANCELLED");
    if (targetRows.length === 0) {
      setMessage("目前篩選條件下沒有有效（非取消）的需求單或補庫單可供匯出。");
      return;
    }
    setRangeExporting(true);
    const hrRows = targetRows.filter((r) => r.requestType !== "REPLENISHMENT");
    const repRows = targetRows.filter((r) => r.requestType === "REPLENISHMENT");
    setMessage(`正在讀取 ${hrRows.length} 張需求單與 ${repRows.length} 張補庫單之明細資料以產生彙總表…`);

    try {
      const rawLines: RawIssueLineInput[] = [];
      const stockMap = new Map<string, ItemStockInfo>();

      // 1. 處理一般員工需求單 (HR_ISSUE)
      if (hrRows.length > 0) {
        const targetIds = hrRows.map((r) => r.id);
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

        let detailData = detailResult.data;
        let detailError = detailResult.error;

        if (detailError || !detailData || detailData.length === 0) {
          const [linesRes, itemsRes] = await retrySupabaseQueriesAfterSessionRefresh(
            client,
            () => Promise.all([
              client.from("hr_issue_lines").select("*").in("request_id", targetIds).order("line_no"),
              client.from("hr_request_items").select("*").in("request_id", targetIds),
            ]),
          );

          if (!linesRes.error && linesRes.data) {
            const fallbackLines = (linesRes.data as Array<Record<string, unknown>>).map((row) => ({
              request_id: String(row.request_id ?? ""),
              detail_kind: "ISSUE" as const,
              line_no: Number(row.line_no) || 0,
              item_code_snapshot: (row.item_code_snapshot as string) || null,
              item_name_snapshot: (row.item_name_snapshot as string) || null,
              size_snapshot: (row.size_snapshot as string) || null,
              unit_snapshot: (row.unit_snapshot as string) || null,
              quantity: Number(row.quantity) || 0,
              increase_quantity: null,
              institution_code_snapshot: (row.institution_code_snapshot as string) || null,
              department_code_snapshot: (row.department_code_snapshot as string) || null,
              institution_name_snapshot: (row.institution_name_snapshot as string) || null,
              department_name_snapshot: (row.department_name_snapshot as string) || null,
            }));

            const fallbackItems = ((itemsRes.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
              request_id: String(row.request_id ?? ""),
              detail_kind: "ITEM" as const,
              line_no: null,
              item_code_snapshot: (row.item_code_snapshot as string) || null,
              item_name_snapshot: (row.item_name_snapshot as string) || null,
              size_snapshot: null,
              unit_snapshot: (row.unit_snapshot as string) || null,
              quantity: null,
              increase_quantity: Number(row.increase_quantity) || 0,
              institution_code_snapshot: null,
              department_code_snapshot: null,
              institution_name_snapshot: null,
              department_name_snapshot: null,
            }));

            detailData = [...fallbackLines, ...fallbackItems] as unknown as typeof detailResult.data;
            detailError = null;
          }
        }

        if (detailData && detailData.length > 0) {
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

          const details = detailData as DetailRow[];
          const unitMapByRequestId = new Map<string, Record<string, string>>();
          for (const req of hrRows) {
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
                  itemName: d.item_name_snapshot || existing?.itemName || itemCode,
                  unit: d.unit_snapshot || existing?.unit || "件",
                  increaseQuantity: (existing?.increaseQuantity || 0) + inc,
                });
              }
            }
          }
        }
      }

      // 2. 處理額外補庫單 (REPLENISHMENT)
      if (repRows.length > 0) {
        const repIds = repRows.map((r) => r.id);
        const [repLinesRes, catalogRes] = await retrySupabaseQueriesAfterSessionRefresh(
          client,
          () => Promise.all([
            client.from("replenishment_request_lines")
              .select("id,request_id,item_id,requested_quantity,actual_transfer_quantity,item_code_snapshot,item_name_snapshot,unit_snapshot")
              .in("request_id", repIds),
            client.from("uniform_catalog_items")
              .select("id,code,name,unit"),
          ]),
        );

        if (!repLinesRes.error && repLinesRes.data) {
          const itemMap = new Map<string, { code: string; name: string; unit: string }>();
          for (const cat of (catalogRes?.data ?? []) as Array<{ id: string; code: string; name: string; unit: string }>) {
            itemMap.set(cat.id, { code: cat.code, name: cat.name, unit: cat.unit });
          }

          for (const line of repLinesRes.data as Array<Record<string, unknown>>) {
            const itemId = String(line.item_id);
            const cat = itemMap.get(itemId);
            const itemCode = (typeof line.item_code_snapshot === "string" && line.item_code_snapshot) || cat?.code || itemId;
            const itemName = (typeof line.item_name_snapshot === "string" && line.item_name_snapshot) || cat?.name || "補庫品項";
            const unit = (typeof line.unit_snapshot === "string" && line.unit_snapshot) || cat?.unit || "件";
            const inc = numberValue(line.requested_quantity);

            if (itemCode) {
              const existing = stockMap.get(itemCode);
              stockMap.set(itemCode, {
                itemCode,
                itemName: existing?.itemName || itemName,
                unit: existing?.unit || unit,
                increaseQuantity: (existing?.increaseQuantity || 0) + inc,
              });
            }
          }
        }
      }

      // 3. 查詢全量制服品項與當前現有庫存（確保所有庫存制服品項均完整列出）
      const availabilityRes = await client
        .from("v_item_availability")
        .select("item_code, item_name, size, unit, hr_on_hand_quantity")
        .order("item_code");

      if (availabilityRes.data && availabilityRes.data.length > 0) {
        for (const item of availabilityRes.data as Array<Record<string, unknown>>) {
          const itemCode = (typeof item.item_code === "string" && item.item_code.trim()) || "";
          if (!itemCode) continue;
          const itemName = typeof item.item_name === "string" ? item.item_name : itemCode;
          const size = typeof item.size === "string" ? item.size : "";
          const unit = typeof item.unit === "string" ? item.unit : "件";
          const onHand = numberValue(item.hr_on_hand_quantity);
          const existing = stockMap.get(itemCode);
          stockMap.set(itemCode, {
            itemCode,
            itemName: existing?.itemName || itemName,
            size: existing?.size || size,
            unit: existing?.unit || unit,
            onHand: existing?.onHand != null ? existing.onHand : onHand,
            increaseQuantity: existing?.increaseQuantity || 0,
          });
        }
      }

      if (hrRows.length === 0 && repRows.length === 0 && rawLines.length === 0 && stockMap.size === 0) {
        setMessage("選取的區間需求單與補庫單中沒有任何明細資料可供匯出。");
        setRangeExporting(false);
        return;
      }

      const pivotData = buildPivotTableData(rawLines, stockMap);
      const rangeLabel = dateRangeLabel || (startDate && endDate ? `${startDate} ～ ${endDate}` : "");
      const baseTitle = "平日制服領用表";
      const rangeTitle = rangeLabel ? `${baseTitle} ( ${rangeLabel} )` : baseTitle;
      const xlsxBytes = generatePivotXlsx(pivotData, {
        title: rangeTitle,
        dateRangeLabel: rangeLabel,
      });

      const fileDateStr = `${startDate || "all"}_${endDate || "all"}`;
      downloadPivotXlsx(xlsxBytes, `平日制服領用表-${fileDateStr}.xlsx`);
      setMessage(`已成功匯出 ${hrRows.length} 張需求單與 ${repRows.length} 張補庫單之平日制服領用表 (Excel)`);
    } catch (err) {
      setMessage(`匯出發生例外錯誤：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRangeExporting(false);
    }
  }

  async function cancelSelectedRequest(): Promise<{ success: boolean; message: string }> {
    if (!client || !identityReady || !selected || !accountId || cancelFlightRef.current
      || !canCancelHrRequest(selected.status, roles)) return { success: false, message: "無權限或無法取消。" };
    const requestId = selected.id;
    const actorAccountId = accountId;
    const operationId = `${actorAccountId}:${requestId}`;
    const previous = cancelOperationsRef.current.get(operationId);
    const reason = previous?.reason ?? cancelReason.trim();
    if (!reason) { setCancelMessage("請填寫取消原因。"); return { success: false, message: "請填寫取消原因。" }; }
    const operation = previous ?? { requestId, reason, key: `CANCEL-HR-${crypto.randomUUID()}` };
    cancelOperationsRef.current.set(operationId, operation);
    cancelFlightRef.current = true;
    setCancelling(true);
    setCancelMessage("");
    try {
      const { data, error } = await retrySupabaseRpcAfterSessionRefresh(client, async () => await client.rpc("cancel_hr_request", {
        p_request_id: operation.requestId,
        p_reason: operation.reason,
        p_idempotency_key: operation.key,
        p_request_fingerprint: JSON.stringify({ requestId: operation.requestId, reason: operation.reason }),
      }));
      if (dataSnapshotAccountIdRef.current !== actorAccountId) return { success: false, message: "工作區變更。" };
      if (error || data?.id !== requestId || data?.status !== "CANCELLED") {
        const errorMsg = safeSupabaseMutationErrorMessage(error, "取消結果尚未確認；請使用相同資料重試。");
        setCancelMessage(errorMsg);
        return { success: false, message: errorMsg };
      }
      cancelOperationsRef.current.delete(operationId);
      setCancelReason("");
      const okMsg = "需求已取消，預留已釋放；歷史資料保留。";
      setCancelMessage(okMsg);
      window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
      void loadRows();
      return { success: true, message: okMsg };
    } catch {
      const errorMsg = "取消結果尚未確認；請使用相同資料重試。";
      setCancelMessage(errorMsg);
      return { success: false, message: errorMsg };
    } finally {
      cancelFlightRef.current = false;
      setCancelling(false);
    }
  }

  async function handleCancelFromModal(reason: string): Promise<{ success: boolean; message?: string }> {
    if (!selected || !accountId) return { success: false, message: "無選取需求單" };
    const operationId = `${accountId}:${selected.id}`;
    cancelOperationsRef.current.set(operationId, {
      requestId: selected.id,
      reason: reason.trim(),
      key: `CANCEL-HR-${crypto.randomUUID()}`,
    });
    setCancelReason(reason.trim());
    return await cancelSelectedRequest();
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
    const [historyResult, replenishmentResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      () => Promise.all([
        client.from("v_hr_request_history")
          .select("id,request_no,status,distribution_date,row_version,created_at,submitted_at,shipped_at,cancelled_at,note,shipment_no,shipment_status,active_reserved_quantity")
          .order("created_at", { ascending: false })
          .limit(500),
        client.from("replenishment_requests")
          .select("id,request_no,status,row_version,created_at,submitted_at,shipped_at,cancelled_at,note")
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
    const hrLoaded: HrRequestHistoryRow[] = (historyData ?? []).map((row) => {
      const historyRow = row as unknown as HistoryRow;
      return {
        id: historyRow.id,
        requestType: "HR_ISSUE",
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
      };
    });
    const replenishmentLoaded: HrRequestHistoryRow[] = ((replenishmentResult?.data ?? []) as Array<Record<string, unknown>>).map((rep) => ({
      id: String(rep.id),
      requestType: "REPLENISHMENT",
      requestNo: String(rep.request_no),
      status: (rep.status as HrRequestHistoryRow["status"]) || "DRAFT",
      distributionDate: String(rep.submitted_at ?? rep.created_at ?? "").slice(0, 10),
      rowVersion: numberValue(rep.row_version),
      createdAt: String(rep.created_at ?? ""),
      submittedAt: rep.submitted_at ? String(rep.submitted_at) : null,
      shippedAt: rep.shipped_at ? String(rep.shipped_at) : null,
      cancelledAt: rep.cancelled_at ? String(rep.cancelled_at) : null,
      note: rep.note ? String(rep.note) : null,
      shipmentNo: null,
      shipmentStatus: null,
      activeReservedQuantity: 0,
    }));
    const loaded = [...hrLoaded, ...replenishmentLoaded].sort((a, b) => {
      return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
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
    setMessage(`已載入 ${hrLoaded.length} 張需求單、${replenishmentLoaded.length} 張補庫單；狀態、預留與發貨資訊來自目前資料庫。`);
    setLoading(false);
  }

  async function loadDetail(requestId: string) {
    if (!client || !requestId || identityLoading || identityError || !accountId || !hasSession || dataSnapshotAccountIdRef.current !== accountId) return;
    const readSequence = ++detailReadSequenceRef.current;
    const previousSnapshot = detailSnapshotRef.current;
    const sameRequestSnapshot = previousSnapshot?.requestId === requestId;
    if (!sameRequestSnapshot) setDetailLoadedForRequestId(null);
    setDetailLoading(true);

    const targetRow = rowsRef.current.find((r) => r.id === requestId);
    if (targetRow?.requestType === "REPLENISHMENT") {
      const [linesResult, catalogResult, reasonsResult] = await retrySupabaseQueriesAfterSessionRefresh(
        client,
        async () => [
          await client.from("replenishment_request_lines")
            .select("id,request_id,item_id,requested_quantity,actual_transfer_quantity,short_ship_reason_code,item_code_snapshot,item_name_snapshot,unit_snapshot")
            .eq("request_id", requestId),
          await client.from("uniform_catalog_items")
            .select("id,code,name,unit"),
          await client.from("transfer_short_ship_reasons")
            .select("code,label"),
        ] as const,
      );
      if (readSequence !== detailReadSequenceRef.current) return;
      if (linesResult.error) {
        setMessage(`補庫單明細載入失敗：${safeSupabaseReadErrorMessage(linesResult.error)}`);
      } else {
        const itemMap = new Map<string, { code: string; name: string; unit: string }>();
        for (const cat of (catalogResult?.data ?? []) as Array<{ id: string; code: string; name: string; unit: string }>) {
          itemMap.set(cat.id, { code: cat.code, name: cat.name, unit: cat.unit });
        }
        const reasonMap = new Map<string, string>();
        for (const r of (reasonsResult?.data ?? []) as Array<{ code: string; label: string }>) {
          reasonMap.set(r.code, r.label);
        }
        const lines = (linesResult.data ?? []) as Array<Record<string, unknown>>;
        const nextItems = lines.map((l) => {
          const itemId = String(l.item_id);
          const cat = itemMap.get(itemId);
          const itemCode = typeof l.item_code_snapshot === "string" && l.item_code_snapshot ? l.item_code_snapshot : (cat?.code ?? itemId);
          const itemName = typeof l.item_name_snapshot === "string" && l.item_name_snapshot ? l.item_name_snapshot : (cat?.name ?? "補庫品項");
          const unit = typeof l.unit_snapshot === "string" && l.unit_snapshot ? l.unit_snapshot : (cat?.unit ?? "件");
          const qty = numberValue(l.requested_quantity);
          const actualQty = l.actual_transfer_quantity != null ? numberValue(l.actual_transfer_quantity) : null;
          const shortCode = typeof l.short_ship_reason_code === "string" ? l.short_ship_reason_code : null;
          return {
            id: String(l.id),
            item_id: itemId,
            item_code_snapshot: itemCode,
            item_name_snapshot: itemName,
            unit_snapshot: unit,
            issue_quantity: 0,
            increase_quantity: qty,
            requested_transfer_quantity: qty,
            actual_transfer_quantity: actualQty,
            short_ship_reason_code: shortCode,
            short_ship_reason_label: shortCode ? (reasonMap.get(shortCode) ?? shortCode) : null,
            short_ship_note: null,
          };
        });
        setItems(nextItems);
        setIssueLines([]);
        setReservations([]);
        detailSnapshotRef.current = { requestId, items: nextItems, issueLines: [], reservations: [] };
        setDetailLoadedForRequestId(requestId);
      }
      setDetailLoading(false);
      return;
    }

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
      // 載入該需求單之發貨單明細以比對實發調庫量與短發資訊
      const shipmentLineMap = new Map<string, {
        actual_transfer_quantity: number | null;
        short_ship_reason_code: string | null;
        short_ship_reason_label: string | null;
        short_ship_note: string | null;
      }>();
      try {
        const [shipmentLinesRes, reasonsRes] = await retrySupabaseQueriesAfterSessionRefresh(
          client,
          async () => [
            await client
              .from("warehouse_shipment_lines")
              .select("id, hr_request_item_id, item_id, actual_transfer_quantity, short_ship_reason_code, shipment_id")
              .eq("hr_request_id", requestId),
            await client
              .from("transfer_short_ship_reasons")
              .select("code, label"),
          ] as const,
        );
        const reasonMap = new Map<string, string>();
        for (const r of (reasonsRes?.data ?? []) as Array<{ code: string; label: string }>) {
          reasonMap.set(r.code, r.label);
        }
        let notesMap: Record<string, string> = {};
        const linesData = (shipmentLinesRes?.data ?? []) as Array<{
          id: string;
          hr_request_item_id: string;
          item_id: string;
          actual_transfer_quantity: number | null;
          short_ship_reason_code: string | null;
          shipment_id: string;
        }>;
        const shipIds = Array.from(new Set(linesData.map((l) => l.shipment_id).filter(Boolean)));
        if (shipIds.length > 0) {
          const { data: shipsData } = await client
            .from("warehouse_shipments")
            .select("id, note")
            .in("id", shipIds);
          for (const s of (shipsData ?? []) as Array<{ id: string; note: string | null }>) {
            if (s.note) {
              const match = s.note.match(/<!--short_ship_notes:(.*?)-->/);
              if (match && match[1]) {
                try {
                  notesMap = { ...notesMap, ...JSON.parse(match[1]) };
                } catch {}
              }
            }
          }
        }
        for (const sl of linesData) {
          const info = {
            actual_transfer_quantity: sl.actual_transfer_quantity != null ? numberValue(sl.actual_transfer_quantity) : null,
            short_ship_reason_code: sl.short_ship_reason_code ?? null,
            short_ship_reason_label: (sl.short_ship_reason_code ? reasonMap.get(sl.short_ship_reason_code) : null) ?? sl.short_ship_reason_code ?? null,
            short_ship_note: notesMap[sl.id] ?? null,
          };
          if (sl.hr_request_item_id) shipmentLineMap.set(sl.hr_request_item_id, info);
          if (sl.item_id) shipmentLineMap.set(sl.item_id, info);
        }
      } catch (e) {
        console.warn("Could not load warehouse shipment line details for request:", e);
      }

      const nextItems = detailRows.filter((row) => row.detail_kind === "ITEM").map((row) => {
        const shipInfo = shipmentLineMap.get(row.detail_id) ?? shipmentLineMap.get(row.item_id);
        return {
          id: row.detail_id,
          item_id: row.item_id,
          item_code_snapshot: row.item_code_snapshot,
          item_name_snapshot: row.item_name_snapshot,
          unit_snapshot: row.unit_snapshot,
          issue_quantity: numberValue(row.issue_quantity),
          increase_quantity: numberValue(row.increase_quantity),
          requested_transfer_quantity: numberValue(row.requested_transfer_quantity),
          actual_transfer_quantity: shipInfo?.actual_transfer_quantity ?? null,
          short_ship_reason_code: shipInfo?.short_ship_reason_code ?? null,
          short_ship_reason_label: shipInfo?.short_ship_reason_label ?? null,
          short_ship_note: shipInfo?.short_ship_note ?? null,
        };
      });
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
        for (const dept of HR_REQUEST_ALLOWED_DEPARTMENTS) {
          nextMap.set(dept.code, dept.name);
        }
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

  function handleCycleShift(direction: "prev" | "next" | "current") {
    const nextRange = shiftHrRequestDateRange(endDate, direction);
    setStartDate(nextRange.startDate);
    setEndDate(nextRange.endDate);
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
      <div className="field" style={{ minWidth: "auto", alignSelf: "flex-end" }}>
        <span style={{ fontSize: "12px", color: "var(--muted)", marginBottom: "4px" }}>月份週期</span>
        <div style={{ display: "flex", gap: "4px" }}>
          <button
            className="secondary-button"
            type="button"
            style={{ padding: "6px 10px", fontSize: "13px", height: "36px", whiteSpace: "nowrap" }}
            onClick={() => handleCycleShift("prev")}
            title="切換至上一個月份週期（上月21日～當月20日）"
          >
            ◀ 上期
          </button>
          <button
            className="secondary-button"
            type="button"
            style={{ padding: "6px 10px", fontSize: "13px", height: "36px", whiteSpace: "nowrap" }}
            onClick={() => handleCycleShift("current")}
            title="回到目前所屬的當前週期"
          >
            本期
          </button>
          <button
            className="secondary-button"
            type="button"
            style={{ padding: "6px 10px", fontSize: "13px", height: "36px", whiteSpace: "nowrap" }}
            onClick={() => handleCycleShift("next")}
            title="切換至下一個月份週期"
          >
            下期 ▶
          </button>
        </div>
      </div>
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
        {
          id: "request",
          label: "需求單",
          locked: true,
          render: (row) => (
            <>
              <div>
                {row.requestType === "REPLENISHMENT" ? (
                  <span style={{ display: "inline-block", marginRight: 6, fontSize: "0.75rem", padding: "1px 6px", background: "#e0f2fe", color: "#0369a1", borderRadius: 4, fontWeight: 600 }}>
                    額外補庫
                  </span>
                ) : null}
                <strong>{row.requestNo}</strong>
              </div>
              <span className="table-secondary">{row.requestType === "REPLENISHMENT" ? "申請日" : "發放日"} {row.distributionDate}</span>
            </>
          ),
          sortKey: "request_no",
        },
        { id: "status", label: "狀態", sortKey: "status", render: (row) => <span className={`status-pill ${row.status === "SHIPPED" ? "success" : row.status === "CANCELLED" ? "danger" : ""}`}>{hrRequestStatusLabel(row.status)}</span> },
        { id: "shipment", label: "發貨", render: (row) => row.requestType === "REPLENISHMENT" ? "直接調撥增庫" : (row.shipmentNo ? `${row.shipmentNo}／${row.shipmentStatus === "POSTED" ? "已完成" : "草稿"}` : "尚未建立") },
        { id: "reserved", label: "有效預留", render: (row) => row.requestType === "REPLENISHMENT" ? "—" : `${row.activeReservedQuantity}`, className: "numeric-cell" },
        { id: "version", label: "版本", sortKey: "row_version", render: (row) => row.rowVersion, className: "numeric-cell" },
        {
          id: "action",
          label: "明細",
          locked: true,
          render: (row) => (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setSelectedId(row.id);
                setModalOpen(true);
              }}
            >
              查看明細
            </button>
          ),
        },
      ] satisfies readonly ManagementCatalogColumn<HrRequestHistoryRow, HrRequestHistorySortKey>[]}
    />
    <HrRequestDetailModal
      isOpen={modalOpen && Boolean(selected)}
      onClose={() => setModalOpen(false)}
      client={client}
      sourceNo={selected?.requestNo ?? ""}
      postingId={selected?.id}
      postingKind={selected?.requestType === "REPLENISHMENT" ? "REPLENISHMENT" : undefined}
      canCancel={Boolean(selected && canCancelHrRequest(selected.status, roles))}
      onCancel={handleCancelFromModal}
    />
  </section>;
}
