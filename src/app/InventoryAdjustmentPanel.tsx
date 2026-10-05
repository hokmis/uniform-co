"use client";

import { useEffect, useRef, useState } from "react";
import { adjustmentSampleCsv, parseAdjustmentCsv, signedAdjustmentQuantity, type AdjustmentLine } from "@/src/domain/inventory-adjustment";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { loadActiveItemOptions, loadActiveWarehouseOptions, type ActiveItemOption, type ActiveWarehouseOption } from "@/src/lib/master-data-cache";
import { readBrowserStorageEntries, writeBrowserStorageEntries, removeBrowserStorageEntries } from "@/src/lib/browser-operation-storage";
import { retrySupabaseQueriesAfterSessionRefresh, retrySupabaseRpcAfterSessionRefresh } from "@/src/lib/supabase-session";
import { useWorkspaceSession } from "./workspace-session";
import { usePanelActivity } from "./RetainedPanelSet";
import SearchableItemPicker from "./SearchableItemPicker";
import WorkflowActionBar from "./WorkflowActionBar";

type DraftLine = { item_id: string; quantity: string; reason: string };
type Payload = { p_warehouse_id: string; p_occurred_on: string; p_note: string; p_lines: AdjustmentLine[]; p_idempotency_key: string };
type Result = { id: string; adjustment_no: string; posting_id: string };
type Draft = { owner: string; warehouse: string; date: string; note: string; lines: DraftLine[]; pending: Payload | null; result: Result | null };
const today = () => new Date().toLocaleDateString("sv-SE");
const blankDraft = (owner: string): Draft => ({ owner, warehouse: "", date: today(), note: "", lines: [], pending: null, result: null });
const errors: Record<string, string> = {
  ADJUSTMENT_INSUFFICIENT_STOCK: "減少數量超過目前庫存，整張調整單未過帳。",
  ADJUSTMENT_RESERVED_STOCK: "減少數量會侵占已保留的請領庫存，請先處理需求或使用盤點流程。",
  ADJUSTMENT_UNAUTHORIZED: "目前帳號沒有此倉庫的調整權限。",
  ADJUSTMENT_INVALID_ITEM: "品號已停用或不存在，請重新核對。",
  ADJUSTMENT_INVALID_WAREHOUSE: "倉庫已停用或不存在。",
  ADJUSTMENT_INVALID_INPUT: "調整內容不合法，請核對日期、非零整數數量與原因。",
  ADJUSTMENT_DUPLICATE_ITEM: "同張單據不可重複品號。",
};

