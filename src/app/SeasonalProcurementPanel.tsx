"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "@/src/app/ManagementCatalogTable";
import { filterSeasonalProcurementQueue, sortSeasonalProcurementQueue, type SeasonalProcurementQueueRow, type SeasonalProcurementSortDirection, type SeasonalProcurementSortKey } from "@/src/domain/seasonal-procurement";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

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
  const client = getSupabaseBrowserClient();
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
  const decisionKeyRef = useRef<string | null>(null);
  const poKeyRef = useRef<string | null>(null);

  const selectedLine = useMemo(() => lines.find((line) => line.id === lineId), [lines, lineId]);
  const availableSuppliers = useMemo(
    () => supplierItems.filter((relation) => relation.item_id === selectedLine?.item_id && relation.minimum_order_quantity !== 0 && suppliers.some((supplier) => supplier.id === relation.supplier_id)),
    [selectedLine, supplierItems, suppliers],
  );
  const selectedRelation = availableSuppliers.find((relation) => relation.supplier_id === supplierId);
  const selectedSupplier = suppliers.find((supplier) => supplier.id === supplierId);
  const existingDecision = procurementLines.find((line) => line.approval_line_id === lineId);
  const queueRows: SeasonalProcurementQueueRow[] = useMemo(() => lines.map((line) => {
    const decision = procurementLines.find((row) => row.approval_line_id === line.id);
    return {
      id: line.id,
      itemCode: line.item_code_snapshot,
      itemName: line.item_name_snapshot,
      size: line.size_snapshot,
      approvedQuantity: line.approved_quantity,
      decisionStatus: decision ? "DECIDED" : "PENDING",
      finalPurchaseQuantity: decision?.final_purchase_quantity ?? null,
    };
  }), [lines, procurementLines]);
  const filteredQueueRows = useMemo(() => filterSeasonalProcurementQueue(queueRows, queueQuery), [queueQuery, queueRows]);
  const sortedQueueRows = useMemo(() => sortSeasonalProcurementQueue(filteredQueueRows, queueSortKey, queueSortDirection), [filteredQueueRows, queueSortDirection, queueSortKey]);

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      const [approvalResult, supplierResult, relationResult, reasonResult, decisionResult] = await Promise.all([
        supabase.from("seasonal_approval_lines").select("id,item_id,item_code_snapshot,item_name_snapshot,size_snapshot,unit_snapshot,approved_quantity,seasonal_approvals!inner(status)").eq("seasonal_approvals.status", "APPROVED").order("item_code_snapshot"),
        supabase.from("suppliers").select("id,supplier_code,name,default_currency").eq("is_active", true).order("supplier_code"),
        supabase.from("supplier_uniform_items").select("supplier_id,item_id,minimum_order_quantity").eq("is_active", true),
        supabase.from("procurement_difference_reasons").select("code,name").eq("is_active", true).order("code"),
        supabase.from("seasonal_procurement_lines").select("id,approval_line_id,supplier_id,final_purchase_quantity,minimum_order_quantity_snapshot"),
      ]);
      if (!active) return;
      if (approvalResult.error || supplierResult.error || relationResult.error || decisionResult.error || reasonResult.error) {
        setMessage("採購資料載入失敗，請確認 PROCUREMENT 角色與 RLS 權限。");
        return;
      }
      const nextLines = (approvalResult.data ?? []).map((row) => {
        const raw = row as ApprovalLine & { seasonal_approvals?: unknown };
        return { id: raw.id, item_id: raw.item_id, item_code_snapshot: raw.item_code_snapshot, item_name_snapshot: raw.item_name_snapshot, size_snapshot: raw.size_snapshot, unit_snapshot: raw.unit_snapshot, approved_quantity: raw.approved_quantity };
      });
      setLines(nextLines);
      setSuppliers((supplierResult.data ?? []) as Supplier[]);
      setSupplierItems((relationResult.data ?? []) as SupplierItem[]);
      setDifferenceReasons((reasonResult.data ?? []) as DifferenceReason[]);
      const loadedDecisions = (decisionResult.data ?? []) as ProcurementLine[];
      const loadedRelations = (relationResult.data ?? []) as SupplierItem[];
      setProcurementLines(loadedDecisions);
      if (nextLines[0]) {
        const first = nextLines[0];
        const existing = loadedDecisions.find((row) => row.approval_line_id === first.id);
        const relation = loadedRelations.find((row) => row.item_id === first.item_id && row.minimum_order_quantity !== 0);
        setLineId(first.id);
        const initialSupplierId = existing?.supplier_id ?? relation?.supplier_id ?? "";
        setSupplierId(initialSupplierId);
        setCurrency((supplierResult.data as Supplier[] | null)?.find((row) => row.id === initialSupplierId)?.default_currency ?? "");
        setFinalQuantity(existing?.final_purchase_quantity ?? first.approved_quantity);
        setOrderedQuantity(existing?.final_purchase_quantity ?? first.approved_quantity);
        setProcurementId(existing?.id ?? "");
      }
    }
    void load();
    return () => { active = false; };
  }, [client]);

  function resetDecisionKey() { decisionKeyRef.current = null; poKeyRef.current = null; }

  function selectApprovalLine(nextId: string) {
    const nextLine = lines.find((line) => line.id === nextId);
    if (!nextLine) return;
    const existing = procurementLines.find((line) => line.approval_line_id === nextLine.id);
    const relation = supplierItems.find((row) => row.item_id === nextLine.item_id && row.minimum_order_quantity !== 0);
    resetDecisionKey();
    setLineId(nextId);
    setSupplierId(existing?.supplier_id ?? relation?.supplier_id ?? "");
    setCurrency(suppliers.find((supplier) => supplier.id === (existing?.supplier_id ?? relation?.supplier_id))?.default_currency ?? "");
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
    if (!client || !selectedLine || !supplierId || finalQuantity < 0) { setMessage("請選擇核准品號、供應商並輸入採購量。"); return; }
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
    if (error) setMessage(`採購決策失敗：${error.message}`);
    else {
      const saved = data as ProcurementLine;
      setProcurementId(saved.id); setProcurementLines((rows) => [...rows, saved]); setMessage("已保存採購決策；原始核准量與 MOQ 快照已鎖定。");
      decisionKeyRef.current = null; setDifferenceReason(""); setNote("");
    }
    setBusy(false);
  }

  async function createPurchaseOrder() {
    if (!client || !procurementId || !poNo.trim() || orderedQuantity <= 0) { setMessage("請先完成採購決策，並填寫採購單號與下單量。"); return; }
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
    if (error) setMessage(`採購單建立失敗：${error.message}`);
    else { setMessage(`採購單 ${poNo.trim()} 已建立並進入 ORDERED。`); poKeyRef.current = null; setPoNo(""); }
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="換季採購決策"><div className="panel-heading"><div><p className="eyebrow">11 / PROCUREMENT</p><h2>換季採購決策</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 PROCUREMENT 帳號後，依 CEO 核准量選擇供應商、確認 MOQ 並建立採購單。</p></section>;
  return <section className="panel import-panel" aria-label="換季採購決策">
    <div className="panel-heading"><div><p className="eyebrow">11 / PROCUREMENT</p><h2>換季採購決策</h2></div><span className="status-pill">核准後採購</span></div>
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
          defaultPageSize={10}
          pageSizeOptions={[5, 10, 25, 50]}
          emptyState={<p className="empty-state">{queueRows.length === 0 ? "目前沒有可採購的 CEO 核准品項。" : "沒有符合搜尋的核准品項。"}</p>}
          tableClassName="seasonal-procurement-table"
        />
      </div>
      <div className="seasonal-procurement-review">
        <div className="subheading"><h3>採購決策工作區</h3><span>原始核准量與 MOQ 快照保存後不可覆寫</span></div>
        <div className="form-grid">
      <label className="field"><span>CEO 核准品項</span><select value={lineId} onChange={(event) => selectApprovalLine(event.target.value)} disabled={busy}><option value="">請選擇</option>{lines.map((line) => <option key={line.id} value={line.id}>{line.item_code_snapshot}｜{line.item_name_snapshot}{line.size_snapshot ? `｜${line.size_snapshot}` : ""}（核准 {line.approved_quantity}）</option>)}</select></label>
      <label className="field"><span>供應商</span><select value={supplierId} onChange={(event) => { const nextSupplierId = event.target.value; resetDecisionKey(); setSupplierId(nextSupplierId); setCurrency(suppliers.find((supplier) => supplier.id === nextSupplierId)?.default_currency ?? ""); }} disabled={busy || Boolean(existingDecision)}><option value="">請選擇</option>{availableSuppliers.map((relation) => { const supplier = suppliers.find((row) => row.id === relation.supplier_id); return <option key={relation.supplier_id} value={relation.supplier_id}>{supplier?.supplier_code}｜{supplier?.name}（MOQ {relation.minimum_order_quantity ?? "未設定"}）</option>; })}</select></label>
      <label className="field"><span>最終採購量</span><input type="number" min={0} max={999999999} value={finalQuantity} onChange={(event) => { resetDecisionKey(); setFinalQuantity(Math.max(0, Number(event.target.value) || 0)); }} disabled={busy || Boolean(existingDecision)} /></label>
      <div className="metric"><span>核准量／MOQ</span><strong>{selectedLine?.approved_quantity ?? 0}／{selectedRelation?.minimum_order_quantity ?? "—"}</strong><small>{selectedSupplier ? `${selectedSupplier.supplier_code}｜${selectedSupplier.name}` : "請先選擇供應商"}</small></div>
    </div>
    <label className="field reason-field"><span>差異原因碼（採購量不同時必填）</span><select value={differenceReason} onChange={(event) => { resetDecisionKey(); setDifferenceReason(event.target.value); }} disabled={busy || Boolean(existingDecision)}><option value="">請選擇原因碼</option>{differenceReasons.map((reason) => <option key={reason.code} value={reason.code}>{reason.code}｜{reason.name}</option>)}</select></label>
    <label className="field reason-field"><span>備註（選填）</span><input value={note} onChange={(event) => { resetDecisionKey(); setNote(event.target.value); }} maxLength={2000} disabled={busy || Boolean(existingDecision)} /></label>
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void saveDecision()} disabled={busy || !selectedLine || !supplierId || Boolean(existingDecision)}>{busy ? "儲存中…" : existingDecision ? "採購決策已保存" : "保存採購決策"}</button></div>
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
        <div className="button-row"><button className="secondary-button" type="button" onClick={() => void createPurchaseOrder()} disabled={busy || !poNo.trim() || orderedQuantity <= 0}>{busy ? "建立中…" : "建立採購單"}</button></div>
      </div>
    </> : null}
    {message ? <p className={message.startsWith("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
      </div>
    </div>
  </section>;
}
