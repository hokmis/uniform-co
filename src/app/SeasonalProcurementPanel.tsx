"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "@/src/app/ManagementCatalogTable";
import { filterSeasonalProcurementQueue, sortSeasonalProcurementQueue, type SeasonalProcurementQueueRow, type SeasonalProcurementSortDirection, type SeasonalProcurementSortKey } from "@/src/domain/seasonal-procurement";
import { createReadRequestController, shouldPreserveReadSnapshot, staleReadSnapshotMessage, type ReadRequestController } from "@/src/domain/read-refresh";
import { invalidateMasterDataCache, loadProcurementMasterData } from "@/src/lib/master-data-cache";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

type ApprovalLine = {
  id: string;
  item_id: string;
  item_code_snapshot: string;
  item_name_snapshot: string;
  size_snapshot: string | null;
  unit_snapshot: string;
  approved_quantity: number;
};
type Supplier = { id: string; supplier_code: string; name: string; default_currency: string | null };
type SupplierItem = { supplier_id: string; item_id: string; minimum_order_quantity: number | null };
type DifferenceReason = { code: string; name: string };
type ProcurementLine = { id: string; approval_line_id: string; supplier_id: string; final_purchase_quantity: number; minimum_order_quantity_snapshot: number | null };

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

export default function SeasonalProcurementPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [lines, setLines] = useState<ApprovalLine[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierItems, setSupplierItems] = useState<SupplierItem[]>([]);
  const [differenceReasons, setDifferenceReasons] = useState<DifferenceReason[]>([]);
  const [procurementLines, setProcurementLines] = useState<ProcurementLine[]>([]);
  const [lineId, setLineId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [finalQuantity, setFinalQuantity] = useState(0);
  const [differenceReason, setDifferenceReason] = useState("");
  const [note, setNote] = useState("");
  const [procurementId, setProcurementId] = useState("");
  const [poNo, setPoNo] = useState("");
  const [orderedQuantity, setOrderedQuantity] = useState(0);
  const [orderDate, setOrderDate] = useState(taipeiToday());
  const [expectedArrivalDate, setExpectedArrivalDate] = useState("");
  const [currency, setCurrency] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [queueQuery, setQueueQuery] = useState("");
  const [queuePage, setQueuePage] = useState(1);
  const [queueSortKey, setQueueSortKey] = useState<SeasonalProcurementSortKey>("item_code");
  const [queueSortDirection, setQueueSortDirection] = useState<SeasonalProcurementSortDirection>("asc");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const decisionKeyRef = useRef<string | null>(null);
  const poKeyRef = useRef<string | null>(null);
  const lineIdRef = useRef("");
  const supplierIdRef = useRef("");
  const procurementIdRef = useRef("");
  const [dataSnapshotAccountId, setDataSnapshotAccountId] = useState<string | null>(null);
  const dataSnapshotAccountIdRef = useRef<string | null>(null);
  const readControllerRef = useRef<ReadRequestController | null>(null);

  useEffect(() => {
    lineIdRef.current = lineId;
    supplierIdRef.current = supplierId;
    procurementIdRef.current = procurementId;
  }, [lineId, procurementId, supplierId]);

  const hasCurrentDataSnapshot = Boolean(
    identityReady
      && dataSnapshotAccountId
      && dataSnapshotAccountId === accountId,
  );
  const dataReadBlocked = !hasCurrentDataSnapshot;
  const visibleLines = useMemo(() => hasCurrentDataSnapshot ? lines : [], [hasCurrentDataSnapshot, lines]);
  const visibleSuppliers = useMemo(() => hasCurrentDataSnapshot ? suppliers : [], [hasCurrentDataSnapshot, suppliers]);
  const visibleSupplierItems = useMemo(() => hasCurrentDataSnapshot ? supplierItems : [], [hasCurrentDataSnapshot, supplierItems]);
  const visibleDifferenceReasons = useMemo(() => hasCurrentDataSnapshot ? differenceReasons : [], [differenceReasons, hasCurrentDataSnapshot]);
  const visibleProcurementLines = useMemo(() => hasCurrentDataSnapshot ? procurementLines : [], [hasCurrentDataSnapshot, procurementLines]);
  const selectedLine = useMemo(() => visibleLines.find((line) => line.id === lineId), [lineId, visibleLines]);
  const availableSuppliers = useMemo(
    () => visibleSupplierItems.filter((relation) => relation.item_id === selectedLine?.item_id && relation.minimum_order_quantity !== 0 && visibleSuppliers.some((supplier) => supplier.id === relation.supplier_id)),
    [selectedLine, visibleSupplierItems, visibleSuppliers],
  );
  const selectedRelation = availableSuppliers.find((relation) => relation.supplier_id === supplierId);
  const selectedSupplier = visibleSuppliers.find((supplier) => supplier.id === supplierId);
  const existingDecision = visibleProcurementLines.find((line) => line.approval_line_id === lineId);
  const queueRows: SeasonalProcurementQueueRow[] = useMemo(() => visibleLines.map((line) => {
    const decision = visibleProcurementLines.find((row) => row.approval_line_id === line.id);
    return {
      id: line.id,
      itemCode: line.item_code_snapshot,
      itemName: line.item_name_snapshot,
      size: line.size_snapshot,
      approvedQuantity: line.approved_quantity,
      decisionStatus: decision ? "DECIDED" : "PENDING",
      finalPurchaseQuantity: decision?.final_purchase_quantity ?? null,
    };
  }), [visibleLines, visibleProcurementLines]);
  const filteredQueueRows = useMemo(() => filterSeasonalProcurementQueue(queueRows, queueQuery), [queueQuery, queueRows]);
  const sortedQueueRows = useMemo(() => sortSeasonalProcurementQueue(filteredQueueRows, queueSortKey, queueSortDirection), [filteredQueueRows, queueSortDirection, queueSortKey]);
  const displayMessage = identityError ?? message;
  const readSnapshotRef = useRef({
    lines,
    suppliers,
    supplierItems,
    differenceReasons,
    procurementLines,
  });

  useEffect(() => {
    readSnapshotRef.current = { lines, suppliers, supplierItems, differenceReasons, procurementLines };
  }, [differenceReasons, lines, procurementLines, supplierItems, suppliers]);

  useEffect(() => {
    if (!identityReady || !client) {
      return;
    }
    const supabase = client;
    let active = true;
    const readController = readControllerRef.current ?? createReadRequestController();
    readControllerRef.current = readController;
    const readSequence = readController.begin();
    async function load() {
      setDataLoading(true);
      try {
        setMessage("正在讀取核准品項與供應商資料…");
        const [queueResults, procurementMasterData] = await Promise.all([
          retrySupabaseQueriesAfterSessionRefresh(
            supabase,
            async () => [await supabase.from("v_seasonal_procurement_queue")
              .select("approval_line_id,item_id,item_code_snapshot,item_name_snapshot,size_snapshot,unit_snapshot,approved_quantity,procurement_id,procurement_supplier_id,final_purchase_quantity,minimum_order_quantity_snapshot")
              .order("item_code_snapshot")] as const,
          ),
          loadProcurementMasterData(supabase),
        ]);
        const [queueResult] = queueResults;
        if (!active || !readController.isCurrent(readSequence)) return;
        if (queueResult.error || procurementMasterData.errors.length > 0) {
          const readErrors = [
            queueResult.error ? { code: queueResult.error.code, message: queueResult.error.message } : null,
            ...procurementMasterData.errors.map((error) => ({ code: error.code, message: error.message })),
          ].filter((error): error is { code: string | null | undefined; message: string } => Boolean(error));
          const snapshot = readSnapshotRef.current;
          const snapshotRows = [...snapshot.lines, ...snapshot.suppliers, ...snapshot.supplierItems, ...snapshot.differenceReasons, ...snapshot.procurementLines];
          const preserveSnapshot = dataSnapshotAccountIdRef.current === accountId
            && shouldPreserveReadSnapshot(snapshotRows, readErrors);
          if (!preserveSnapshot) {
            setLines([]);
            setSuppliers([]);
            setSupplierItems([]);
            setDifferenceReasons([]);
            setProcurementLines([]);
            dataSnapshotAccountIdRef.current = null;
            setDataSnapshotAccountId(null);
            setLineId("");
            setSupplierId("");
            setProcurementId("");
          }
          setMessage(preserveSnapshot ? staleReadSnapshotMessage("採購資料") : "採購資料載入失敗，請確認 PROCUREMENT 角色與資料權限。");
          return;
        }
        const queueRows = (queueResult.data ?? []) as Array<{
        approval_line_id: string;
        item_id: string;
        item_code_snapshot: string;
        item_name_snapshot: string;
        size_snapshot: string | null;
        unit_snapshot: string;
        approved_quantity: number;
        procurement_id: string | null;
        procurement_supplier_id: string | null;
        final_purchase_quantity: number | null;
        minimum_order_quantity_snapshot: number | null;
      }>;
        const nextLines: ApprovalLine[] = queueRows.map((row) => ({
        id: row.approval_line_id,
        item_id: row.item_id,
        item_code_snapshot: row.item_code_snapshot,
        item_name_snapshot: row.item_name_snapshot,
        size_snapshot: row.size_snapshot,
        unit_snapshot: row.unit_snapshot,
        approved_quantity: row.approved_quantity,
      }));
        setLines(nextLines);
        setSuppliers(procurementMasterData.suppliers as Supplier[]);
        setSupplierItems(procurementMasterData.supplierItems as SupplierItem[]);
        setDifferenceReasons(procurementMasterData.differenceReasons as DifferenceReason[]);
        const loadedDecisions: ProcurementLine[] = queueRows.flatMap((row) => row.procurement_id ? [{
        id: row.procurement_id,
        approval_line_id: row.approval_line_id,
        supplier_id: row.procurement_supplier_id ?? "",
        final_purchase_quantity: Number(row.final_purchase_quantity ?? 0),
        minimum_order_quantity_snapshot: row.minimum_order_quantity_snapshot,
      }] : []);
        const loadedRelations = procurementMasterData.supplierItems as SupplierItem[];
        setProcurementLines(loadedDecisions);
        const previousSnapshotAccountId = dataSnapshotAccountIdRef.current;
        const sameAccountSnapshot = previousSnapshotAccountId === accountId;
        dataSnapshotAccountIdRef.current = accountId;
        setDataSnapshotAccountId(accountId);
        const currentLineId = lineIdRef.current;
        const currentSupplierId = supplierIdRef.current;
        const currentProcurementId = procurementIdRef.current;
        let preservedEditor = false;
        if (!sameAccountSnapshot) {
          decisionKeyRef.current = null;
          poKeyRef.current = null;
          setDifferenceReason("");
          setNote("");
          setPoNo("");
          setExpectedArrivalDate("");
          setUnitPrice("");
          setTaxRate("");
        }
        const selected = nextLines.find((line) => line.id === currentLineId);
        if (selected) {
        const existing = loadedDecisions.find((row) => row.approval_line_id === selected.id);
        const relation = loadedRelations.find((row) => row.item_id === selected.item_id && row.minimum_order_quantity !== 0);
        const currentSupplierStillAvailable = !currentSupplierId
          || loadedRelations.some((row) => row.item_id === selected.item_id && row.supplier_id === currentSupplierId && row.minimum_order_quantity !== 0);
        const currentDecisionStillMatches = !existing || currentProcurementId === existing.id;
        const preserveCurrentEditor = currentLineId === selected.id
          && sameAccountSnapshot
          && currentSupplierStillAvailable
          && currentDecisionStillMatches;
        if (preserveCurrentEditor) {
          preservedEditor = true;
          setLineId(selected.id);
          setMessage("已同步採購資料，保留目前編輯內容");
        } else {
          setLineId(selected.id);
          const initialSupplierId = existing?.supplier_id ?? relation?.supplier_id ?? "";
          setSupplierId(initialSupplierId);
          setCurrency(procurementMasterData.suppliers.find((row) => row.id === initialSupplierId)?.default_currency ?? "");
          setFinalQuantity(existing?.final_purchase_quantity ?? selected.approved_quantity);
          setOrderedQuantity(existing?.final_purchase_quantity ?? selected.approved_quantity);
          setProcurementId(existing?.id ?? "");
        }
        } else {
        setLineId("");
        setSupplierId("");
        setFinalQuantity(0);
        setOrderedQuantity(0);
        setProcurementId("");
        setCurrency("");
        setDifferenceReason("");
        setNote("");
        setPoNo("");
        setExpectedArrivalDate("");
        setUnitPrice("");
        setTaxRate("");
        }
        if (!preservedEditor) {
          setMessage(`已載入 ${nextLines.length} 個核准品項、${procurementMasterData.suppliers.length} 家供應商`);
        }
      } finally {
        if (active && readController.isCurrent(readSequence)) setDataLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accountId, client, identityError, identityReady, panelActive, reloadToken]);

  function reloadProcurementData() {
    if (client) invalidateMasterDataCache(client, "procurement");
    readControllerRef.current?.invalidate();
    setMessage("正在重新載入採購資料…");
    setReloadToken((current) => current + 1);
  }

  function resetDecisionKey() { decisionKeyRef.current = null; poKeyRef.current = null; }

  function selectApprovalLine(nextId: string) {
    const nextLine = visibleLines.find((line) => line.id === nextId);
    if (!nextLine) return;
    const existing = visibleProcurementLines.find((line) => line.approval_line_id === nextLine.id);
    const relation = visibleSupplierItems.find((row) => row.item_id === nextLine.item_id && row.minimum_order_quantity !== 0);
    resetDecisionKey();
    setLineId(nextId);
    setSupplierId(existing?.supplier_id ?? relation?.supplier_id ?? "");
    setCurrency(visibleSuppliers.find((supplier) => supplier.id === (existing?.supplier_id ?? relation?.supplier_id))?.default_currency ?? "");
    setFinalQuantity(existing?.final_purchase_quantity ?? nextLine.approved_quantity);
    setOrderedQuantity(existing?.final_purchase_quantity ?? nextLine.approved_quantity);
    setProcurementId(existing?.id ?? "");
    setDifferenceReason("");
    setNote("");
    setPoNo("");
    setExpectedArrivalDate("");
    setUnitPrice("");
    setTaxRate("");
    setMessage("");
    setQueuePage(1);
  }

  function sortQueue(nextKey: SeasonalProcurementSortKey) {
    if (queueSortKey === nextKey) setQueueSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setQueueSortKey(nextKey); setQueueSortDirection("asc"); }
    setQueuePage(1);
  }

  async function saveDecision() {
    if (!identityReady || dataReadBlocked || !client || !selectedLine || !supplierId || finalQuantity < 0) { setMessage(identityError ?? "採購資料尚未就緒，請稍候或重新載入資料。"); return; }
    if (existingDecision) { setMessage("此核准品項已有採購決策；原始數量不可覆寫，請使用採購上限更正流程。"); return; }
    if (finalQuantity !== selectedLine.approved_quantity && !differenceReason.trim()) { setMessage("採購量與核准量不同時，必須填寫差異理由。"); return; }
    setBusy(true); setMessage("");
    const operationKey = decisionKeyRef.current ?? crypto.randomUUID();
    decisionKeyRef.current = operationKey;
    const { data, error } = await client.rpc("set_seasonal_procurement_line", {
      p_approval_line_id: selectedLine.id, p_supplier_id: supplierId, p_final_purchase_quantity: finalQuantity,
      p_difference_reason: differenceReason || null, p_note: note.trim() || null,
      p_idempotency_key: `PROCUREMENT-DECISION-${operationKey}`,
      p_request_fingerprint: JSON.stringify({ lineId: selectedLine.id, supplierId, finalQuantity, differenceReason: differenceReason.trim(), note: note.trim() }),
    });
    if (error) setMessage(safeSupabaseMutationErrorMessage(error, "採購決策失敗；請使用相同品項資料重試。"));
    else {
      const saved = data as ProcurementLine;
      setProcurementId(saved.id); setProcurementLines((rows) => [...rows, saved]); setMessage("已保存採購決策；原始核准量與 MOQ 快照已鎖定。");
      decisionKeyRef.current = null; setDifferenceReason(""); setNote("");
    }
    setBusy(false);
  }

  async function createPurchaseOrder() {
    if (!identityReady || dataReadBlocked || !client || !procurementId || !poNo.trim() || orderedQuantity <= 0) { setMessage(identityError ?? "採購資料尚未就緒，請稍候或重新載入資料。"); return; }
    setBusy(true); setMessage("");
    const operationKey = poKeyRef.current ?? crypto.randomUUID();
    poKeyRef.current = operationKey;
    const { error } = await client.rpc("create_purchase_order", {
      p_po_no: poNo.trim(), p_procurement_line_id: procurementId, p_ordered_quantity: orderedQuantity,
      p_order_date: orderDate || null, p_expected_arrival_date: expectedArrivalDate || null,
      p_currency: currency.trim().toUpperCase() || null, p_unit_price: unitPrice === "" ? null : Number(unitPrice),
      p_tax_rate: taxRate === "" ? null : Number(taxRate), p_idempotency_key: `PURCHASE-ORDER-${operationKey}`,
      p_request_fingerprint: JSON.stringify({ procurementId, poNo: poNo.trim(), orderedQuantity, orderDate, expectedArrivalDate, currency: currency.trim().toUpperCase(), unitPrice, taxRate }),
    });
    if (error) setMessage(safeSupabaseMutationErrorMessage(error, "採購單建立失敗；請使用相同決策資料重試。"));
    else { setMessage(`採購單 ${poNo.trim()} 已建立並進入 ORDERED。`); poKeyRef.current = null; setPoNo(""); }
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="換季採購決策"><div className="panel-heading"><div><p className="eyebrow">11 / PROCUREMENT</p><h2>換季採購決策</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 PROCUREMENT 帳號後，依 CEO 核准量選擇供應商、確認 MOQ 並建立採購單。</p></section>;
  return <section className="panel import-panel" aria-label="換季採購決策">
    <div className="panel-heading"><div><p className="eyebrow">11 / PROCUREMENT</p><h2>換季採購決策</h2></div><div className="heading-actions"><span className="status-pill">核准後採購</span><button className="secondary-button" type="button" onClick={reloadProcurementData} disabled={busy}>重新載入資料</button></div></div>
    <p className="auth-message">採購量由核准版本起算；供應商 MOQ、差異理由與採購單欄位會由資料庫 RPC 再次驗證，已保存的原始採購決策不可直接覆寫。</p>
    <div className="seasonal-procurement-workspace">
      <div className="seasonal-procurement-queue">
        <div className="subheading"><h3>CEO 核准品項</h3><span>搜尋品號、品名、尺寸、數量或決策狀態，再按「選取」載入右側工作區</span></div>
        <div className="management-catalog-filters seasonal-procurement-filters"><label className="field"><span>搜尋核准品項</span><input value={queueQuery} onChange={(event) => { setQueueQuery(event.target.value); setQueuePage(1); }} placeholder="品號、品名、尺寸或 PENDING" /></label></div>
        <div className="management-catalog-result"><p className="muted" aria-live="polite">符合條件 {sortedQueueRows.length} 筆</p>{queueQuery ? <button className="text-button" type="button" onClick={() => { setQueueQuery(""); setQueuePage(1); }}>清除搜尋</button> : null}</div>
        <ManagementCatalogTable
          ariaLabel="CEO 核准品項"
          rows={sortedQueueRows}
          rowKey={(row) => row.id}
          columns={[
            { id: "item", label: "品號／品名", sortKey: "item_code", locked: true, render: (row) => <strong>{row.itemCode}｜{row.itemName}{row.size ? `｜${row.size}` : ""}</strong> },
            { id: "approved", label: "核准量", sortKey: "approved_quantity", render: (row) => row.approvedQuantity },
            { id: "decision", label: "決策狀態", sortKey: "decision_status", render: (row) => <span className={`status-pill ${row.decisionStatus === "DECIDED" ? "success" : ""}`}>{row.decisionStatus === "DECIDED" ? "已完成" : "待決策"}</span> },
            { id: "final", label: "最終採購量", defaultVisible: false, render: (row) => row.finalPurchaseQuantity ?? "—" },
            { id: "action", label: "功能", locked: true, render: (row) => <button className="management-row-action" type="button" onClick={() => selectApprovalLine(row.id)} disabled={busy}>{row.id === lineId ? "目前已選取" : "選取"}</button> },
          ] satisfies readonly ManagementCatalogColumn<SeasonalProcurementQueueRow, SeasonalProcurementSortKey>[]}
          page={queuePage}
          onPageChange={setQueuePage}
          sortKey={queueSortKey}
          sortDirection={queueSortDirection}
          onSort={sortQueue}
          loading={dataLoading && visibleLines.length === 0}
          defaultPageSize={10}
          pageSizeOptions={[5, 10, 25, 50]}
          emptyState={<p className="empty-state">{queueRows.length === 0 ? "目前沒有可採購的 CEO 核准品項。" : "沒有符合搜尋的核准品項。"}</p>}
          tableClassName="seasonal-procurement-table"
        />
      </div>
      <div className="seasonal-procurement-review">
        <div className="subheading"><h3>採購決策工作區</h3><span>原始核准量與 MOQ 快照保存後不可覆寫</span></div>
        <div className="form-grid">
      <label className="field"><span>CEO 核准品項</span><select value={lineId} onChange={(event) => selectApprovalLine(event.target.value)} disabled={busy || dataReadBlocked}><option value="">請選擇</option>{visibleLines.map((line) => <option key={line.id} value={line.id}>{line.item_code_snapshot}｜{line.item_name_snapshot}{line.size_snapshot ? `｜${line.size_snapshot}` : ""}（核准 {line.approved_quantity}）</option>)}</select></label>
      <label className="field"><span>供應商</span><select value={supplierId} onChange={(event) => { const nextSupplierId = event.target.value; resetDecisionKey(); setSupplierId(nextSupplierId); setCurrency(visibleSuppliers.find((supplier) => supplier.id === nextSupplierId)?.default_currency ?? ""); }} disabled={busy || dataReadBlocked || Boolean(existingDecision)}><option value="">請選擇</option>{availableSuppliers.map((relation) => { const supplier = visibleSuppliers.find((row) => row.id === relation.supplier_id); return <option key={relation.supplier_id} value={relation.supplier_id}>{supplier?.supplier_code}｜{supplier?.name}（MOQ {relation.minimum_order_quantity ?? "未設定"}）</option>; })}</select></label>
      <label className="field"><span>最終採購量</span><input type="number" min={0} max={999999999} value={finalQuantity} onChange={(event) => { resetDecisionKey(); setFinalQuantity(Math.max(0, Number(event.target.value) || 0)); }} disabled={busy || dataReadBlocked || Boolean(existingDecision)} /></label>
      <div className="metric"><span>核准量／MOQ</span><strong>{selectedLine?.approved_quantity ?? 0}／{selectedRelation?.minimum_order_quantity ?? "—"}</strong><small>{selectedSupplier ? `${selectedSupplier.supplier_code}｜${selectedSupplier.name}` : "請先選擇供應商"}</small></div>
    </div>
    <label className="field reason-field"><span>差異原因碼（採購量不同時必填）</span><select value={differenceReason} onChange={(event) => { resetDecisionKey(); setDifferenceReason(event.target.value); }} disabled={busy || dataReadBlocked || Boolean(existingDecision)}><option value="">請選擇原因碼</option>{visibleDifferenceReasons.map((reason) => <option key={reason.code} value={reason.code}>{reason.code}｜{reason.name}</option>)}</select></label>
    <label className="field reason-field"><span>備註（選填）</span><input value={note} onChange={(event) => { resetDecisionKey(); setNote(event.target.value); }} maxLength={2000} disabled={busy || Boolean(existingDecision)} /></label>
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void saveDecision()} disabled={busy || !identityReady || !selectedLine || !supplierId || Boolean(existingDecision)}>{busy ? "儲存中…" : existingDecision ? "採購決策已保存" : "保存採購決策"}</button></div>
    {existingDecision ? <>
      <div className="increase-list"><div className="subheading"><h3>建立採購單</h3><span>{selectedSupplier?.supplier_code ?? "供應商"}｜決策量 {existingDecision.final_purchase_quantity}</span></div>
        <div className="form-grid">
          <label className="field"><span>採購單號</span><input value={poNo} onChange={(event) => { poKeyRef.current = null; setPoNo(event.target.value); }} maxLength={80} disabled={busy} placeholder="例如 PO-2026-001" /></label>
          <label className="field"><span>下單量</span><input type="number" min={1} max={999999999} value={orderedQuantity} onChange={(event) => { poKeyRef.current = null; setOrderedQuantity(Math.max(0, Number(event.target.value) || 0)); }} disabled={busy} /></label>
          <label className="field"><span>下單日期</span><input type="date" value={orderDate} onChange={(event) => { poKeyRef.current = null; setOrderDate(event.target.value); }} disabled={busy} /></label>
          <label className="field"><span>預計到貨日</span><input type="date" value={expectedArrivalDate} onChange={(event) => { poKeyRef.current = null; setExpectedArrivalDate(event.target.value); }} disabled={busy} /></label>
          <label className="field"><span>幣別</span><input value={currency} onChange={(event) => { poKeyRef.current = null; setCurrency(event.target.value.toUpperCase()); }} maxLength={3} disabled={busy} /></label>
          <label className="field"><span>未稅單價（選填）</span><input type="number" min={0} step="0.0001" value={unitPrice} onChange={(event) => { poKeyRef.current = null; setUnitPrice(event.target.value); }} disabled={busy} /></label>
          <label className="field"><span>稅率（選填）</span><input type="number" min={0} step="0.01" value={taxRate} onChange={(event) => { poKeyRef.current = null; setTaxRate(event.target.value); }} disabled={busy} /></label>
        </div>
        <div className="button-row"><button className="secondary-button" type="button" onClick={() => void createPurchaseOrder()} disabled={busy || !identityReady || !poNo.trim() || orderedQuantity <= 0}>{busy ? "建立中…" : "建立採購單"}</button></div>
      </div>
    </> : null}
    {displayMessage ? <p className={displayMessage.startsWith("已") ? "success-note" : "auth-message"} role="status">{displayMessage}</p> : null}
      </div>
    </div>
  </section>;
}
