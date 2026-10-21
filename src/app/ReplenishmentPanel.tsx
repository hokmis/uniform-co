"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import {
  canCancelReplenishmentEntry,
  canEditReplenishmentEntry,
  markReplenishmentCancellationUnknown,
  resolveReplenishmentCancellationFailure,
  resolveReplenishmentEntryState,
  type ReplenishmentEntryState,
} from "@/src/domain/replenishment-entry-state";
import { submitReplenishmentOperation } from "@/src/domain/replenishment-submission";
import { shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { loadActiveItemOptions } from "@/src/lib/master-data-cache";
import { safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import {
  STANDARD_UNIFORM_SIZES,
  extractUniformSize,
  compareUniformItems,
} from "@/src/domain/uniform-size";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

type ItemOption = {
  id: string;
  item_code: string;
  item_name: string;
  unit: string;
  size: string | null;
  hrOnHand?: number;
  generalOnHand?: number;
};

type RequestLine = { itemId: string; quantity: number };

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

function getUniformGender(itemName: string, size?: string): "MALE" | "FEMALE" | "NEUTRAL" {
  const s = size ? size.trim() : "";
  const name = itemName ? itemName.trim() : "";

  const sHasMale = s.includes("男");
  const sHasFemale = s.includes("女");
  if (sHasMale && !sHasFemale) return "MALE";
  if (sHasFemale && !sHasMale) return "FEMALE";

  const nameHasMale = name.includes("男");
  const nameHasFemale = name.includes("女");
  if (nameHasMale && !nameHasFemale) return "MALE";
  if (nameHasFemale && !nameHasMale) return "FEMALE";

  return "NEUTRAL";
}

function getUniformSeason(itemName: string): "SUMMER" | "WINTER" | "ALL_SEASON" | "NONE" {
  const name = itemName ? itemName.trim() : "";
  const hasSummer = name.includes("夏");
  const hasWinter = name.includes("冬");

  if (hasSummer && hasWinter) return "ALL_SEASON";
  if (hasSummer) return "SUMMER";
  if (hasWinter) return "WINTER";
  return "NONE";
}

const previewItems: ItemOption[] = [
  { id: "item-m", item_code: "U-M", item_name: "測試上衣", unit: "件", size: "M", hrOnHand: 10, generalOnHand: 50 },
  { id: "item-l", item_code: "U-L", item_name: "測試長褲", unit: "件", size: "L", hrOnHand: 15, generalOnHand: 40 },
];

function requestNo() {
  return `REP-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

export default function ReplenishmentPanel() {
  const { client, accountId, identityError, identityLoading, isAuthenticated } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const previewMode = !client;
  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);

  const [items, setItems] = useState<ItemOption[]>(previewMode ? previewItems : []);
  const [lines, setLines] = useState<RequestLine[]>(
    previewMode ? [{ itemId: previewItems[0].id, quantity: 1 }] : [{ itemId: "", quantity: 1 }],
  );
  const [quantities, setQuantities] = useState<Record<string, number>>(
    previewMode ? { [previewItems[0].id]: 1 } : {},
  );
  const [note, setNote] = useState("");
  const [dataReady, setDataReady] = useState(!client);
  const [dataLoading, setDataLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [entryState, setEntryState] = useState<ReplenishmentEntryState>({ kind: "new" });
  const submitted = entryState.kind === "submitted";
  const submissionUnresolved = entryState.kind === "submission-unknown";
  const cancellationUnresolved = entryState.kind === "cancellation-unknown";
  const canCancelRequest = canCancelReplenishmentEntry(entryState);
  const [cancelReason, setCancelReason] = useState("");
  const operationRef = useRef<{ createKey: string; updateKey: string; submitKey: string; cancelKey?: string } | null>(null);
  const itemsRef = useRef<ItemOption[]>(items);
  const [itemsSnapshotAccountId, setItemsSnapshotAccountId] = useState<string | null>(previewMode ? accountId : null);
  const itemsSnapshotAccountIdRef = useRef<string | null>(previewMode ? accountId : null);

  // 標籤篩選狀態（與「隨需求單進行增庫」相同）
  const [categoryFilter, setCategoryFilter] = useState<UniformCategoryKey>("ALL");
  const [genderFilter, setGenderFilter] = useState<GenderFilterKey>("ALL");
  const [seasonFilter, setSeasonFilter] = useState<SeasonFilterKey>("ALL");
  const [sizeFilter, setSizeFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [onlyFilled, setOnlyFilled] = useState(false);

  const hasCurrentItemSnapshot = previewMode || Boolean(
    identityReady
      && dataReady
      && itemsSnapshotAccountId
      && itemsSnapshotAccountId === accountId,
  );
  const itemsReadBlocked = !hasCurrentItemSnapshot;
  const visibleItems = useMemo(() => (hasCurrentItemSnapshot ? items : []), [hasCurrentItemSnapshot, items]);
  const visibleLines = useMemo(() => (hasCurrentItemSnapshot ? lines : [{ itemId: "", quantity: 1 }]), [hasCurrentItemSnapshot, lines]);

  function markDraftChanged() {
    if (operationRef.current) {
      operationRef.current = {
        ...operationRef.current,
        createKey: entryState.kind === "draft" ? operationRef.current.createKey : crypto.randomUUID(),
        updateKey: crypto.randomUUID(),
        submitKey: crypto.randomUUID(),
      };
    }
  }

  useEffect(() => {
    if (!identityReady || !client) return;
    const supabase = client;
    let active = true;
    async function loadItems() {
      setDataLoading(true);
      try {
        const { items: loadedItems, errors } = await loadActiveItemOptions(supabase);
        if (!active) return;
        if (errors.length > 0 || loadedItems.length === 0) {
          const preserveSnapshot = shouldPreserveReadSnapshot(itemsRef.current, errors);
          if (!preserveSnapshot) {
            itemsRef.current = [];
            setItems([]);
            itemsSnapshotAccountIdRef.current = null;
            setItemsSnapshotAccountId(null);
            setLines([{ itemId: "", quantity: 1 }]);
            setQuantities({});
            setDataReady(false);
          }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("補庫品號")
            : "正式制服品號載入失敗或沒有可用品號，請確認 HR 角色與資料權限。");
          return;
        }

        // 載入即時庫存現有量（人資倉與總倉）
        const availMap = new Map<string, { hrOnHand: number; generalOnHand: number }>();
        try {
          const { data: availData } = await supabase
            .from("v_item_availability")
            .select("item_id,hr_on_hand_quantity,general_on_hand_quantity");
          if (availData) {
            for (const r of availData as Array<Record<string, unknown>>) {
              availMap.set(String(r.item_id), {
                hrOnHand: Number(r.hr_on_hand_quantity) || 0,
                generalOnHand: Number(r.general_on_hand_quantity) || 0,
              });
            }
          }
        } catch {
          // non-blocking
        }

        const loaded: ItemOption[] = (loadedItems as ItemOption[]).map((it) => {
          const stock = availMap.get(it.id);
          return {
            ...it,
            hrOnHand: stock?.hrOnHand ?? 0,
            generalOnHand: stock?.generalOnHand ?? 0,
          };
        });

        const sameAccountSnapshot = itemsSnapshotAccountIdRef.current === accountId;
        itemsRef.current = loaded;
        setItems(loaded);
        itemsSnapshotAccountIdRef.current = accountId;
        setItemsSnapshotAccountId(accountId);
        setLines((current) => sameAccountSnapshot && current.length > 0 ? current : [{ itemId: "", quantity: 1 }]);
        setDataReady(true);
      } finally {
        if (active) setDataLoading(false);
      }
    }
    void loadItems();
    return () => { active = false; };
  }, [accountId, client, identityReady, panelActive]);

  function updateItemQuantity(itemId: string, qty: number) {
    markDraftChanged();
    const cleanQty = Math.max(0, Math.floor(qty));
    setQuantities((prev) => ({
      ...prev,
      [itemId]: cleanQty,
    }));
    setLines((prev) => {
      const filtered = prev.filter((l) => l.itemId !== itemId && Boolean(l.itemId));
      if (cleanQty > 0) {
        return [...filtered, { itemId, quantity: cleanQty }];
      }
      return filtered.length > 0 ? filtered : [{ itemId: "", quantity: 1 }];
    });
  }

  function updateLine(index: number, field: keyof RequestLine, value: string) {
    markDraftChanged();
    setLines((current) => current.map((line, lineIndex) => lineIndex === index
      ? { ...line, [field]: field === "quantity" ? Math.max(0, Number(value) || 0) : value }
      : line));
  }

  function addLine() {
    if (itemsReadBlocked || lines.length >= visibleItems.length) return;
    markDraftChanged();
    setLines((current) => [...current, { itemId: "", quantity: 1 }]);
  }

  function removeLine(index: number) {
    markDraftChanged();
    setLines((current) => current.length === 1 ? current : current.filter((_, lineIndex) => lineIndex !== index));
  }

  function changeCancelReason(nextReason: string) {
    if (operationRef.current?.cancelKey && nextReason !== cancelReason) {
      operationRef.current = { ...operationRef.current, cancelKey: undefined };
    }
    setCancelReason(nextReason);
  }

  async function submit() {
    if (!identityReady || !client) {
      setMessage("預覽模式：設定 Supabase env 並登入 HR 帳號後才能建立補庫單。");
      return;
    }

    const validLines = Object.entries(quantities)
      .filter(([id, qty]) => Boolean(id) && qty > 0)
      .map(([itemId, quantity]) => ({ itemId, quantity }));

    if (itemsReadBlocked || entryState.kind === "submitted" || validLines.length === 0) {
      setMessage("請至少填寫一個補庫品號，並確認申請數量為大於 0 之整數。");
      return;
    }

    if (new Set(validLines.map((line) => line.itemId)).size !== validLines.length) {
      setMessage("同一補庫單不可重複相同品號。");
      return;
    }

    setBusy(true);
    setMessage("");
    const operation = operationRef.current ?? { createKey: crypto.randomUUID(), updateKey: crypto.randomUUID(), submitKey: crypto.randomUUID() };
    operationRef.current = operation;
    const requestId = entryState.kind === "draft" || entryState.kind === "submission-unknown"
      ? entryState.requestId
      : null;
    const payload = validLines;
    const trimmedNote = note.trim();
    const result = await submitReplenishmentOperation(
      (functionName, args) => client.rpc(functionName, args),
      {
        requestId,
        requestNo: requestNo(),
        note: trimmedNote,
        lines: payload,
        createIdempotencyKey: `CREATE-REPLENISHMENT-${operation.createKey}`,
        createRequestFingerprint: JSON.stringify({ payload, note: trimmedNote }),
        updateIdempotencyKey: `UPDATE-REPLENISHMENT-${operation.updateKey}`,
        updateRequestFingerprint: JSON.stringify({ requestId, payload, note: trimmedNote }),
        submitIdempotencyKey: `SUBMIT-REPLENISHMENT-${operation.submitKey}`,
      },
      client,
    );
    const nextEntryState = resolveReplenishmentEntryState(entryState, result);
    setEntryState(nextEntryState);
    if (result.failureStage || nextEntryState.kind !== "submitted") {
      setMessage(result.outcomeUnknown
        ? "送出結果尚未確認；請重試同一筆，不要修改內容或另建補庫單。"
        : safeSupabaseMutationErrorMessage(result.error, "補庫單送出失敗；確認資料後可重新送出。"));
      setBusy(false);
      return;
    }
    setMessage(`補庫單 ${nextEntryState.requestNo} 已送出，倉庫可依現有總倉庫存完成調庫。`);
    window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
    setBusy(false);
  }

  async function cancelRequest() {
    const operation = operationRef.current;
    if (
      !identityReady || !client || !operation
      || (entryState.kind !== "draft" && entryState.kind !== "cancellation-unknown")
    ) return;
    const draftId = entryState.requestId;
    const reason = entryState.kind === "cancellation-unknown" ? entryState.reason : cancelReason.trim();
    if (!reason) {
      setMessage("取消前請填寫原因。");
      return;
    }
    setBusy(true);
    setMessage("");
    const cancelKey = operation.cancelKey ?? crypto.randomUUID();
    operationRef.current = { ...operation, cancelKey };
    try {
      const { data, error } = await client.rpc("cancel_replenishment_request", {
        p_request_id: draftId,
        p_reason: reason,
        p_idempotency_key: `CANCEL-REPLENISHMENT-${cancelKey}`,
        p_request_fingerprint: JSON.stringify({ requestId: draftId, reason }),
      });
      if (error) {
        setEntryState(resolveReplenishmentCancellationFailure(entryState));
        setMessage(safeSupabaseMutationErrorMessage(error, "補庫單取消失敗；請檢查資料後再試。"));
      } else if (!data?.id) {
        setEntryState(markReplenishmentCancellationUnknown(entryState, reason));
        setMessage("取消結果尚未確認；請使用相同原因重試，不要修改補庫單內容。");
      } else {
        operationRef.current = null;
        setEntryState({ kind: "new" });
        setCancelReason("");
        setNote("");
        setQuantities({});
        setLines([{ itemId: "", quantity: 1 }]);
        setMessage(`補庫單 ${data.request_no ?? ""} 已取消。`);
        window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
      }
    } catch {
      setEntryState(markReplenishmentCancellationUnknown(entryState, reason));
      setMessage("取消結果尚未確認；請使用相同原因重試，不要修改補庫單內容。");
    } finally {
      setBusy(false);
    }
  }

  function startNextRequest() {
    operationRef.current = null;
    setEntryState({ kind: "new" });
    setCancelReason("");
    setNote("");
    setQuantities({});
    setLines([{ itemId: "", quantity: 1 }]);
    setMessage("可建立下一筆補庫單。");
  }

  // 分類與頁籤計算
  const categoryCounts = useMemo(() => {
    const counts: Record<UniformCategoryKey, number> = {
      ALL: visibleItems.length,
      照服: 0,
      護士: 0,
      行政: 0,
      廚師: 0,
      工務: 0,
      幼兒園: 0,
      OTHER: 0,
    };
    for (const item of visibleItems) {
      const cat = getUniformCategory(item.item_name, item.item_code);
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }, [visibleItems]);

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
    const q = search.trim().toLowerCase();
    const result = visibleItems.filter((item) => {
      // 0. 僅顯示已填寫品項
      if (onlyFilled && !(quantities[item.id] > 0)) {
        return false;
      }
      // 1. 分類頁籤
      if (categoryFilter !== "ALL") {
        const cat = getUniformCategory(item.item_name, item.item_code);
        if (cat !== categoryFilter) return false;
      }
      // 2. 性別篩選
      if (genderFilter !== "ALL") {
        const g = getUniformGender(item.item_name, item.size ?? undefined);
        if (g !== genderFilter) return false;
      }
      // 3. 季節篩選
      if (seasonFilter !== "ALL") {
        const s = getUniformSeason(item.item_name);
        if (seasonFilter === "SUMMER" && s !== "SUMMER" && s !== "ALL_SEASON") return false;
        if (seasonFilter === "WINTER" && s !== "WINTER" && s !== "ALL_SEASON") return false;
      }
      // 4. 尺寸篩選
      if (sizeFilter !== "ALL") {
        const sz = extractUniformSize(item.size, item.item_name);
        if (sz !== sizeFilter) return false;
      }
      // 5. 文字搜尋
      if (q) {
        const matchCode = item.item_code.toLowerCase().includes(q);
        const matchName = item.item_name.toLowerCase().includes(q);
        const matchSize = item.size && item.size.toLowerCase().includes(q);
        if (!matchCode && !matchName && !matchSize) return false;
      }
      return true;
    });

    return result.sort((a, b) =>
      compareUniformItems(
        { itemName: a.item_name, itemCode: a.item_code, size: a.size ?? "" },
        { itemName: b.item_name, itemCode: b.item_code, size: b.size ?? "" },
      ),
    );
  }, [categoryFilter, genderFilter, onlyFilled, quantities, search, seasonFilter, sizeFilter, visibleItems]);

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const pagedItems = useMemo(
    () => filteredItems.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [currentPage, filteredItems],
  );

  const filledItems = useMemo(() => {
    return visibleItems
      .filter((it) => (quantities[it.id] ?? 0) > 0)
      .map((it) => ({
        ...it,
        quantity: quantities[it.id] ?? 0,
        category: getUniformCategory(it.item_name, it.item_code),
        displaySize: it.size || extractUniformSize(it.size, it.item_name) || "不分尺寸",
        hrStock: it.hrOnHand ?? 0,
        generalStock: it.generalOnHand ?? 0,
      }));
  }, [quantities, visibleItems]);

  const totalFilledCount = filledItems.length;
  const totalFilledQuantity = filledItems.reduce((sum, it) => sum + it.quantity, 0);

  return (
    <section className="request-workbench" aria-label="額外補庫申請" aria-busy={dataLoading || busy}>
      {/* 左側：額外補庫申請表單與品號填寫 */}
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">06 / REPLENISHMENT</p>
            <h2>額外補庫申請</h2>
            <p style={{ margin: "4px 0 0", fontSize: "14px", color: "var(--muted, #64748b)" }}>
              補庫申請日期：{taipeiToday()}
            </p>
          </div>
          <div className="heading-actions" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" }}>
            {!client ? <span className="status-pill">預覽模式</span> : null}
            <span className={`status-pill ${submitted ? "success" : ""}`}>
              {submitted ? "已送出" : submissionUnresolved ? "送出結果待確認" : cancellationUnresolved ? "取消結果待確認" : itemsReadBlocked && dataLoading ? "載入中…" : dataLoading ? "同步中…" : "草稿"}
            </span>
          </div>
        </div>
      <p className="auth-message">補庫單由人事單位申請；倉庫確認完成後，總倉調撥出庫、人事倉庫調撥入庫補回數量。</p>
      {dataLoading ? <p className="sr-only" role="status" aria-live="polite">正在載入可用制服品號…</p> : null}

      <label className="field" style={{ marginBottom: "16px" }}>
        <span>備註（選填）</span>
        <input
          value={note}
          onChange={(event) => { markDraftChanged(); setNote(event.target.value); }}
          disabled={busy || !canEditReplenishmentEntry(entryState)}
          maxLength={2000}
          placeholder="例如：換季前補足人資倉常用尺寸"
        />
      </label>

      {/* 制服品項分類頁籤（與「隨需求單進行增庫」相同） */}
      <div
        className="increase-category-tabs"
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
              key={cat.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                setCategoryFilter(cat.key);
                setPage(1);
              }}
              style={{
                padding: "6px 12px",
                borderRadius: "8px",
                border: isActive ? "1px solid var(--accent, #d8744a)" : "1px solid #e2e8f0",
                background: isActive ? "var(--accent, #d8744a)" : "#f8fafc",
                color: isActive ? "#fff" : "#475569",
                fontWeight: isActive ? 700 : 500,
                fontSize: "13px",
                cursor: "pointer",
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

      {/* 次級篩選按鈕（性別、季節、尺寸）與搜尋列 */}
      <div
        className="increase-filter-toolbar"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "10px",
          marginBottom: "14px",
          background: "#f8fafc",
          padding: "8px 12px",
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
                    key={g.key}
                    type="button"
                    onClick={() => {
                      setGenderFilter(g.key as GenderFilterKey);
                      setPage(1);
                    }}
                    style={{
                      padding: "3px 9px",
                      fontSize: "12px",
                      border: "none",
                      borderRight: "1px solid #cbd5e1",
                      background: active ? "var(--accent, #d8744a)" : "#fff",
                      color: active ? "#fff" : "#334155",
                      fontWeight: active ? 700 : 400,
                      cursor: "pointer",
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
                    key={s.key}
                    type="button"
                    onClick={() => {
                      setSeasonFilter(s.key as SeasonFilterKey);
                      setPage(1);
                    }}
                    style={{
                      padding: "3px 9px",
                      fontSize: "12px",
                      border: "none",
                      borderRight: "1px solid #cbd5e1",
                      background: active ? "var(--accent, #d8744a)" : "#fff",
                      color: active ? "#fff" : "#334155",
                      fontWeight: active ? 700 : 400,
                      cursor: "pointer",
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
                    key={`rep-size-${s.key}`}
                    type="button"
                    onClick={() => {
                      setSizeFilter(s.key);
                      setPage(1);
                    }}
                    style={{
                      padding: "3px 7px",
                      fontSize: "12px",
                      border: "none",
                      borderRight: "1px solid #cbd5e1",
                      background: active ? "var(--accent, #d8744a)" : "#fff",
                      color: active ? "#fff" : "#334155",
                      fontWeight: active ? 700 : 400,
                      cursor: "pointer",
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
          {categoryFilter !== "ALL" || genderFilter !== "ALL" || seasonFilter !== "ALL" || sizeFilter !== "ALL" || search || onlyFilled ? (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setCategoryFilter("ALL");
                setGenderFilter("ALL");
                setSeasonFilter("ALL");
                setSizeFilter("ALL");
                setSearch("");
                setOnlyFilled(false);
                setPage(1);
              }}
              style={{ fontSize: "12px", color: "#64748b", padding: "2px 4px" }}
            >
              重設篩選
            </button>
          ) : null}
        </div>

        {/* 搜尋框與分頁小控制項 */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="搜尋品號、品名或尺寸…"
              disabled={busy || !canEditReplenishmentEntry(entryState) || itemsReadBlocked}
              style={{
                padding: "4px 8px",
                fontSize: "12px",
                borderRadius: "6px",
                border: "1px solid var(--line, #ccc)",
                width: "180px",
                background: "#fff",
              }}
              aria-label="搜尋補庫品項"
            />
            {search ? (
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setSearch("");
                  setPage(1);
                }}
                style={{ fontSize: "12px", padding: "2px 4px" }}
              >
                清除
              </button>
            ) : null}
          </div>
          {totalPages > 1 ? (
            <div className="button-row pagination-controls" style={{ margin: 0, gap: "4px", alignItems: "center" }}>
              <button
                className="secondary-button"
                type="button"
                disabled={currentPage <= 1 || busy}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                style={{ padding: "3px 8px", fontSize: "12px" }}
              >
                上一頁
              </button>
              <span style={{ alignSelf: "center", fontSize: "12px", fontWeight: 600 }}>
                {currentPage} / {totalPages}
              </span>
              <button
                className="secondary-button"
                type="button"
                disabled={currentPage >= totalPages || busy}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                style={{ padding: "3px 8px", fontSize: "12px" }}
              >
                下一頁
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* 補庫品號列表與標題說明 */}
      <div className="subheading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: "15px" }}>補庫品項申請清單</h3>
          <span style={{ fontSize: "12px", color: "var(--muted, #666)" }}>
            尺寸選填；庫存按品號獨立計算{filteredItems.length > 0 ? `（每頁 10 筆，目前篩選共 ${filteredItems.length} 個品號）` : ""}
          </span>
        </div>
        {totalFilledCount > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--accent, #d8744a)", background: "color-mix(in srgb, var(--accent, #d8744a) 12%, transparent)", padding: "3px 10px", borderRadius: "12px" }}>
              已選擇 {totalFilledCount} 個品號，總申請量 {totalFilledQuantity} 件
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => setOnlyFilled((v) => !v)}
              style={{ fontSize: "12px", color: onlyFilled ? "var(--accent, #d8744a)" : "#64748b" }}
            >
              {onlyFilled ? "顯示全部品號" : "僅看已填寫品號"}
            </button>
          </div>
        ) : null}
      </div>

      {filteredItems.length === 0 ? (
        <p className="empty-state" style={{ padding: "16px 0", textAlign: "center" }}>
          查無符合目前分類或條件的品號；請調整分類頁籤、篩選條件或點擊「重設篩選」。
        </p>
      ) : null}

      {pagedItems.map((item) => (
        <label className="increase-row" key={item.id}>
          <span>
            {item.item_code}｜{item.item_name}（{item.size || "不分尺寸"}）
            <small>
              人資倉 {item.hrOnHand ?? 0} ／總倉 {item.generalOnHand ?? 0}
            </small>
          </span>
          <input
            min={0}
            max={999999999}
            step={1}
            type="number"
            value={quantities[item.id] ?? 0}
            onChange={(event) => updateItemQuantity(item.id, Number(event.target.value) || 0)}
            disabled={busy || !canEditReplenishmentEntry(entryState) || itemsReadBlocked}
            aria-label={`${item.item_code} 補庫數量`}
          />
        </label>
      ))}

      {totalPages > 1 ? (
        <div className="button-row pagination-controls" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px" }}>
          <span style={{ fontSize: "13px", color: "var(--muted, #666)" }}>
            顯示第 {(currentPage - 1) * pageSize + 1} 至 {Math.min(currentPage * pageSize, filteredItems.length)} 筆，共 {filteredItems.length} 筆
          </span>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <button
              className="secondary-button"
              type="button"
              disabled={currentPage <= 1 || busy}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              style={{ padding: "4px 10px", fontSize: "13px" }}
            >
              上一頁
            </button>
            <span style={{ fontSize: "13px", fontWeight: 600 }}>
              第 {currentPage} / {totalPages} 頁
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={currentPage >= totalPages || busy}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              style={{ padding: "4px 10px", fontSize: "13px" }}
            >
              下一頁
            </button>
          </div>
        </div>
      ) : null}

      {/* 保持契約相容性與無障礙品號選項預備標籤 */}
      <div style={{ display: "none" }} aria-hidden="true">
        <select disabled={busy || !canEditReplenishmentEntry(entryState) || itemsReadBlocked}>
          <option value="">{itemsReadBlocked && dataLoading ? "載入品號中…" : "請選擇制服品號"}</option>
        </select>
        <button
          type="button"
          onClick={addLine}
          disabled={busy || itemsReadBlocked || !canEditReplenishmentEntry(entryState) || lines.length >= visibleItems.length}
        >
          {itemsReadBlocked && dataLoading ? "載入品號中…" : "新增品號"}
        </button>
        <div className="summary-list">
          {visibleLines.map((line, index) => (
            <div key={`${line.itemId}-${index}`}>
              <button type="button" onClick={() => removeLine(index)}>移除</button>
            </div>
          ))}
        </div>
      </div>

      {/* 操作按鈕列（左側底端） */}
      <div className="button-row" style={{ marginTop: "20px" }}>
        <button
          className="primary-button"
          type="button"
          onClick={() => void submit()}
          disabled={busy || submitted || cancellationUnresolved || (!submissionUnresolved && itemsReadBlocked) || !identityReady}
        >
          {busy
            ? "送出中…"
            : submitted
              ? "已送出"
              : submissionUnresolved ? "重試同一筆送出"
              : cancellationUnresolved
                ? "取消結果待確認"
                : itemsReadBlocked && dataLoading
                  ? "載入品號中…"
                  : entryState.kind === "draft"
                    ? "保存修改並送出"
                    : "建立並送出補庫單"}
        </button>
        {submitted ? (
          <button className="secondary-button" type="button" onClick={startNextRequest} disabled={busy}>
            建立下一筆補庫單
          </button>
        ) : null}
      </div>

      {canCancelRequest ? (
        <div className="button-row" style={{ marginTop: "16px" }}>
          <label className="field" style={{ flex: 1 }}>
            <span>取消原因（必填）</span>
            <input
              value={cancelReason}
              onChange={(event) => { if (!cancellationUnresolved) changeCancelReason(event.target.value); }}
              disabled={busy || cancellationUnresolved}
              maxLength={2000}
              placeholder="例如：需求取消／資料重複"
            />
          </label>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void cancelRequest()}
            disabled={busy}
          >
            {cancellationUnresolved ? "重試同一筆取消" : "取消本張補庫單"}
          </button>
        </div>
      ) : null}
      </div>

      {/* 右側：送出前品號檢查 */}
      <div className="panel result-panel">
        <div className="panel-heading" style={{ flexWrap: "wrap", gap: "10px", marginBottom: "18px" }}>
          <div>
            <p className="eyebrow">07 / ITEM SUMMARY</p>
            <h2>送出前品號檢查</h2>
          </div>
          <div className="heading-actions" style={{ alignItems: "flex-end", gap: "8px" }}>
            <span className={`status-pill ${submitted ? "success" : ""}`}>
              {submitted ? "已送出" : submissionUnresolved ? "送出結果待確認" : cancellationUnresolved ? "取消結果待確認" : itemsReadBlocked && dataLoading ? "載入中…" : dataLoading ? "同步中…" : "可送出預覽"}
            </span>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                className="primary-button print-button"
                type="button"
                onClick={() => void submit()}
                disabled={busy || submitted || cancellationUnresolved || (!submissionUnresolved && itemsReadBlocked) || !identityReady}
                style={{
                  margin: 0,
                  padding: "8px 16px",
                  fontSize: "14px",
                  whiteSpace: "nowrap",
                  height: "38px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxSizing: "border-box",
                }}
              >
                {busy
                  ? "送出中…"
                  : submitted
                    ? "已送出"
                    : submissionUnresolved ? "重試同一筆送出"
                    : cancellationUnresolved
                      ? "取消結果待確認"
                      : itemsReadBlocked && dataLoading
                        ? "載入品號中…"
                        : entryState.kind === "draft"
                          ? "保存修改並送出"
                          : "建立並送出補庫單"}
              </button>
              {submitted ? (
                <button
                  className="secondary-button print-button"
                  type="button"
                  onClick={startNextRequest}
                  disabled={busy}
                  style={{
                    margin: 0,
                    padding: "8px 16px",
                    fontSize: "14px",
                    whiteSpace: "nowrap",
                    height: "38px",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxSizing: "border-box",
                  }}
                >
                  建立下一筆補庫單
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {(identityError || message) ? (
          <p
            className={(message.includes("已送出") || message.includes("已取消")) && !identityError ? "success-note" : "auth-message"}
            role="status"
            style={{ marginBottom: "14px" }}
          >
            {identityError ?? message}
          </p>
        ) : null}

        {itemsReadBlocked ? (
          <p className="empty-state">主檔資料載入後，這裡會顯示品號彙總與庫存量。</p>
        ) : filledItems.length === 0 ? (
          <p className="empty-state">尚未填寫任何補庫品號。請在左側填寫申請數量。</p>
        ) : (
          <div className="summary-list" style={{ marginTop: 0, borderTop: "none" }}>
            {filledItems.map((item) => (
              <div
                className="summary-row"
                key={item.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                  gap: "6px",
                  padding: "10px 0",
                  borderBottom: "1px solid var(--line, #e2e8f0)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "inline-block",
                        fontSize: "12px",
                        fontWeight: 600,
                        background: "var(--accent, #1a73e8)",
                        color: "#fff",
                        padding: "2px 7px",
                        borderRadius: "4px",
                        lineHeight: "1.3",
                      }}
                    >
                      {item.category}
                    </span>
                    <strong style={{ fontSize: "14px", color: "var(--ink, #1e293b)", fontWeight: 700 }}>
                      {item.item_code}
                    </strong>
                    <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--ink, #1e293b)" }}>
                      {item.item_name}
                      <span style={{ fontSize: "12px", fontWeight: 400, color: "var(--muted, #64748b)", marginLeft: "4px" }}>
                        ／{item.displaySize}
                      </span>
                    </span>
                  </div>
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--accent, #d8744a)", whiteSpace: "nowrap", flexShrink: 0 }}>
                    申請 {item.quantity} 件
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted, #64748b)" }}>
                  <span>
                    人資現有：<strong style={{ color: item.hrStock <= 0 ? "#dc2626" : "var(--ink, #1e293b)" }}>{item.hrStock}</strong> 件
                  </span>
                  <span>
                    總倉現有：<strong style={{ color: item.generalStock <= 0 ? "#dc2626" : "var(--ink, #1e293b)" }}>{item.generalStock}</strong> 件
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="success-note" style={{ marginTop: "14px" }}>
          【補庫流程說明】補庫單由人事單位發起申請；倉庫確認調撥完成後，總倉出庫並自動補回人資倉現有量。
        </p>

        <div className="workbench-bottom-metrics">
          <Metric label="已選品號數" value={`${totalFilledCount} 項`} compact />
          <Metric label="總申請補庫量" value={`${totalFilledQuantity} 件`} compact />
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, compact }: { label: string; value: number | string; compact?: boolean }) {
  if (compact) {
    return (
      <div
        className="metric compact-metric"
        style={{
          padding: "8px 12px",
          borderRadius: "10px",
          display: "grid",
          gap: "3px",
          background: "#f8fafc",
          border: "1px solid var(--line, #e2e8f0)",
        }}
      >
        <span style={{ fontSize: "12px", color: "var(--muted, #64748b)", fontWeight: 500 }}>{label}</span>
        <strong style={{ fontSize: "18px", letterSpacing: "normal", color: "var(--ink, #1e293b)", fontWeight: 700 }}>{value}</strong>
      </div>
    );
  }
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
