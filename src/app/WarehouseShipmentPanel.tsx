"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "@/src/app/ManagementCatalogTable";
import { canRefreshWarehouseShipmentQueue, changedWarehouseShipmentLines, filterWarehouseShipmentQueue, isWarehousePostConfirmed, sortWarehouseShipmentQueue, type WarehouseShipmentLineEdit, type WarehouseShipmentQueueRow, type WarehouseShipmentSortDirection, type WarehouseShipmentSortKey } from "@/src/domain/warehouse-shipment";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import { retrySupabaseQueriesAfterSessionRefresh } from "@/src/lib/supabase-session";
import { attemptOptionalRpc } from "@/src/lib/optional-rpc";
import { loadReplenishmentShipmentLines } from "@/src/lib/replenishment-shipment-read";
import { loadWarehouseShipmentQueue, type WarehouseShipmentQueueReadRow } from "@/src/lib/warehouse-shipment-queue-read";
import { loadWarehouseShipmentLines } from "@/src/lib/warehouse-shipment-read";
import { createReadRequestController, type ReadRequestController } from "@/src/domain/read-refresh";
import { useWorkspaceSession } from "./workspace-session";
import { usePanelActivity } from "./RetainedPanelSet";
import WorkflowActionBar from "./WorkflowActionBar";

type ShipmentLine = WarehouseShipmentLineEdit & {
  item_id: string;
  hr_request_item_id: string | null;
  item_code_snapshot: string | null;
  item_name_snapshot: string | null;
  unit_snapshot: string | null;
  requested_transfer_quantity_snapshot: number;
  maximum_transfer_quantity_snapshot: number;
  actual_transfer_quantity: number;
  short_ship_reason_code: string | null;
};

type Reason = { code: string; label: string };
type CreatedShipment = { id: string; shipment_no: string | null; created_by: string | null; lines: ShipmentLine[] };
type WarehousePostPayload = { id?: unknown; status?: unknown; shipment_no?: string | null; request_no?: string | null };
type WarehousePostResult = { data: WarehousePostPayload | null; error: { code?: string; message?: string } | null };
const shipmentOperationStoragePrefix = "uniform:warehouse-shipment-operation";

