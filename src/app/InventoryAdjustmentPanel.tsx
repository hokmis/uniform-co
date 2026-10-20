"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { adjustmentSampleCsv, parseAdjustmentCsv, signedAdjustmentQuantity, type AdjustmentLine } from "@/src/domain/inventory-adjustment";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { STANDARD_UNIFORM_SIZES } from "@/src/domain/uniform-size";
import { loadActiveItemOptions, loadActiveWarehouseOptions, type ActiveItemOption, type ActiveWarehouseOption } from "@/src/lib/master-data-cache";
import { readBrowserStorageEntries, writeBrowserStorageEntries, removeBrowserStorageEntries } from "@/src/lib/browser-operation-storage";
import { retrySupabaseQueriesAfterSessionRefresh, retrySupabaseRpcAfterSessionRefresh } from "@/src/lib/supabase-session";
import { useWorkspaceSession } from "./workspace-session";
import { usePanelActivity } from "./RetainedPanelSet";
import WorkflowActionBar from "./WorkflowActionBar";

type UniformCategoryKey = "ALL" | "照服" | "護士" | "行政" | "廚師" | "工務" | "幼兒園" | "OTHER";
type GenderFilterKey = "ALL" | "MALE" | "FEMALE";
type SeasonFilterKey = "ALL" | "SUMMER" | "WINTER";

function getUniformCategory(itemName: string, itemCode: string): UniformCategoryKey {
  const name = itemName || "";
  const code = itemCode || "";
  if (name.includes("照服") || code.includes("照服")) return "照服";
  if (name.includes("護士") || code.includes("護士")) return "護士";
  if (name.includes("行政") || code.includes("行政")) return "行政";
  if (name.includes("廚師") || code.includes("廚師")) return "廚師";
  if (name.includes("工務") || code.includes("工務")) return "工務";
  if (name.includes("幼兒園") || name.includes("幼") || code.includes("幼")) return "幼兒園";
  return "OTHER";
}

function getUniformGender(itemName: string, size?: string | null): GenderFilterKey {
  const text = `${itemName || ""} ${size || ""}`;
  const hasMale = text.includes("男");
  const hasFemale = text.includes("女");
  if (hasMale && !hasFemale) return "MALE";
  if (hasFemale && !hasMale) return "FEMALE";
  return "ALL";
}

function getUniformSeason(itemName: string): SeasonFilterKey | "ALL_SEASON" {
  const name = itemName || "";
  const hasSummer = name.includes("夏");
  const hasWinter = name.includes("冬");
  if (hasSummer && hasWinter) return "ALL_SEASON";
  if (hasSummer) return "SUMMER";
  if (hasWinter) return "WINTER";
  return "ALL_SEASON";
}