export default function InventoryAdjustmentPanel() {
  const { client, authUserId, accountId, roles, isAuthenticated, identityLoading, identityError } = useWorkspaceSession();
  const active = usePanelActivity();
  const owner = `${authUserId ?? ""}:${accountId ?? ""}:${[...roles].sort().join(",")}`;
  const ready = Boolean(client && isAuthenticated && accountId && !identityLoading && !identityError);
  const [draft, setDraft] = useState<Draft>(() => blankDraft(owner));
  const [snapshot, setSnapshot] = useState<{ owner: string; items: ActiveItemOption[]; warehouses: ActiveWarehouseOption[] }>({ owner: "", items: [], warehouses: [] });
  const [balanceSnapshot, setBalanceSnapshot] = useState<{ scope: string; rows: Record<string, number> } | null>(null);
  const [message, setMessage] = useState("");
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reload, setReload] = useState(0);
  const [restoredOwner, setRestoredOwner] = useState("");
  const flight = useRef(false);
  const currentOwner = useRef(owner);
  useEffect(() => { currentOwner.current = owner; }, [owner]);
  const visible = draft.owner === owner ? draft : blankDraft(owner);
  const items = snapshot.owner === owner ? snapshot.items : [];
  const warehouses = snapshot.owner === owner ? snapshot.warehouses : [];
  const scope = `${owner}:${visible.warehouse}`;
  const balances = balanceSnapshot?.scope === scope ? balanceSnapshot.rows : {};
  const storageKey = `inventory-adjustment:${authUserId}:${accountId}`;
  const locked = busy || importing || Boolean(visible.pending || visible.result) || !ready || restoredOwner !== owner;

  useEffect(() => {
    if (!ready || !active) return;
    let alive = true;
    async function restoreAndRead() {
      const saved = readBrowserStorageEntries([storageKey]);
      if (!saved.available) { if (alive) setReadError("無法讀取安全重試資訊，請開啟此網站的本機儲存權限。"); return; }
      if (restoredOwner !== owner && alive) {
        const next = blankDraft(owner);
        try {
          const pending: unknown = saved.values[storageKey] ? JSON.parse(saved.values[storageKey]!) : null;
          // Recovery state is never authorization; the RPC revalidates every field.
          if (pending && typeof pending === "object" && "p_lines" in pending && Array.isArray(pending.p_lines) && "p_warehouse_id" in pending && typeof pending.p_warehouse_id === "string" && "p_occurred_on" in pending && typeof pending.p_occurred_on === "string" && "p_note" in pending && typeof pending.p_note === "string" && "p_idempotency_key" in pending && typeof pending.p_idempotency_key === "string") {
            const payload = pending as Payload;
            if (!payload.p_lines.every((line) => line && typeof line.item_id === "string" && Number.isSafeInteger(line.quantity_delta) && typeof line.reason === "string")) throw new Error();
            Object.assign(next, { warehouse: payload.p_warehouse_id, date: payload.p_occurred_on, note: payload.p_note, pending: payload, lines: payload.p_lines.map((line) => ({ item_id: line.item_id, quantity: String(line.quantity_delta), reason: line.reason })) });
          } else if (pending !== null) throw new Error();
        } catch { if (alive) setReadError("重試資訊無法核對，請先核對庫存異動紀錄，勿重複建立單據。"); return; }
        setDraft(next); setRestoredOwner(owner);
      }
      const [itemData, warehouseData] = await Promise.all([loadActiveItemOptions(client!), loadActiveWarehouseOptions(client!)]);
      if (!alive) return;
      if (itemData.errors.length || warehouseData.errors.length) { setSnapshot({ owner: "", items: [], warehouses: [] }); setReadError("品號或倉庫讀取失敗，請重新載入。"); return; }
      setSnapshot({ owner, items: itemData.items, warehouses: warehouseData.warehouses.filter((warehouse) => roles.includes(warehouse.purpose === "HR" ? "HR" : "WAREHOUSE")) });
      setReadError("");
    }
    void restoreAndRead();
    return () => { alive = false; };
  }, [client, ready, active, owner, storageKey, reload, restoredOwner, roles]);

  useEffect(() => {
    if (!ready || !active || !visible.warehouse || !client) return;
    let alive = true;
    async function readBalances() {
      const [result] = await retrySupabaseQueriesAfterSessionRefresh(client!, async () => [await client!.from("inventory_balances").select("item_id,on_hand_quantity").eq("warehouse_id", visible.warehouse)] as const);
      if (!alive) return;
      if (result.error) { setBalanceSnapshot(null); setReadError("庫存讀取失敗，請重新載入。"); return; }
      setBalanceSnapshot({ scope, rows: Object.fromEntries((result.data ?? []).map((row) => [row.item_id, Number(row.on_hand_quantity)])) });
    }
    void readBalances();
    return () => { alive = false; };
  }, [client, ready, active, scope, visible.warehouse, reload]);

  function edit(patch: Partial<Draft>) { if (!locked) setDraft({ ...visible, ...patch }); }
  async function importFile(file: File | undefined) {
    if (!file || locked || !items.length) return;
    if (file.size > 1_000_000) { setMessage("檔案不得超過 1 MB。"); return; }
    const importOwner = owner;
    setImporting(true);
    try {
      const rows = parseAdjustmentCsv(await file.text());
      const lines = rows.map((row) => {
        const item = items.find((item) => item.item_code === row.item_code);
        if (!item) throw new Error("匯入包含不存在或停用的品號，請核對檔案。");
        return { item_id: item.id, quantity: String(row.quantity_delta), reason: row.reason };
      });
      if (currentOwner.current !== importOwner || flight.current) return;
      setDraft((previous) => previous.owner === importOwner && !previous.pending && !previous.result ? { ...previous, lines } : previous);
      setMessage(`已載入 ${lines.length} 筆預覽，尚未異動庫存；請核對後確認。`);
    } catch (error) { if (currentOwner.current === importOwner) setMessage(error instanceof Error ? error.message : "CSV 格式錯誤。"); }
    finally { setImporting(false); }
  }
  function downloadSample() {
    const blob = new Blob([adjustmentSampleCsv(items.map((item) => item.item_code))], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = "sample-inventory-adjustment.csv"; link.click(); URL.revokeObjectURL(url);
  }
  async function complete() {
    if (!client || !ready || flight.current || importing || restoredOwner !== owner || visible.result) return;
    let payload = visible.pending;
    if (!payload) {
      try {
        if (!warehouses.some((warehouse) => warehouse.id === visible.warehouse) || !visible.date || !visible.lines.length || visible.lines.length > 1000) throw new Error("請選倉庫、日期及 1–1000 個品號。");
        const lines = visible.lines.map((line) => {
          if (!items.some((item) => item.id === line.item_id) || !line.reason.trim() || line.reason.length > 500) throw new Error("每個品號都須填寫調整原因。");
          return { item_id: line.item_id, quantity_delta: signedAdjustmentQuantity(line.quantity), reason: line.reason.trim() };
        });
        if (new Set(lines.map((line) => line.item_id)).size !== lines.length) throw new Error("品號不可重複。");
        if (!window.confirm("確認整張調整單？正數增加、負數減少，完成後立即寫入庫存異動紀錄。")) return;
        payload = { p_warehouse_id: visible.warehouse, p_occurred_on: visible.date, p_note: visible.note, p_lines: lines, p_idempotency_key: crypto.randomUUID() };
        if (!writeBrowserStorageEntries([[storageKey, JSON.stringify(payload)]])) throw new Error("無法保存重試資訊，未送出；請允許本機儲存後重試。");
        setDraft({ ...visible, pending: payload });
      } catch (error) { setMessage(error instanceof Error ? error.message : "請核對調整內容。"); return; }
    }
    const submittedOwner = owner;
    flight.current = true; setBusy(true);
    try {
      const result = await retrySupabaseRpcAfterSessionRefresh(client, async () => await client.rpc("complete_inventory_adjustment", payload!));
      if (currentOwner.current !== submittedOwner) return;
      if (result.error) {
        const safe = errors[result.error.message ?? ""];
        if (safe) { removeBrowserStorageEntries([storageKey]); setDraft((previous) => previous.owner === submittedOwner ? { ...previous, pending: null } : previous); setMessage(safe); }
        else setMessage("結果未知或無法完成，請保留本張內容重試同一操作；勿另建單據。必要時先核對庫存異動紀錄。");
        return;
      }
      const value = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!value?.id || !value?.posting_id || !value?.adjustment_no) { setMessage("回應無法核對，請保留原內容重試同次操作。"); return; }
      removeBrowserStorageEntries([storageKey]);
      setDraft((previous) => previous.owner === submittedOwner ? { ...previous, result: value, pending: null } : previous);
      setMessage(`已完成 ${value.adjustment_no}，庫存及異動紀錄已更新。`);
      notifyInventoryDataChanged(); setReload((value) => value + 1);
    } catch { if (currentOwner.current === submittedOwner) setMessage("連線結果未知，請重試目前調整單，勿重複建立。"); }
    finally { flight.current = false; setBusy(false); }
  }
  return <section className="panel">
    <p className="eyebrow">INVENTORY ADJUSTMENT</p><h2 id="warehouse-adjustment-title">庫存調整作業</h2>
    <p>輸入差額：正數增加、負數減少。可手動選品號或匯入 CSV；確認後一次完成，並留下單號與異動紀錄。</p>
    <div className="form-grid">
      <label className="field"><span>調整倉庫</span><select value={visible.warehouse} disabled={locked} onChange={(event) => edit({ warehouse: event.target.value })}><option value="">請選擇倉庫</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code}｜{warehouse.name}</option>)}</select></label>
      <label className="field"><span>異動日期</span><input type="date" value={visible.date} disabled={locked} onChange={(event) => edit({ date: event.target.value })} /></label>
      <label className="field"><span>備註（選填）</span><input maxLength={2000} value={visible.note} disabled={locked} onChange={(event) => edit({ note: event.target.value })} /></label>
    </div>
    <SearchableItemPicker label="選擇調整品號（可複選）" multiple disabled={locked || !items.length} options={items.map((item) => ({ id: item.id, code: item.item_code, name: item.item_name, size: item.size }))} value={visible.lines.map((line) => line.item_id)} onChange={(ids) => { if (Array.isArray(ids)) edit({ lines: ids.map((id) => visible.lines.find((line) => line.item_id === id) ?? { item_id: id, quantity: "", reason: "" }) }); }} />
    <div className="button-row"><label className="secondary-button">匯入 CSV（取代本張明細）<input type="file" accept=".csv,text/csv" disabled={locked || !items.length} onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} /></label><button type="button" className="secondary-button" onClick={downloadSample}>下載匯入範例 CSV</button><button type="button" className="secondary-button" disabled={busy || !ready} onClick={() => setReload((value) => value + 1)}>重新載入庫存</button></div>
    <div className="table-scroll"><table><thead><tr><th>品號／品名</th><th>目前庫存</th><th>調整數量（+／−）</th><th>預計調整後</th><th>原因（必填）</th><th>操作</th></tr></thead><tbody>{visible.lines.map((line, index) => {
      const item = items.find((item) => item.id === line.item_id), before = balances[line.item_id] ?? 0;
      const known = balanceSnapshot?.scope === scope;
      const quantity = /^[+-]?\d+$/.test(line.quantity) ? Number(line.quantity) : null;
      const update = (patch: Partial<DraftLine>) => edit({ lines: visible.lines.map((value, position) => position === index ? { ...value, ...patch } : value) });
      return <tr key={line.item_id}><td>{item?.item_code ?? "待核對品號"}｜{item?.item_name}</td><td>{known ? before : "待載入"}</td><td><input aria-label={`${item?.item_code ?? "品號"}調整數量`} type="text" inputMode="text" value={line.quantity} disabled={locked} placeholder="例如 10 或 -5" onChange={(event) => update({ quantity: event.target.value })} /></td><td>{known && quantity !== null ? before + quantity : "—"}</td><td><input aria-label={`${item?.item_code ?? "品號"}調整原因`} maxLength={500} value={line.reason} disabled={locked} onChange={(event) => update({ reason: event.target.value })} /></td><td><button type="button" className="text-button" disabled={locked} onClick={() => edit({ lines: visible.lines.filter((value) => value.item_id !== line.item_id) })}>移除</button></td></tr>;
    })}</tbody></table></div>
    <p>庫存為參考快照，送出時重新驗證；減量不可造成負庫存或侵占已保留的請領量。</p>
    {readError ? <p role="alert">{readError}</p> : null}
    <p role="status" aria-live="polite">{message}</p>
    <WorkflowActionBar primary={{ label: visible.pending ? "重試目前調整單" : "確認並完成調整", busyLabel: "正在調整庫存…", busy, disabled: busy || importing || !ready || restoredOwner !== owner || Boolean(visible.result) || (!visible.pending && (Boolean(readError) || !visible.lines.length || balanceSnapshot?.scope !== scope)), onClick: () => void complete() }} secondary={visible.result ? <button type="button" className="secondary-button" onClick={() => { setDraft(blankDraft(owner)); setMessage(""); }}>新增下一張調整單</button> : undefined} />
  </section>;
}
