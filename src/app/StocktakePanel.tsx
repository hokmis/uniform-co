"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

type Warehouse = { id: string; code: string; name: string; purpose: "HR" | "GENERAL" };
type Item = { id: string; item_code: string; item_name: string; unit: string; size: string | null };
type Balance = { item_id: string; on_hand_quantity: number; version: number };
type StocktakeLine = {
  id?: string;
  item_id: string;
  book_quantity_snapshot: number;
  balance_version_snapshot: number;
  counted_quantity: number;
  reason: string;
};
type Stocktake = { id: string; stocktake_no: string; warehouse_id: string; status: "DRAFT" | "STALE_COUNT" | "POSTED"; note: string | null };

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

function numberValue(value: string) {
  return Math.max(0, Number(value) || 0);
}

export default function StocktakePanel() {
  const client = getSupabaseBrowserClient();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [balances, setBalances] = useState<Record<string, Balance>>({});
  const [warehouseId, setWarehouseId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [stocktakeNo, setStocktakeNo] = useState(`COUNT-${taipeiToday().replaceAll("-", "")}`);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<StocktakeLine[]>([]);
  const [stocktake, setStocktake] = useState<Stocktake | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsRecountConfirmation, setNeedsRecountConfirmation] = useState(false);
  const createKeyRef = useRef<string | null>(null);
  const updateKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const selectedWarehouse = warehouses.find((warehouse) => warehouse.id === warehouseId);
  const canEdit = stocktake?.status === "DRAFT";

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      const [warehouseResult, itemResult] = await Promise.all([
        supabase.from("warehouses").select("id,code,name,purpose").eq("is_active", true).order("purpose"),
        supabase.from("uniform_items").select("id,item_code,item_name,unit,size").eq("is_active", true).order("item_code"),
      ]);
      if (!active) return;
      if (warehouseResult.error || itemResult.error) {
        setMessage("盤點主檔載入失敗，請確認 HR／WAREHOUSE 角色與 RLS 權限。");
        return;
      }
      const loadedWarehouses = (warehouseResult.data ?? []) as Warehouse[];
      setWarehouses(loadedWarehouses);
      setItems((itemResult.data ?? []) as Item[]);
      if (loadedWarehouses[0]) setWarehouseId(loadedWarehouses[0].id);
    }
    void load();
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!client || !warehouseId || stocktake) return;
    const supabase = client;
    let active = true;
    async function loadBalances() {
      const result = await supabase.from("inventory_balances").select("item_id,on_hand_quantity,version").eq("warehouse_id", warehouseId);
      if (!active) return;
      if (result.error) { setMessage("帳面庫存載入失敗，請重新整理。"); return; }
      const next: Record<string, Balance> = {};
      for (const row of (result.data ?? []) as Balance[]) next[row.item_id] = row;
      setBalances(next);
    }
    void loadBalances();
    return () => { active = false; };
  }, [client, warehouseId, stocktake]);

  function resetOperationKeys() {
    createKeyRef.current = null;
    updateKeyRef.current = null;
    postKeyRef.current = null;
  }

  function changeWarehouse(nextId: string) {
    if (stocktake) return;
    resetOperationKeys();
    setWarehouseId(nextId);
    setLines([]);
    setSelectedItemId("");
  }

  function addLine() {
    if (!selectedItemId || lines.some((line) => line.item_id === selectedItemId)) return;
    const balance = balances[selectedItemId] ?? { item_id: selectedItemId, on_hand_quantity: 0, version: 0 };
    setLines((current) => [...current, {
      item_id: selectedItemId,
      book_quantity_snapshot: balance.on_hand_quantity,
      balance_version_snapshot: balance.version,
      counted_quantity: balance.on_hand_quantity,
      reason: "",
    }]);
    setSelectedItemId("");
    resetOperationKeys();
  }

  function updateLine(itemId: string, field: "counted_quantity" | "reason", value: string) {
    resetOperationKeys();
    setLines((current) => current.map((line) => line.item_id === itemId ? {
      ...line,
      [field]: field === "counted_quantity" ? numberValue(value) : value,
    } : line));
  }

  function removeLine(itemId: string) {
    if (stocktake) return;
    resetOperationKeys();
    setLines((current) => current.filter((line) => line.item_id !== itemId));
  }

  async function loadDraftLines(stocktakeId: string) {
    if (!client) return;
    const result = await client.from("stocktake_lines")
      .select("id,item_id,book_quantity_snapshot,balance_version_snapshot,counted_quantity,reason")
      .eq("stocktake_id", stocktakeId).order("item_id");
    if (result.error) throw result.error;
    setLines((result.data ?? []) as StocktakeLine[]);
  }

  function fingerprint() {
    return JSON.stringify({ warehouseId, stocktakeNo: stocktake?.stocktake_no ?? stocktakeNo.trim(), note: note.trim(), lines });
  }

  async function createDraft() {
    if (!client || !warehouseId || !stocktakeNo.trim() || lines.length === 0) {
      setMessage("請選擇倉庫、填寫盤點單號並至少加入一個品號。"); return;
    }
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = key;
    const { data, error } = await client.rpc("create_stocktake_draft", {
      p_stocktake_no: stocktakeNo.trim(), p_warehouse_id: warehouseId, p_note: note.trim() || null,
      p_lines: lines.map((line) => ({ itemId: line.item_id, countedQuantity: line.counted_quantity, reason: line.reason.trim() })),
      p_idempotency_key: `CREATE-STOCKTAKE-${key}`, p_request_fingerprint: fingerprint(),
    });
    if (error || !data?.id) {
      setMessage(`盤點草稿結果尚未確認：${error?.message ?? "請使用相同操作重試，系統會查回既有結果"}`);
      setBusy(false); return;
    }
    const created = data as Stocktake;
    setStocktake(created);
    createKeyRef.current = null;
    try {
      await loadDraftLines(created.id);
      setMessage(`已建立盤點草稿 ${created.stocktake_no}；請完成實盤後保存或 POST。`);
    } catch (loadError) {
      setMessage(`盤點草稿已建立，但明細載入失敗：${loadError instanceof Error ? loadError.message : "請重新整理"}`);
    }
    setBusy(false);
  }

  async function updateDraft(linesToSave = lines) {
    if (!client || !stocktake || !canEdit || linesToSave.length === 0) return;
    setBusy(true); setMessage("");
    const key = updateKeyRef.current ?? crypto.randomUUID();
    updateKeyRef.current = key;
    const requestFingerprint = JSON.stringify({ stocktakeId: stocktake.id, note: note.trim(), lines: linesToSave, recount: false });
    const { data, error } = await client.rpc("update_stocktake_draft", {
      p_stocktake_id: stocktake.id, p_note: note.trim() || null,
      p_recount: false,
      p_lines: linesToSave.map((line) => ({ itemId: line.item_id, countedQuantity: line.counted_quantity, reason: line.reason.trim() })),
      p_idempotency_key: `UPDATE-STOCKTAKE-${key}`, p_request_fingerprint: requestFingerprint,
    });
    if (error || !data?.id) {
      setMessage(`盤點草稿更新結果尚未確認：${error?.message ?? "請使用相同操作重試，系統會查回既有結果"}`);
      setBusy(false); return;
    }
    updateKeyRef.current = null;
    setStocktake(data as Stocktake);
    setNeedsRecountConfirmation(false);
    await loadDraftLines(stocktake.id);
    setMessage("盤點帳面與版本已重新擷取；請確認實盤數量後再 POST。");
    setBusy(false);
  }

  async function recaptureBook() {
    if (!client || !stocktake || lines.length === 0) return;
    const result = await client.from("inventory_balances").select("item_id,on_hand_quantity,version").eq("warehouse_id", stocktake.warehouse_id);
    if (result.error) { setMessage(`重新擷取帳面失敗：${result.error.message}`); return; }
    const fresh = new Map((result.data ?? []).map((row) => [row.item_id, row as Balance]));
    const resetLines = lines.map((line) => {
      const balance = fresh.get(line.item_id) ?? { item_id: line.item_id, on_hand_quantity: 0, version: 0 };
      return { ...line, book_quantity_snapshot: balance.on_hand_quantity, balance_version_snapshot: balance.version, counted_quantity: balance.on_hand_quantity, reason: "" };
    });
    setLines(resetLines);
    setBusy(true); setMessage("");
    const key = updateKeyRef.current ?? crypto.randomUUID();
    updateKeyRef.current = key;
    const { data, error } = await client.rpc("update_stocktake_draft", {
      p_stocktake_id: stocktake.id, p_note: `RECOUNT_CONFIRMED:${note.trim()}`, p_recount: true,
      p_lines: resetLines.map((line) => ({ itemId: line.item_id, countedQuantity: line.counted_quantity, reason: "" })),
      p_idempotency_key: `RECOUNT-STOCKTAKE-${key}`,
      p_request_fingerprint: JSON.stringify({ stocktakeId: stocktake.id, note: note.trim(), lines: resetLines, recount: true }),
    });
    if (error || !data?.id) { setMessage(`重新擷取帳面結果尚未確認：${error?.message ?? "請使用相同操作重試"}`); setBusy(false); return; }
    updateKeyRef.current = null;
    setStocktake(data as Stocktake);
    setNeedsRecountConfirmation(true);
    setMessage("已重新擷取帳面並將實盤量重設為最新帳面；請重新確認實盤後保存，再 POST。");
    setBusy(false);
  }

  async function postStocktake() {
    if (!client || !stocktake || stocktake.status !== "DRAFT") return;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID();
    postKeyRef.current = key;
    const { data, error } = await client.rpc("post_stocktake", {
      p_stocktake_id: stocktake.id, p_idempotency_key: `POST-STOCKTAKE-${key}`,
      p_request_fingerprint: JSON.stringify({ stocktakeId: stocktake.id, lines }),
    });
    if (error) {
      setMessage(`盤點 POST 結果尚未確認：${error.message}；請使用相同操作重試，避免建立第二筆流水。`);
      setBusy(false); return;
    }
    const posted = data as Stocktake;
    setStocktake(posted);
    postKeyRef.current = null;
    if (posted.status === "STALE_COUNT") {
      setMessage("帳面版本已變更，盤點標記為 STALE_COUNT；請重新擷取帳面並重新實盤，不能沿用舊數量。");
    } else {
      setMessage("盤點已 POST；差額已寫入不可變庫存流水，帳面餘額已同步更新。");
    }
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="庫存盤點"><div className="panel-heading"><div><p className="eyebrow">08 / STOCKTAKE</p><h2>庫存盤點</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 HR／WAREHOUSE 帳號後，選擇對應倉庫、擷取帳面版本、填寫實盤量，再由資料庫以版本 fencing POST。</p></section>;

  return <section className="panel import-panel" aria-label="庫存盤點">
    <div className="panel-heading"><div><p className="eyebrow">08 / STOCKTAKE</p><h2>庫存盤點</h2></div><span className={`status-pill ${stocktake?.status === "POSTED" ? "success" : stocktake?.status === "STALE_COUNT" ? "danger" : ""}`}>{stocktake?.status ?? "建立盤點"}</span></div>
    <p className="auth-message">盤點單會保存帳面數量與 balance version；POST 前資料庫會重新鎖定品號、餘額與預留。版本過期會標記 STALE_COUNT，不能自動套用舊實盤。</p>
    <div className="form-grid">
      <label className="field"><span>盤點倉庫</span><select value={warehouseId} onChange={(event) => changeWarehouse(event.target.value)} disabled={busy || Boolean(stocktake)}><option value="">請選擇</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code}｜{warehouse.name}（{warehouse.purpose === "HR" ? "人資倉" : "總倉"}）</option>)}</select></label>
      <label className="field"><span>盤點單號</span><input value={stocktakeNo} onChange={(event) => { resetOperationKeys(); setStocktakeNo(event.target.value); }} disabled={busy || Boolean(stocktake)} maxLength={80} /></label>
      <label className="field"><span>加入品號</span><select value={selectedItemId} onChange={(event) => setSelectedItemId(event.target.value)} disabled={busy || Boolean(stocktake) || !warehouseId}><option value="">請選擇品號</option>{items.filter((item) => !lines.some((line) => line.item_id === item.id)).map((item) => <option key={item.id} value={item.id}>{item.item_code}｜{item.item_name}{item.size ? `｜${item.size}` : ""}</option>)}</select></label>
      <div className="field"><span>&nbsp;</span><button className="secondary-button" type="button" onClick={addLine} disabled={busy || Boolean(stocktake) || !selectedItemId}>加入盤點品號</button></div>
    </div>
    <label className="field reason-field"><span>盤點備註（選填）</span><input value={note} onChange={(event) => { resetOperationKeys(); setNote(event.target.value); }} disabled={busy || stocktake?.status === "POSTED"} maxLength={2000} /></label>
    {lines.length > 0 ? <div className="summary-list">{lines.map((line) => { const item = itemById.get(line.item_id); const difference = line.counted_quantity - line.book_quantity_snapshot; return <div className="summary-row" key={line.item_id}><span><strong>{item?.item_code ?? line.item_id}｜{item?.item_name ?? "品號"}</strong><small>帳面 {line.book_quantity_snapshot}／版本 {line.balance_version_snapshot}／差額 {difference}</small></span><label className="field"><span className="sr-only">實盤量</span><input type="number" min={0} value={line.counted_quantity} disabled={busy || !canEdit} onChange={(event) => updateLine(line.item_id, "counted_quantity", event.target.value)} /></label><label className="field"><span className="sr-only">差異原因</span><input value={line.reason} disabled={busy || !canEdit} onChange={(event) => updateLine(line.item_id, "reason", event.target.value)} placeholder={difference === 0 ? "無差異" : "差異原因（必填）"} maxLength={500} /></label>{!stocktake ? <button className="text-button" type="button" onClick={() => removeLine(line.item_id)} disabled={busy}>移除</button> : null}</div>; })}</div> : <p className="auth-message">請先加入要盤點的品號。</p>}
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void createDraft()} disabled={busy || Boolean(stocktake) || lines.length === 0}>{busy ? "建立中…" : "建立盤點草稿"}</button>{stocktake?.status === "DRAFT" ? <button className="secondary-button" type="button" onClick={() => void updateDraft()} disabled={busy || lines.length === 0}>{busy ? "保存中…" : "保存盤點草稿"}</button> : null}{stocktake?.status === "STALE_COUNT" ? <button className="secondary-button" type="button" onClick={() => void recaptureBook()} disabled={busy}>{busy ? "擷取中…" : "重新擷取帳面並開始重盤"}</button> : null}{stocktake?.status === "DRAFT" ? <button className="secondary-button" type="button" onClick={() => void postStocktake()} disabled={busy || needsRecountConfirmation || lines.length === 0 || lines.some((line) => line.counted_quantity - line.book_quantity_snapshot !== 0 && !line.reason.trim())}>{busy ? "POST 中…" : needsRecountConfirmation ? "請先保存重新實盤" : "確認並 POST 盤點"}</button> : null}</div>
    {stocktake?.status === "POSTED" ? <p className="success-note">盤點單 {stocktake.stocktake_no} 已 POST，原盤點與流水均已鎖定。</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