export default function WarehouseShipmentPanel() {
  const { client, accountId, identityError, identityLoading, isAuthenticated } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [requests, setRequests] = useState<WarehouseShipmentQueueReadRow[]>([]);
  const [requestKey, setRequestKey] = useState("");
  const [shipmentId, setShipmentId] = useState("");
  const [shipmentNo, setShipmentNo] = useState("");
  const [shipmentOwnerId, setShipmentOwnerId] = useState("");
  const [lines, setLines] = useState<ShipmentLine[]>([]);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [queueQuery, setQueueQuery] = useState("");
  const [queuePage, setQueuePage] = useState(1);
  const [queueSortKey, setQueueSortKey] = useState<WarehouseShipmentSortKey>("distribution_date");
  const [queueSortDirection, setQueueSortDirection] = useState<WarehouseShipmentSortDirection>("asc");
  const [queueReloadToken, setQueueReloadToken] = useState(0);
  const [queueLoading, setQueueLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const persistedLinesRef = useRef<ShipmentLine[]>([]);
  const queueReadControllerRef = useRef<ReadRequestController | null>(null);
  const detailsReadControllerRef = useRef<ReadRequestController | null>(null);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const requestKeyRef = useRef("");

  const queueRows: WarehouseShipmentQueueRow[] = useMemo(() => requests.map((request) => ({
    id: request.queue_key,
    source: request.source,
    requestNo: request.request_no,
    distributionDate: request.distribution_date,
    rowVersion: request.row_version,
    shipmentStatus: request.shipment_status ?? "READY",
    shipmentNo: request.shipment_no,
  })), [requests]);
  const filteredQueueRows = useMemo(() => filterWarehouseShipmentQueue(queueRows, queueQuery), [queueQuery, queueRows]);
  const sortedQueueRows = useMemo(() => sortWarehouseShipmentQueue(filteredQueueRows, queueSortKey, queueSortDirection), [filteredQueueRows, queueSortDirection, queueSortKey]);
  const selectedRequest = useMemo(() => requests.find((request) => request.queue_key === requestKey), [requestKey, requests]);
  const canEditShipment = !shipmentId || shipmentOwnerId === accountId;
  const canRefreshQueue = canRefreshWarehouseShipmentQueue({ queueLoading, detailsLoading, busy, draftDirty });

  function sortQueue(nextKey: WarehouseShipmentSortKey) {
    if (queueSortKey === nextKey) setQueueSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setQueueSortKey(nextKey); setQueueSortDirection("asc"); }
    setQueuePage(1);
  }

  useEffect(() => {
    requestKeyRef.current = requestKey;
  }, [requestKey]);

  useEffect(() => {
    if (!identityReady || !client) return;
    const supabase = client;
    const readController = queueReadControllerRef.current ?? createReadRequestController();
    queueReadControllerRef.current = readController;
    const readSequence = readController.begin();
    let active = true;
    async function load() {
      setQueueLoading(true);
      try {
        const [queueResult, reasonRead] = await Promise.all([
          loadWarehouseShipmentQueue(supabase),
          retrySupabaseQueriesAfterSessionRefresh(
            supabase,
            async () => [await supabase.from("transfer_short_ship_reasons")
              .select("code,label")
              .eq("is_active", true)
              .order("sort_order")] as const,
          ),
        ]);
        const [reasonResult] = reasonRead;
        if (!active || !readController.isCurrent(readSequence)) return;
        if (queueResult.error || reasonResult.error) {
          setMessage("無法載入待發貨需求，請確認倉庫角色與資料權限。");
          return;
        }
        const loaded = queueResult.data;
        setRequests(loaded);
        setReasons((reasonResult.data ?? []) as Reason[]);
        // Do not mark the first row as active before its details are loaded.
        // If a refresh removes the selected source, clear the editor as well so
        // the right pane never presents stale lines for an unselected request.
        if (!loaded.some((request) => request.queue_key === requestKeyRef.current)) {
          detailsReadControllerRef.current?.invalidate();
          setDetailsLoading(false);
          setRequestKey("");
          setShipmentId("");
          setShipmentNo("");
          setShipmentOwnerId("");
          setLines([]);
          persistedLinesRef.current = [];
          setPosted(false);
          setDraftDirty(false);
          postKeyRef.current = null;
        }
      } catch {
        if (!active || !readController.isCurrent(readSequence)) return;
        setMessage("無法載入待發貨需求，請確認倉庫角色與資料權限。");
      } finally {
        if (active && readController.isCurrent(readSequence)) setQueueLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [client, identityReady, queueReloadToken]);

  useEffect(() => {
    if (!client || !panelActive) return;
    const refreshQueue = () => {
      if (canRefreshQueue) setQueueReloadToken((value) => value + 1);
    };
    window.addEventListener(hrRequestWorkflowChangedEvent, refreshQueue);
    return () => window.removeEventListener(hrRequestWorkflowChangedEvent, refreshQueue);
  }, [canRefreshQueue, client, panelActive]);

  async function loadShipmentLines(nextShipmentId: string, nextRequestId: string) {
    if (!client) return [];
    const result = await loadWarehouseShipmentLines(client, nextShipmentId, nextRequestId);
    if (result.error) throw result.error;
    return result.data;
  }

  async function loadReplenishmentLines(nextRequestId: string) {
    if (!client) return [];
    const result = await loadReplenishmentShipmentLines(client, nextRequestId);
    if (result.error) throw result.error;
    return result.data.map((line) => {
      const maximum = line.effective_maximum_transfer_quantity;
      return {
        id: line.id,
        item_id: line.item_id,
        hr_request_item_id: null,
        item_code_snapshot: line.item_code_snapshot,
        item_name_snapshot: line.item_name_snapshot,
        unit_snapshot: line.unit_snapshot,
        requested_transfer_quantity_snapshot: line.requested_quantity,
        maximum_transfer_quantity_snapshot: maximum,
        actual_transfer_quantity: line.actual_transfer_quantity == null ? maximum : line.actual_transfer_quantity,
        short_ship_reason_code: line.short_ship_reason_code,
      } satisfies ShipmentLine;
    });
  }

  async function chooseRequest(nextRequestKey: string) {
    if (busy) return;
    if (nextRequestKey === requestKey) return;
    if (nextRequestKey !== requestKey && draftDirty) {
      setMessage("目前理貨明細有尚未保存的變更；請先確認完成，再切換其他需求。");
      return;
    }
    const selected = requests.find((request) => request.queue_key === nextRequestKey);
    if (!selected) return;
    const readController = detailsReadControllerRef.current ?? createReadRequestController();
    detailsReadControllerRef.current = readController;
    const readSequence = readController.begin();
    if (nextRequestKey !== requestKey) createKeyRef.current = null;
    setRequestKey(nextRequestKey);
    setMessage("");
    setShipmentId("");
    setShipmentNo("");
    setShipmentOwnerId("");
    setLines([]);
    persistedLinesRef.current = [];
    setPosted(false);
    setDraftDirty(false);
    postKeyRef.current = null;
    if (selected.source === "REPLENISHMENT") {
      postKeyRef.current = window.localStorage.getItem(`${shipmentOperationStoragePrefix}:post:replenishment:${selected.id}`);
      setDetailsLoading(true);
      try {
        const loadedLines = await loadReplenishmentLines(selected.id);
        if (!readController.isCurrent(readSequence)) return;
        setLines(loadedLines);
        persistedLinesRef.current = loadedLines;
        setMessage("已載入補庫單；請核對實際調庫量後直接確認完成。庫存上限會在送出時再次驗證。");
      } catch (error) {
        if (!readController.isCurrent(readSequence)) return;
        setLines([]);
        persistedLinesRef.current = [];
        setMessage("補庫明細載入失敗；請重新整理後再試。" );
      } finally {
        if (readController.isCurrent(readSequence)) setDetailsLoading(false);
      }
      return;
    }
    if (!selected.shipment_id) {
      setDetailsLoading(false);
      return;
    }
    setDetailsLoading(true);
    try {
      const loadedLines = await loadShipmentLines(selected.shipment_id, selected.id);
      if (!readController.isCurrent(readSequence)) return;
      setShipmentId(selected.shipment_id);
      setShipmentNo(selected.shipment_no ?? "");
      setShipmentOwnerId(selected.shipment_created_by ?? "");
      setLines(loadedLines);
      persistedLinesRef.current = loadedLines;
      setDraftDirty(false);
      setPosted(selected.shipment_status === "POSTED");
      postKeyRef.current = window.localStorage.getItem(`${shipmentOperationStoragePrefix}:post:${selected.shipment_id}`);
      setMessage(selected.shipment_created_by === accountId ? "已載入你的理貨草稿，可繼續核對或修改。" : "已載入既有理貨草稿；此草稿非目前帳號建立，明細僅供檢視，可依權限直接確認完成。");
    } catch (error) {
      if (!readController.isCurrent(readSequence)) return;
      setMessage("理貨草稿明細載入失敗；請重新整理後再試。" );
    } finally {
      if (readController.isCurrent(readSequence)) setDetailsLoading(false);
    }
  }

  async function createDraft(options: { keepBusy?: boolean } = {}): Promise<CreatedShipment | null> {
    if (!client) {
      setMessage("預覽模式：設定 Supabase env 並登入倉庫帳號後才能建立理貨草稿。");
      return null;
    }
    if (!requestKey || selectedRequest?.source !== "HR_REQUEST" || busy || detailsLoading) return null;
    setBusy(true);
    setMessage("");
    const storageKey = `${shipmentOperationStoragePrefix}:create:${selectedRequest.id}`;
    const key = createKeyRef.current ?? window.localStorage.getItem(storageKey) ?? crypto.randomUUID();
    createKeyRef.current = key;
    window.localStorage.setItem(storageKey, key);
    const selected = selectedRequest;
    const { data, error } = await client.rpc("create_warehouse_shipment_draft", {
      p_shipment_no: shipmentNo.trim() || `SHIP-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
      p_hr_request_id: selected.id,
      p_idempotency_key: `CREATE-SHIP-${key}`,
      p_request_fingerprint: JSON.stringify({ requestId: selected.id, rowVersion: selected.row_version }),
    });
    if (error || !data?.id) {
      setMessage(safeSupabaseMutationErrorMessage(error, "理貨草稿建立失敗；請使用相同需求重試。"));
      setBusy(false);
      return null;
    }
    window.localStorage.removeItem(storageKey);
    createKeyRef.current = null;
    setDetailsLoading(true);
    try {
      const loadedLines = await loadShipmentLines(data.id, selected.id);
      setShipmentId(data.id);
      setShipmentNo(data.shipment_no ?? shipmentNo.trim());
      setShipmentOwnerId(data.created_by ?? accountId);
      setLines(loadedLines);
      persistedLinesRef.current = loadedLines;
      setDraftDirty(false);
      setPosted(false);
      setRequests((current) => current.map((request) => request.queue_key === selected.queue_key ? {
        ...request,
        shipment_id: data.id,
        shipment_no: data.shipment_no ?? shipmentNo.trim(),
        shipment_status: "DRAFT",
        shipment_created_by: data.created_by ?? accountId,
      } : request));
      setMessage(`已建立理貨草稿 ${data.shipment_no ?? ""}，請核對實際調庫量。`);
      if (!options.keepBusy) setBusy(false);
      return { id: data.id as string, shipment_no: data.shipment_no ?? (shipmentNo.trim() || null), created_by: data.created_by ?? accountId ?? null, lines: loadedLines };
    } catch (error) {
      setMessage("理貨草稿已建立，但明細載入失敗；請重新整理後再試。" );
      setBusy(false);
      return null;
    } finally {
      setDetailsLoading(false);
    }
  }

  function updateLine(lineId: string, field: "actual_transfer_quantity" | "short_ship_reason_code", value: string) {
    if (!posted && (shipmentId || selectedRequest?.source === "REPLENISHMENT")) {
      postKeyRef.current = null;
      const operationId = shipmentId || `replenishment:${selectedRequest?.id ?? ""}`;
      window.localStorage.removeItem(`${shipmentOperationStoragePrefix}:post:${operationId}`);
    }
    const updatedLines = lines.map((line) => line.id === lineId ? {
      ...line,
      [field]: field === "actual_transfer_quantity" ? Math.max(0, Number(value) || 0) : value || null,
    } : line);
    setLines(updatedLines);
    setDraftDirty(changedWarehouseShipmentLines(updatedLines, persistedLinesRef.current).length > 0);
  }

  async function postShipment(override?: { shipmentId: string; lines: ShipmentLine[] }) {
    if (!client || !selectedRequest) return;
    const activeShipmentId = override?.shipmentId ?? shipmentId;
    const activeLines = override?.lines ?? lines;
    if (activeLines.length === 0) return;
    const invalidShortShip = activeLines.some((line) => line.actual_transfer_quantity < line.requested_transfer_quantity_snapshot && !line.short_ship_reason_code);
    if (invalidShortShip) {
      setMessage("實際調庫量低於需求時，必須選擇短發原因。");
      return;
    }
    setBusy(true);
    setMessage("");
    const operationId = selectedRequest.source === "REPLENISHMENT" ? `replenishment:${selectedRequest.id}` : activeShipmentId;
    const storageKey = `${shipmentOperationStoragePrefix}:post:${operationId}`;
    const key = postKeyRef.current ?? window.localStorage.getItem(storageKey) ?? crypto.randomUUID();
    postKeyRef.current = key;
    window.localStorage.setItem(storageKey, key);
    const requestFingerprint = JSON.stringify({ shipmentId: activeShipmentId, lines: activeLines });
    let postResult: WarehousePostResult | null = null;
    const canSubmitLines = selectedRequest.source === "HR_REQUEST" && Boolean(activeShipmentId) && Boolean(override || canEditShipment);
    try {
      if (selectedRequest.source === "REPLENISHMENT") {
        postResult = await client.rpc("post_replenishment_request_with_lines", {
          p_request_id: selectedRequest.id,
          p_transfer_lines: activeLines.map((line) => ({
            lineId: line.id,
            actualTransferQuantity: line.actual_transfer_quantity,
            shortShipReasonCode: line.short_ship_reason_code,
          })),
          p_idempotency_key: `POST-REPLENISHMENT-${key}`,
          p_request_fingerprint: JSON.stringify({ requestId: selectedRequest.id, lines: activeLines }),
        });
      } else if (canSubmitLines) {
        const combinedAttempt = await attemptOptionalRpc(
          client,
          (functionName, args) => client.rpc(functionName, args),
          "post_warehouse_shipment_with_lines",
          {
            p_shipment_id: activeShipmentId,
            p_lines: activeLines.map((line) => ({
              lineId: line.id,
              actualTransferQuantity: line.actual_transfer_quantity,
              shortShipReasonCode: line.actual_transfer_quantity < line.requested_transfer_quantity_snapshot ? line.short_ship_reason_code : null,
            })),
            p_idempotency_key: `POST-SHIP-${key}`,
            p_request_fingerprint: requestFingerprint,
          },
        );
        if (combinedAttempt.status === "called") {
          postResult = { data: combinedAttempt.data as WarehousePostPayload | null, error: combinedAttempt.error };
        }
      }

      if (!postResult) {
        if (canSubmitLines) {
          // Legacy projects without the atomic wrapper only need writes for
          // edits that have not already been saved in the recoverable draft.
          const unsavedLines = changedWarehouseShipmentLines(activeLines, persistedLinesRef.current);
          const updateResults = await Promise.all(unsavedLines.map((line) => client.from("warehouse_shipment_lines").update({
            actual_transfer_quantity: line.actual_transfer_quantity,
            short_ship_reason_code: line.actual_transfer_quantity < line.requested_transfer_quantity_snapshot ? line.short_ship_reason_code : null,
          }).eq("id", line.id).eq("shipment_id", activeShipmentId).select("id").maybeSingle()));
          const updateError = updateResults.find((result) => result.error)?.error;
          if (updateError) {
            setMessage(safeSupabaseMutationErrorMessage(updateError, "理貨明細保存失敗；請使用相同草稿重試。"));
            setBusy(false);
            return;
          }
          if (updateResults.some((result, index) => result.data?.id !== unsavedLines[index]?.id)) {
            setMessage("理貨明細保存結果尚未確認；請使用相同草稿重試。");
            setBusy(false);
            return;
          }
          const persistedLines = activeLines.map((line) => ({
            ...line,
            short_ship_reason_code: line.actual_transfer_quantity < line.requested_transfer_quantity_snapshot
              ? line.short_ship_reason_code
              : null,
          }));
          persistedLinesRef.current = persistedLines;
          setLines(persistedLines);
          setDraftDirty(false);
        }
        postResult = await client.rpc("post_warehouse_shipment", {
          p_shipment_id: activeShipmentId,
          p_idempotency_key: `POST-SHIP-${key}`,
          p_request_fingerprint: requestFingerprint,
        });
      }
    } catch {
      setMessage("理貨完成結果尚未確認；請使用相同操作重試。");
      setBusy(false);
      return;
    }

    if (!postResult) {
      setMessage("理貨完成結果尚未確認；請使用相同操作重試。");
      setBusy(false);
      return;
    }
    const { data, error } = postResult;
    if (error) {
      setMessage(safeSupabaseMutationErrorMessage(error, "理貨完成結果尚未確認；請使用相同操作重試。"));
    } else if (!isWarehousePostConfirmed(
      selectedRequest.source,
      selectedRequest.source === "HR_REQUEST" ? activeShipmentId : selectedRequest.id,
      data,
    )) {
      setMessage("理貨完成結果尚未確認；請使用相同操作重試。");
    } else {
      window.localStorage.removeItem(storageKey);
      postKeyRef.current = null;
      setPosted(true);
      setDraftDirty(false);
      setRequests((current) => current.map((request) => request.queue_key === selectedRequest.queue_key ? { ...request, shipment_status: "POSTED" } : request));
      setMessage(`已完成 ${data?.shipment_no ?? data?.request_no ?? (selectedRequest.source === "REPLENISHMENT" ? "補庫單" : "發貨單")}；正式庫存紀錄已更新。`);
      notifyInventoryDataChanged();
      if (selectedRequest.source === "HR_REQUEST") window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
    }
    setBusy(false);
  }

  async function completeShipment() {
    if (!selectedRequest || selectedRequest.source !== "HR_REQUEST" || shipmentId) {
      await postShipment();
      return;
    }
    const created = await createDraft({ keepBusy: true });
    if (created) await postShipment({ shipmentId: created.id, lines: created.lines });
    else setBusy(false);
  }

  function startNextShipment() {
    if (!posted) return;
    createKeyRef.current = null;
    postKeyRef.current = null;
    setRequestKey("");
    setShipmentId("");
    setShipmentNo("");
    setShipmentOwnerId("");
    setLines([]);
    persistedLinesRef.current = [];
    setPosted(false);
    setDraftDirty(false);
    setMessage("上一筆倉庫作業已完成，請從左側選取下一筆待發貨或補庫單。");
    setQueueReloadToken((value) => value + 1);
  }

  if (!client) {
    return <section className="panel import-panel" aria-label="倉庫發貨"><div className="panel-heading"><div><p className="eyebrow">07 / WAREHOUSE</p><h2>倉庫發貨</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">設定 Supabase env 並登入倉庫帳號後，這裡會載入已送出的需求，建立理貨草稿並在交付前確認完成。</p></section>;
  }

  return (
    <section className="panel import-panel" aria-label="倉庫發貨" aria-busy={queueLoading || detailsLoading || busy}>
      <div className="panel-heading">
        <div><p className="eyebrow">07 / WAREHOUSE</p><h2>理貨與發貨</h2></div>
        <span className={`status-pill ${posted ? "success" : ""}`}>{posted ? "已完成" : selectedRequest?.source === "REPLENISHMENT" ? "補庫待確認" : shipmentId ? canEditShipment ? "草稿可編輯" : "既有草稿" : "待選需求"}</span>
      </div>
      <p className="auth-message">左側清單列出已送出的待發貨需求；有既有草稿時可直接恢復。實際調庫量只在草稿階段編輯，確認完成後原單與庫存紀錄即鎖定。</p>
      {(queueLoading || detailsLoading) ? <p className="sr-only" role="status" aria-live="polite">{queueLoading ? "正在載入待發貨清單…" : "正在載入理貨明細…"}</p> : null}
      <div className="warehouse-shipment-workspace">
        <div className="warehouse-shipment-queue">
          <div className="panel-heading"><div><p className="eyebrow">SHIPMENT QUEUE</p><h3>待發貨／補庫單</h3></div><span className="muted">{filteredQueueRows.length} 筆符合</span></div>
          <div className="management-catalog-filters warehouse-shipment-filters"><label className="field"><span>搜尋需求單／補庫單／日期／草稿</span><input value={queueQuery} onChange={(event) => { setQueueQuery(event.target.value); setQueuePage(1); }} placeholder="單號、日期、補庫單或已有草稿" /></label><div className="inventory-toolbar-action"><button className="secondary-button" type="button" onClick={() => setQueueReloadToken((value) => value + 1)} disabled={!canRefreshQueue}>{queueLoading ? "讀取中…" : "重新整理"}</button></div></div>
          {requests.length === 0 && !queueLoading
            ? <p className="empty-state">目前沒有可處理的已送出需求或補庫單。</p>
            : filteredQueueRows.length === 0 && !queueLoading
              ? <p className="empty-state">找不到符合條件的需求，請清除搜尋文字。</p>
              : <ManagementCatalogTable
                ariaLabel="待發貨需求清單"
                rows={sortedQueueRows}
                rowKey={(row) => row.id}
                page={queuePage}
                onPageChange={setQueuePage}
                sortKey={queueSortKey}
                sortDirection={queueSortDirection}
                onSort={sortQueue}
                loading={queueLoading && requests.length === 0}
                defaultPageSize={10}
                pageSizeOptions={[5, 10, 25, 50]}
                tableClassName="warehouse-shipment-table"
                emptyState={<p className="empty-state">目前沒有可處理的已送出需求或補庫單。</p>}
                columns={[
                  { id: "request", label: "來源單據", locked: true, render: (row) => <><strong>{row.requestNo}</strong><span className="table-secondary">{row.source === "REPLENISHMENT" ? "額外補庫" : "人資發貨"}／日期 {row.distributionDate}</span></>, sortKey: "request_no" },
                  { id: "status", label: "狀態", render: (row) => <span className={`status-pill ${row.shipmentStatus === "POSTED" ? "success" : row.shipmentStatus === "DRAFT" ? "danger" : ""}`}>{row.shipmentStatus === "POSTED" ? "已完成" : row.shipmentStatus === "DRAFT" ? "已有草稿" : "待建立"}</span> },
                  { id: "version", label: "來源版本", render: (row) => row.rowVersion, sortKey: "row_version", className: "numeric-cell" },
                  { id: "action", label: "操作", locked: true, render: (row) => <button className="text-button" type="button" onClick={() => void chooseRequest(row.id)} disabled={busy || (draftDirty && row.id !== requestKey)}>{row.id === requestKey ? "目前作業中" : row.shipmentStatus === "DRAFT" ? "恢復草稿" : "選取"}</button> },
                ] satisfies readonly ManagementCatalogColumn<WarehouseShipmentQueueRow, WarehouseShipmentSortKey>[]}
              />}
        </div>
        <div className="warehouse-shipment-editor">
          <div className="panel-heading"><div><p className="eyebrow">PICK & COMPLETE</p><h3>理貨工作區</h3></div></div>
          <div className="metric"><span>已選來源單據</span><strong>{selectedRequest?.request_no ?? "請從左側選取"}</strong><small>{selectedRequest ? `${selectedRequest.source === "REPLENISHMENT" ? "送出日" : "發放日"} ${selectedRequest.distribution_date}／來源版本 ${selectedRequest.row_version}` : "尚未載入需求"}</small></div>
          {selectedRequest?.source === "HR_REQUEST" ? <label className="field"><span>發貨單號（選填）</span><input value={shipmentNo} onChange={(event) => setShipmentNo(event.target.value)} disabled={Boolean(shipmentId) || busy || detailsLoading} placeholder="SHIP-20260812-001" /></label> : selectedRequest?.source === "REPLENISHMENT" ? <p className="auth-message">補庫單不需要另建發貨草稿；請直接核對調庫量後確認完成，系統會在同一筆交易內重新鎖定總倉庫存。</p> : null}
          {lines.length > 0
            ? <div className="summary-list">{lines.map((line) => <div className="summary-row" key={line.id}><span><strong>{line.item_code_snapshot ?? line.item_id}｜{line.item_name_snapshot ?? "制服品號"}</strong><small>需求 {line.requested_transfer_quantity_snapshot}／總倉當下上限 {line.maximum_transfer_quantity_snapshot}／單位 {line.unit_snapshot ?? "—"}</small></span><label className="field"><span className="sr-only">實際調庫量</span><input type="number" min={0} max={line.maximum_transfer_quantity_snapshot} value={line.actual_transfer_quantity} disabled={posted || busy || detailsLoading || !canEditShipment} onChange={(event) => updateLine(line.id, "actual_transfer_quantity", event.target.value)} /></label><label className="field"><span className="sr-only">短發原因</span><select value={line.short_ship_reason_code ?? ""} disabled={posted || busy || detailsLoading || !canEditShipment || line.actual_transfer_quantity >= line.requested_transfer_quantity_snapshot} onChange={(event) => updateLine(line.id, "short_ship_reason_code", event.target.value)}><option value="">短發原因</option>{reasons.map((reason) => <option key={reason.code} value={reason.code}>{reason.label}</option>)}</select></label></div>)}</div>
            : <p className="empty-state">請先從左側選取需求並建立或恢復理貨草稿。</p>}
          {!canEditShipment && shipmentId ? <p className="auth-message">此草稿由其他倉庫帳號建立，明細為唯讀；若數量已核對完成，仍可依權限確認完成。</p> : null}
          <WorkflowActionBar
            primary={{
              onClick: () => void completeShipment(),
              busy,
              busyLabel: "處理中…",
              disabled: busy || detailsLoading || posted || !selectedRequest || (selectedRequest.source === "REPLENISHMENT" && lines.length === 0),
              label: selectedRequest?.source === "REPLENISHMENT" ? "確認完成補庫" : shipmentId ? "確認完成發貨" : "建立並完成發貨",
            }}
            secondary={selectedRequest?.source === "HR_REQUEST" && !shipmentId
              ? <button className="secondary-button" type="button" onClick={() => void createDraft()} disabled={busy || detailsLoading || Boolean(shipmentId) || !requestKey}>{busy ? "建立中…" : detailsLoading ? "載入明細中…" : "建立理貨草稿"}</button>
              : posted ? <button className="secondary-button" type="button" onClick={startNextShipment} disabled={busy}>處理下一筆</button> : null}
          />
        </div>
      </div>
      {(identityError || message) ? <p className={message.startsWith("已") && !identityError ? "success-note" : "auth-message"} role="status">{identityError ?? message}</p> : null}
    </section>
  );
}