function extractSize(item: ActiveItemOption): string {
  if (item.size) return item.size.trim().toUpperCase();
  const match = item.item_name.match(/-[男女]?([A-Za-z0-9]+)$/);
  return match ? match[1].toUpperCase() : "";
}

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
  const [categoryFilter, setCategoryFilter] = useState<UniformCategoryKey>("ALL");
  const [genderFilter, setGenderFilter] = useState<GenderFilterKey>("ALL");
  const [seasonFilter, setSeasonFilter] = useState<SeasonFilterKey>("ALL");
  const [sizeFilter, setSizeFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const flight = useRef(false);
  const currentOwner = useRef(owner);
  useEffect(() => { currentOwner.current = owner; }, [owner]);
  const visible = draft.owner === owner ? draft : blankDraft(owner);
  const items = useMemo(() => snapshot.owner === owner ? snapshot.items : [], [snapshot.owner, snapshot.items, owner]);
  const warehouses = useMemo(() => snapshot.owner === owner ? snapshot.warehouses : [], [snapshot.owner, snapshot.warehouses, owner]);
  const scope = `${owner}:${visible.warehouse}`;
  const balances = balanceSnapshot?.scope === scope ? balanceSnapshot.rows : {};
  const storageKey = `inventory-adjustment:${authUserId}:${accountId}`;
  const locked = busy || importing || Boolean(visible.pending || visible.result) || !ready || restoredOwner !== owner;

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {
      ALL: items.length,
      "照服": 0, "護士": 0, "行政": 0, "廚師": 0, "工務": 0, "幼兒園": 0, OTHER: 0,
    };
    for (const item of items) {
      const cat = getUniformCategory(item.item_name, item.item_code);
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }, [items]);

  const categoryTabs = useMemo(() => {
    const base: { key: UniformCategoryKey; label: string }[] = [
      { key: "ALL", label: "全部" },
      { key: "照服", label: "照服" },
      { key: "護士", label: "護士" },
      { key: "行政", label: "行政" },
      { key: "廚師", label: "廚師" },
      { key: "工務", label: "工務" },
      { key: "幼兒園", label: "幼兒園" },
    ];
    if (categoryCounts.OTHER > 0) {
      base.push({ key: "OTHER", label: "其他" });
    }
    return base.map((cat) => ({
      ...cat,
      count: categoryCounts[cat.key] || 0,
    }));
  }, [categoryCounts]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (categoryFilter !== "ALL") {
        const cat = getUniformCategory(item.item_name, item.item_code);
        if (cat !== categoryFilter) return false;
      }
      if (genderFilter !== "ALL") {
        const g = getUniformGender(item.item_name, item.size);
        if (g !== genderFilter) return false;
      }
      if (seasonFilter !== "ALL") {
        const s = getUniformSeason(item.item_name);
        if (seasonFilter === "SUMMER" && s !== "SUMMER" && s !== "ALL_SEASON") return false;
        if (seasonFilter === "WINTER" && s !== "WINTER" && s !== "ALL_SEASON") return false;
      }
      if (sizeFilter !== "ALL") {
        const sz = extractSize(item);
        if (sz !== sizeFilter) return false;
      }
      if (q) {
        const matchCode = item.item_code.toLowerCase().includes(q);
        const matchName = item.item_name.toLowerCase().includes(q);
        const matchSize = item.size && item.size.toLowerCase().includes(q);
        if (!matchCode && !matchName && !matchSize) return false;
      }
      return true;
    });
  }, [categoryFilter, genderFilter, items, searchQuery, seasonFilter, sizeFilter]);

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const pagedItems = useMemo(
    () => filteredItems.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [currentPage, filteredItems, pageSize],
  );

  function toggleItemTag(itemId: string) {
    if (locked) return;
    const exists = visible.lines.some((line) => line.item_id === itemId);
    if (exists) {
      edit({ lines: visible.lines.filter((line) => line.item_id !== itemId) });
    } else {
      edit({ lines: [...visible.lines, { item_id: itemId, quantity: "", reason: "" }] });
    }
  }

  function addAllFiltered() {
    if (locked || !filteredItems.length) return;
    const existing = new Set(visible.lines.map((l) => l.item_id));
    const unadded = filteredItems.filter((it) => !existing.has(it.id));
    if (!unadded.length) return;
    const newLines = unadded.map((it) => ({ item_id: it.id, quantity: "", reason: "" }));
    edit({ lines: [...visible.lines, ...newLines] });
  }

  function clearAllLines() {
    if (locked || !visible.lines.length) return;
    edit({ lines: [] });
  }

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
    <div className="adjustment-tag-section" style={{ margin: "16px 0", padding: "16px", background: "var(--card-subtle, #f8fbf8)", border: "1px solid var(--line, #e0e6df)", borderRadius: "14px" }}>
      {/* 1. 一級分類標籤（膠囊式按鈕，帶徽章） */}
      <div
        role="tablist"
        aria-label="制服品項分類"
        style={{
          display: "flex",
          gap: "6px",
          flexWrap: "wrap",
          marginBottom: "12px",
          paddingBottom: "8px",
          borderBottom: "1px solid var(--line, #e5e9ef)",
        }}
      >
        {categoryTabs.map((cat) => {
          const isActive = categoryFilter === cat.key;
          return (
            <button
              key={`adj-cat-${cat.key}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              disabled={locked}
              onClick={() => {
                setCategoryFilter(cat.key);
                setPage(1);
              }}
              style={{
                padding: "6px 12px",
                borderRadius: "8px",
                border: isActive ? "1px solid var(--accent, #2563eb)" : "1px solid #e2e8f0",
                background: isActive ? "var(--accent, #2563eb)" : "#f8fafc",
                color: isActive ? "#fff" : "#475569",
                fontWeight: isActive ? 700 : 500,
                fontSize: "13px",
                cursor: locked ? "not-allowed" : "pointer",
                transition: "all 0.15s ease",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <span>{cat.label}</span>
              <span
                style={{
                  fontSize: "11px",
                  padding: "1px 5px",
                  borderRadius: "10px",
                  background: isActive ? "rgba(255, 255, 255, 0.25)" : "#e2e8f0",
                  color: isActive ? "#fff" : "#64748b",
                }}
              >
                {cat.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 2. 次級篩選列（性別、季節、尺寸、搜尋、分頁） */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "10px",
          marginBottom: "14px",
          background: "#f8fafc",
          padding: "10px 14px",
          borderRadius: "8px",
          border: "1px solid #e2e8f0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
          {/* 性別篩選按鈕群 */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>性別：</span>
            <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1" }}>
              {[
                { key: "ALL", label: "全部" },
                { key: "MALE", label: "男" },
                { key: "FEMALE", label: "女" },
              ].map((g) => {
                const active = genderFilter === g.key;
                return (
                  <button
                    key={`adj-gender-${g.key}`}
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      setGenderFilter(g.key as GenderFilterKey);
                      setPage(1);
                    }}
                    style={{
                      padding: "3px 9px",
                      fontSize: "12px",
                      border: "none",
                      borderRight: "1px solid #cbd5e1",
                      background: active ? "var(--accent, #2563eb)" : "#fff",
                      color: active ? "#fff" : "#334155",
                      fontWeight: active ? 700 : 400,
                      cursor: locked ? "not-allowed" : "pointer",
                    }}
                  >
                    {g.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 季節篩選按鈕群 */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>季節：</span>
            <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1" }}>
              {[
                { key: "ALL", label: "全部" },
                { key: "SUMMER", label: "夏季" },
                { key: "WINTER", label: "冬季" },
              ].map((s) => {
                const active = seasonFilter === s.key;
                return (
                  <button
                    key={`adj-season-${s.key}`}
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      setSeasonFilter(s.key as SeasonFilterKey);
                      setPage(1);
                    }}
                    style={{
                      padding: "3px 9px",
                      fontSize: "12px",
                      border: "none",
                      borderRight: "1px solid #cbd5e1",
                      background: active ? "var(--accent, #2563eb)" : "#fff",
                      color: active ? "#fff" : "#334155",
                      fontWeight: active ? 700 : 400,
                      cursor: locked ? "not-allowed" : "pointer",
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 尺寸篩選按鈕群 */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>尺寸：</span>
            <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1", maxWidth: "420px", overflowX: "auto" }}>
              {[
                { key: "ALL", label: "全部" },
                ...STANDARD_UNIFORM_SIZES.map((sz) => ({ key: sz, label: sz })),
              ].map((s) => {
                const active = sizeFilter === s.key;
                return (
                  <button
                    key={`adj-size-${s.key}`}
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      setSizeFilter(s.key);
                      setPage(1);
                    }}
                    style={{
                      padding: "3px 7px",
                      fontSize: "12px",
                      border: "none",
                      borderRight: "1px solid #cbd5e1",
                      background: active ? "var(--accent, #2563eb)" : "#fff",
                      color: active ? "#fff" : "#334155",
                      fontWeight: active ? 700 : 400,
                      cursor: locked ? "not-allowed" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 重設篩選 */}
          {categoryFilter !== "ALL" || genderFilter !== "ALL" || seasonFilter !== "ALL" || sizeFilter !== "ALL" || searchQuery ? (
            <button
              type="button"
              className="text-button"
              disabled={locked}
              onClick={() => {
                setCategoryFilter("ALL");
                setGenderFilter("ALL");
                setSeasonFilter("ALL");
                setSizeFilter("ALL");
                setSearchQuery("");
                setPage(1);
              }}
              style={{ fontSize: "12px", color: "#64748b", padding: "2px 4px" }}
            >
              重設篩選
            </button>
          ) : null}
        </div>

        {/* 搜尋框與微型分頁 */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <input
            type="search"
            placeholder="搜尋品號、品名或尺寸…"
            value={searchQuery}
            disabled={locked}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            style={{
              padding: "4px 10px",
              fontSize: "12px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              width: "180px",
              background: "#fff",
            }}
          />

          {totalPages > 1 ? (
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <button
                className="secondary-button"
                type="button"
                disabled={locked || currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                style={{ padding: "3px 8px", fontSize: "12px", margin: 0 }}
              >
                上一頁
              </button>
              <span style={{ alignSelf: "center", fontSize: "12px", fontWeight: 600 }}>
                {currentPage} / {totalPages}
              </span>
              <button
                className="secondary-button"
                type="button"
                disabled={locked || currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                style={{ padding: "3px 8px", fontSize: "12px", margin: 0 }}
              >
                下一頁
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* 3. 品項清單標題與全選/清空 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "10px" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: "15px" }}>制服調整品項選擇</h3>
          <span style={{ fontSize: "12px", color: "var(--muted, #666)" }}>
            點擊加入調整明細（每頁 {pageSize} 筆，目前篩選共 {filteredItems.length} 個品號；已選 {visible.lines.length} 項）
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            type="button"
            className="secondary-button"
            style={{ marginTop: 0, padding: "5px 12px", fontSize: "12px", fontWeight: 700 }}
            onClick={addAllFiltered}
            disabled={locked || !filteredItems.length || filteredItems.every((it) => visible.lines.some((l) => l.item_id === it.id))}
          >
            全選目前篩選品項（{filteredItems.length} 項）
          </button>
          {visible.lines.length > 0 ? (
            <button
              type="button"
              className="text-button"
              style={{ padding: "4px 8px", fontSize: "12px" }}
              onClick={clearAllLines}
              disabled={locked}
            >
              清空已選品項
            </button>
          ) : null}
        </div>
      </div>

      {/* 4. 品項卡片清單 */}
      {filteredItems.length === 0 ? (
        <p className="empty-state" style={{ padding: "16px 0", textAlign: "center", color: "var(--muted, #888)" }}>
          查無符合目前分類或條件的品號；請調整分類頁籤、篩選條件或點擊「重設篩選」。
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {pagedItems.map((item) => {
            const isAdded = visible.lines.some((line) => line.item_id === item.id);
            const known = balanceSnapshot?.scope === scope;
            const onHand = known ? (balances[item.id] ?? 0) : null;
            return (
              <div
                key={`adj-item-${item.id}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  border: isAdded ? "1.5px solid var(--green, #2e7d32)" : "1px solid #e2e8f0",
                  background: isAdded ? "var(--green-subtle, #f0fdf4)" : "#ffffff",
                  transition: "all 0.15s ease",
                }}
              >
                <div>
                  <div style={{ fontSize: "14px", fontWeight: 600, color: isAdded ? "var(--green, #166534)" : "#1e293b" }}>
                    {item.item_code} ｜ {item.item_name}（{item.size || "不分尺寸"}）
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--muted, #64748b)", marginTop: "2px" }}>
                    目前庫存：{onHand !== null ? onHand : "待載入"} {isAdded ? "（已排入下方調整明細）" : ""}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => toggleItemTag(item.id)}
                  style={{
                    padding: "6px 14px",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: 700,
                    cursor: locked ? "not-allowed" : "pointer",
                    border: isAdded ? "1px solid var(--line, #cbd5e1)" : "1px solid var(--accent, #2563eb)",
                    background: isAdded ? "#fff" : "var(--accent, #2563eb)",
                    color: isAdded ? "#475569" : "#fff",
                    transition: "all 0.15s ease",
                  }}
                >
                  {isAdded ? "✓ 已加入" : "+ 加入"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 5. 底部完整分頁列 */}
      {totalPages > 1 ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", paddingTop: "8px", borderTop: "1px solid var(--line, #e2e8f0)" }}>
          <span style={{ fontSize: "12px", color: "var(--muted, #666)" }}>
            顯示第 {(currentPage - 1) * pageSize + 1} 至 {Math.min(currentPage * pageSize, filteredItems.length)} 筆，共 {filteredItems.length} 筆
          </span>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <button
              className="secondary-button"
              type="button"
              disabled={locked || currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              style={{ padding: "4px 10px", fontSize: "12px", margin: 0 }}
            >
              上一頁
            </button>
            <span style={{ fontSize: "12px", fontWeight: 600 }}>
              第 {currentPage} / {totalPages} 頁
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={locked || currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              style={{ padding: "4px 10px", fontSize: "12px", margin: 0 }}
            >
              下一頁
            </button>
          </div>
        </div>
      ) : null}
    </div>
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
