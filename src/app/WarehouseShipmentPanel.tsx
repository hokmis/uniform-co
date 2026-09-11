"use client";

import { useEffect, useMemo, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "@/src/app/ManagementCatalogTable";
import { filterWarehouseShipmentQueue, sortWarehouseShipmentQueue, type WarehouseShipmentQueueRow, type WarehouseShipmentSortDirection, type WarehouseShipmentSortKey } from "@/src/domain/warehouse-shipment";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

type RequestRow = {
  id: string;
  request_no: string;
  distribution_date: string;
  row_version: number;
  shipment_id: string | null;
  shipment_no: string | null;
  shipment_status: "DRAFT" | "POSTED" | null;
  shipment_created_by: string | null;
};

type ShipmentLine = {
  id: string;
  item_id: string;
  hr_request_item_id: string;
  item_code_snapshot: string | null;
  item_name_snapshot: string | null;
  unit_snapshot: string | null;
  requested_transfer_quantity_snapshot: number;
  maximum_transfer_quantity_snapshot: number;
  actual_transfer_quantity: number;
  short_ship_reason_code: string | null;
};

type Reason = { code: string; label: string };
type RequestItemSnapshot = { id: string; item_code_snapshot: string | null; item_name_snapshot: string | null; unit_snapshot: string | null };

export default function WarehouseShipmentPanel() {
  const client = getSupabaseBrowserClient();
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [requestId, setRequestId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [shipmentId, setShipmentId] = useState("");
  const [shipmentNo, setShipmentNo] = useState("");
  const [shipmentOwnerId, setShipmentOwnerId] = useState("");
  const [lines, setLines] = useState<ShipmentLine[]>([]);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState(false);
  const [queueQuery, setQueueQuery] = useState("");
  const [queuePage, setQueuePage] = useState(1);
  const [queueSortKey, setQueueSortKey] = useState<WarehouseShipmentSortKey>("distribution_date");
  const [queueSortDirection, setQueueSortDirection] = useState<WarehouseShipmentSortDirection>("asc");

  const queueRows: WarehouseShipmentQueueRow[] = useMemo(() => requests.map((request) => ({
    id: request.id,
    requestNo: request.request_no,
    distributionDate: request.distribution_date,
    rowVersion: request.row_version,
    shipmentStatus: request.shipment_status ?? "READY",
    shipmentNo: request.shipment_no,
  })), [requests]);
  const filteredQueueRows = useMemo(() => filterWarehouseShipmentQueue(queueRows, queueQuery), [queueQuery, queueRows]);
  const sortedQueueRows = useMemo(() => sortWarehouseShipmentQueue(filteredQueueRows, queueSortKey, queueSortDirection), [filteredQueueRows, queueSortDirection, queueSortKey]);
  const selectedRequest = useMemo(() => requests.find((request) => request.id === requestId), [requestId, requests]);
  const canEditShipment = !shipmentId || shipmentOwnerId === accountId;

  function sortQueue(nextKey: WarehouseShipmentSortKey) {
    if (queueSortKey === nextKey) setQueueSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setQueueSortKey(nextKey); setQueueSortDirection("asc"); }
    setQueuePage(1);
  }

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      const { data: userData } = await supabase.auth.getUser();
      const [requestResult, reasonResult, shipmentResult, accountResult] = await Promise.all([
        supabase.from("hr_requests").select("id,request_no,distribution_date,row_version").eq("status", "SUBMITTED").order("distribution_date", { ascending: false }),
        supabase.from("transfer_short_ship_reasons").select("code,label").eq("is_active", true).order("sort_order"),
        supabase.from("warehouse_shipments").select("id,hr_request_id,shipment_no,status,created_by").eq("status", "DRAFT"),
        userData.user ? supabase.from("app_accounts").select("id").eq("auth_user_id", userData.user.id).maybeSingle() : Promise.resolve({ data: null, error: new Error("未登入") }),
      ]);
      if (!active) return;
      if (requestResult.error || reasonResult.error || shipmentResult.error || accountResult.error || !userData.user) {
        setMessage("無法載入待發貨需求，請確認倉庫角色與 RLS 權限。");
        return;
      }
      const shipmentByRequestId = new Map((shipmentResult.data ?? []).map((row) => [row.hr_request_id, row]));
      const loaded = (requestResult.data ?? []).map((row) => {
        const shipment = shipmentByRequestId.get(row.id);
        return {
          ...(row as Omit<RequestRow, "shipment_id" | "shipment_no" | "shipment_status" | "shipment_created_by">),
          shipment_id: shipment?.id ?? null,
          shipment_no: shipment?.shipment_no ?? null,
          shipment_status: shipment?.status ?? null,
          shipment_created_by: shipment?.created_by ?? null,
        } satisfies RequestRow;
      });
      setRequests(loaded);
      setAccountId(accountResult.data?.id ?? "");
      setReasons((reasonResult.data ?? []) as Reason[]);
      if (loaded[0]) setRequestId(loaded[0].id);
    }
    void load();
    return () => { active = false; };
  }, [client]);

  async function loadShipmentLines(nextShipmentId: string, nextRequestId: string) {
    if (!client) return [];
    const [lineResult, itemResult] = await Promise.all([
      client.from("warehouse_shipment_lines").select("id,item_id,hr_request_item_id,requested_transfer_quantity_snapshot,maximum_transfer_quantity_snapshot,actual_transfer_quantity,short_ship_reason_code").eq("shipment_id", nextShipmentId).order("item_id"),
      client.from("hr_request_items").select("id,item_code_snapshot,item_name_snapshot,unit_snapshot").eq("request_id", nextRequestId).order("item_id"),
    ]);
    if (lineResult.error || itemResult.error) throw lineResult.error ?? itemResult.error;
    const itemById = new Map(((itemResult.data ?? []) as RequestItemSnapshot[]).map((item) => [item.id, item]));
    return ((lineResult.data ?? []) as Omit<ShipmentLine, "item_code_snapshot" | "item_name_snapshot" | "unit_snapshot">[]).map((line) => ({
      ...line,
      item_code_snapshot: itemById.get(line.hr_request_item_id)?.item_code_snapshot ?? null,
      item_name_snapshot: itemById.get(line.hr_request_item_id)?.item_name_snapshot ?? null,
      unit_snapshot: itemById.get(line.hr_request_item_id)?.unit_snapshot ?? null,
    }));
  }

  async function chooseRequest(nextRequestId: string) {
    if (busy || (shipmentId && nextRequestId !== requestId)) return;
    const selected = requests.find((request) => request.id === nextRequestId);
    if (!selected) return;
    setRequestId(nextRequestId);
    setMessage("");
    if (!selected.shipment_id) {
      setShipmentId("");
      setShipmentNo("");
      setShipmentOwnerId("");
      setLines([]);
      setPosted(false);
      return;
    }
    setBusy(true);
    try {
      const loadedLines = await loadShipmentLines(selected.shipment_id, nextRequestId);
      setShipmentId(selected.shipment_id);
      setShipmentNo(selected.shipment_no ?? "");
      setShipmentOwnerId(selected.shipment_created_by ?? "");
      setLines(loadedLines);
      setPosted(selected.shipment_status === "POSTED");
      setMessage(selected.shipment_created_by === accountId ? "已載入你的理貨草稿，可繼續核對或修改。" : "已載入既有理貨草稿；此草稿非目前帳號建立，明細僅供檢視，可依權限直接 POST。");
    } catch (error) {
      setMessage(`理貨草稿明細載入失敗：${error instanceof Error ? error.message : "請重新整理"}`);
    }
    setBusy(false);
  }

  async function createDraft() {
    if (!client) {
      setMessage("預覽模式：設定 Supabase env 並登入倉庫帳號後才能建立理貨草稿。");
      return;
    }
    if (!requestId) return;
    setBusy(true);
    setMessage("");
    const key = crypto.randomUUID();
    const selected = requests.find((request) => request.id === requestId);
    const { data, error } = await client.rpc("create_warehouse_shipment_draft", {
      p_shipment_no: shipmentNo.trim() || `SHIP-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
      p_hr_request_id: requestId,
      p_idempotency_key: `CREATE-SHIP-${key}`,
      p_request_fingerprint: JSON.stringify({ requestId, rowVersion: selected?.row_version ?? null }),
    });
    if (error || !data?.id) {
      setMessage(error?.message ?? "理貨草稿建立失敗");
      setBusy(false);
      return;
    }
    try {
      const loadedLines = await loadShipmentLines(data.id, requestId);
      setShipmentId(data.id);
      setShipmentNo(data.shipment_no ?? shipmentNo.trim());
      setShipmentOwnerId(data.created_by ?? accountId);
      setLines(loadedLines);
      setPosted(false);
      setRequests((current) => current.map((request) => request.id === requestId ? {
        ...request,
        shipment_id: data.id,
        shipment_no: data.shipment_no ?? shipmentNo.trim(),
        shipment_status: "DRAFT",
        shipment_created_by: data.created_by ?? accountId,
      } : request));
      setMessage(`已建立理貨草稿 ${data.shipment_no ?? ""}，請核對實際調庫量。`);
    } catch (error) {
      setMessage(`理貨草稿已建立，但明細載入失敗：${error instanceof Error ? error.message : "請重新整理"}`);
    }
    setBusy(false);
  }

  function updateLine(lineId: string, field: "actual_transfer_quantity" | "short_ship_reason_code", value: string) {
    setLines((current) => current.map((line) => line.id === lineId ? {
      ...line,
      [field]: field === "actual_transfer_quantity" ? Math.max(0, Number(value) || 0) : value || null,
    } : line));
  }

  async function postShipment() {
    if (!client || !shipmentId) return;
    const invalidShortShip = lines.some((line) => line.actual_transfer_quantity < line.requested_transfer_quantity_snapshot && !line.short_ship_reason_code);
    if (invalidShortShip) {
      setMessage("實際調庫量低於需求時，必須選擇短發原因。");
      return;
    }
    setBusy(true);
    setMessage("");
    if (canEditShipment) {
      for (const line of lines) {
        const { error } = await client.from("warehouse_shipment_lines").update({
          actual_transfer_quantity: line.actual_transfer_quantity,
          short_ship_reason_code: line.actual_transfer_quantity < line.requested_transfer_quantity_snapshot ? line.short_ship_reason_code : null,
        }).eq("id", line.id).eq("shipment_id", shipmentId);
        if (error) {
          setMessage(error.message);
          setBusy(false);
          return;
        }
      }
    }
    const { data, error } = await client.rpc("post_warehouse_shipment", {
      p_shipment_id: shipmentId,
      p_idempotency_key: `POST-SHIP-${crypto.randomUUID()}`,
      p_request_fingerprint: JSON.stringify({ shipmentId, lines }),
    });
    if (error) {
      setMessage(error.message);
    } else {
      setPosted(true);
      setRequests((current) => current.map((request) => request.id === requestId ? { ...request, shipment_status: "POSTED" } : request));
      setMessage(`已 POST ${data?.shipment_no ?? "發貨單"}；正式交付與庫存流水已完成。`);
    }
    setBusy(false);
  }

  if (!client) {
    return <section className="panel import-panel" aria-label="倉庫發貨"><div className="panel-heading"><div><p className="eyebrow">07 / WAREHOUSE</p><h2>倉庫發貨</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">設定 Supabase env 並登入倉庫帳號後，這裡會載入已送出的需求，建立理貨草稿並在交付前 POST。</p></section>;
  }

  return (
    <section className="panel import-panel" aria-label="倉庫發貨">
      <div className="panel-heading">
        <div><p className="eyebrow">07 / WAREHOUSE</p><h2>理貨與發貨 POST</h2></div>
        <span className={`status-pill ${posted ? "success" : ""}`}>{posted ? "已鎖單" : shipmentId ? canEditShipment ? "草稿可編輯" : "既有草稿" : "待選需求"}</span>
      </div>
      <p className="auth-message">左側清單列出已送出的待發貨需求；有既有草稿時可直接恢復。實際調庫量只在草稿階段編輯，POST 後原單與庫存流水即鎖定。</p>
      <div className="warehouse-shipment-workspace">
        <div className="warehouse-shipment-queue">
          <div className="panel-heading"><div><p className="eyebrow">SHIPMENT QUEUE</p><h3>待發貨需求</h3></div><span className="muted">{filteredQueueRows.length} 筆符合</span></div>
          <div className="management-catalog-filters warehouse-shipment-filters"><label className="field"><span>搜尋需求單／日期／草稿</span><input value={queueQuery} onChange={(event) => { setQueueQuery(event.target.value); setQueuePage(1); }} placeholder="需求單號、日期或已有草稿" /></label></div>
          {requests.length === 0
            ? <p className="empty-state">目前沒有可發貨的已送出需求。</p>
            : filteredQueueRows.length === 0
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
                defaultPageSize={10}
                pageSizeOptions={[5, 10, 25, 50]}
                tableClassName="warehouse-shipment-table"
                emptyState={<p className="empty-state">目前沒有可發貨的已送出需求。</p>}
                columns={[
                  { id: "request", label: "需求單", locked: true, render: (row) => <><strong>{row.requestNo}</strong><span className="table-secondary">發放日 {row.distributionDate}</span></>, sortKey: "request_no" },
                  { id: "status", label: "狀態", render: (row) => <span className={`status-pill ${row.shipmentStatus === "POSTED" ? "success" : row.shipmentStatus === "DRAFT" ? "danger" : ""}`}>{row.shipmentStatus === "POSTED" ? "已 POST" : row.shipmentStatus === "DRAFT" ? "已有草稿" : "待建立"}</span> },
                  { id: "version", label: "來源版本", render: (row) => row.rowVersion, sortKey: "row_version", className: "numeric-cell" },
                  { id: "action", label: "操作", locked: true, render: (row) => <button className="text-button" type="button" onClick={() => void chooseRequest(row.id)} disabled={busy || Boolean(shipmentId && row.id !== requestId)}>{shipmentId && row.id === requestId ? "目前作業中" : row.shipmentStatus === "DRAFT" ? "恢復草稿" : "選取"}</button> },
                ] satisfies readonly ManagementCatalogColumn<WarehouseShipmentQueueRow, WarehouseShipmentSortKey>[]}
              />}
        </div>
        <div className="warehouse-shipment-editor">
          <div className="panel-heading"><div><p className="eyebrow">PICK & POST</p><h3>理貨工作區</h3></div></div>
          <div className="metric"><span>已選需求</span><strong>{selectedRequest?.request_no ?? "請從左側選取"}</strong><small>{selectedRequest ? `發放日 ${selectedRequest.distribution_date}／來源版本 ${selectedRequest.row_version}` : "尚未載入需求"}</small></div>
          <label className="field"><span>發貨單號（選填）</span><input value={shipmentNo} onChange={(event) => setShipmentNo(event.target.value)} disabled={Boolean(shipmentId) || busy} placeholder="SHIP-20260812-001" /></label>
          <div className="button-row"><button className="secondary-button" type="button" onClick={() => void createDraft()} disabled={busy || Boolean(shipmentId) || !requestId}>{busy ? "建立中…" : "建立理貨草稿"}</button></div>
          {lines.length > 0
            ? <div className="summary-list">{lines.map((line) => <div className="summary-row" key={line.id}><span><strong>{line.item_code_snapshot ?? line.item_id}｜{line.item_name_snapshot ?? "制服品號"}</strong><small>需求 {line.requested_transfer_quantity_snapshot}／總倉當下上限 {line.maximum_transfer_quantity_snapshot}／單位 {line.unit_snapshot ?? "—"}</small></span><label className="field"><span className="sr-only">實際調庫量</span><input type="number" min={0} max={line.maximum_transfer_quantity_snapshot} value={line.actual_transfer_quantity} disabled={posted || busy || !canEditShipment} onChange={(event) => updateLine(line.id, "actual_transfer_quantity", event.target.value)} /></label><label className="field"><span className="sr-only">短發原因</span><select value={line.short_ship_reason_code ?? ""} disabled={posted || busy || !canEditShipment || line.actual_transfer_quantity >= line.requested_transfer_quantity_snapshot} onChange={(event) => updateLine(line.id, "short_ship_reason_code", event.target.value)}><option value="">短發原因</option>{reasons.map((reason) => <option key={reason.code} value={reason.code}>{reason.label}</option>)}</select></label></div>)}</div>
            : <p className="empty-state">請先從左側選取需求並建立或恢復理貨草稿。</p>}
          {!canEditShipment && shipmentId ? <p className="auth-message">此草稿由其他倉庫帳號建立，明細為唯讀；若數量已核對完成，仍可依資料庫權限執行 POST。</p> : null}
          <div className="button-row"><button className="primary-button" type="button" onClick={() => void postShipment()} disabled={busy || posted || !shipmentId || lines.length === 0}>{busy ? "處理中…" : "POST 並完成交付"}</button></div>
        </div>
      </div>
      {message ? <p className={message.startsWith("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
    </section>
  );
}
