"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import { isReadPendingForSelection, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { useWorkspaceSession } from "./workspace-session";
import { workflowStatusLabel, workflowStatusTone } from "@/src/domain/workflow-status";
import { completeStocktakeOperation, type StocktakeRpcCall } from "@/src/domain/stocktake-completion";
import { loadActiveItemOptions, loadActiveWarehouseOptions } from "@/src/lib/master-data-cache";
import { attemptOptionalRpc } from "@/src/lib/optional-rpc";
import { isSupabaseSessionSyncError, retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { usePanelActivity } from "./RetainedPanelSet";
import WorkflowActionBar from "./WorkflowActionBar";

import { STANDARD_UNIFORM_SIZES } from "@/src/domain/uniform-size";

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

function extractUniformSize(size?: string | null, itemName?: string): string {
  if (size && size.trim()) return size.trim().toUpperCase();
  if (itemName) {
    const match = itemName.match(/-[男女]?([A-Za-z0-9]+)$/);
    if (match) return match[1].toUpperCase();
  }
  return "";
}

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

function generateStocktakeNo() {
  const randomSuffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 6).toUpperCase()
    : Math.random().toString(36).slice(2, 8).toUpperCase();
  return `COUNT-${taipeiToday().replaceAll("-", "")}-${randomSuffix}`;
}

function formatStocktakeErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;
  const msg = typeof error === "string" ? error : String((error as { message?: string })?.message || "");
  if (msg.includes("stocktakes_stocktake_no_key") || msg.includes("duplicate key")) {
    return "盤點單號已存在；系統已為您重新產生新單號，請再次點擊重試。";
  }
  if (msg.includes("A reason is required for a stocktake difference")) {
    return "建立草稿失敗：實盤數量與帳面有差異的品項，必須填寫差異原因。";
  }
  if (msg.includes("The account cannot create this warehouse stocktake") || msg.includes("HR or WAREHOUSE role is required")) {
    return "權限不足：目前登入帳號角色無法盤點此倉庫（HR 僅限人資倉，WAREHOUSE 僅限總倉）。";
  }
  if (msg.includes("Invalid stocktake line")) {
    return "盤點明細格式錯誤，請檢查品號與實盤數量。";
  }
  if (msg.includes("idempotency key conflicts with another request")) {
    return "操作衝突；請重新整理後重試。";
  }
  return safeSupabaseMutationErrorMessage(error as Parameters<typeof safeSupabaseMutationErrorMessage>[0], fallback);
}

function numberValue(value: string) {
  return Math.max(0, Number(value) || 0);
}

export default function StocktakePanel() {
  const { client, isAuthenticated, authUserId, accountId, roles, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [balances, setBalances] = useState<Record<string, Balance>>({});
  const [warehouseId, setWarehouseId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [itemTagFilter, setItemTagFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<UniformCategoryKey>("ALL");
  const [genderFilter, setGenderFilter] = useState<GenderFilterKey>("ALL");
  const [seasonFilter, setSeasonFilter] = useState<SeasonFilterKey>("ALL");
  const [sizeFilter, setSizeFilter] = useState<string>("ALL");
  const [page, setPage] = useState<number>(1);
  const [stocktakeNo, setStocktakeNo] = useState(generateStocktakeNo);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<StocktakeLine[]>([]);
  const [stocktake, setStocktake] = useState<Stocktake | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [completionOutcomeUnknown, setCompletionOutcomeUnknown] = useState(false);
  const [masterDataLoading, setMasterDataLoading] = useState(false);
  const [masterDataSnapshotReady, setMasterDataSnapshotReady] = useState(false);
  const [balanceLoadingWarehouseId, setBalanceLoadingWarehouseId] = useState<string | null>(null);
  const [balanceSnapshotWarehouseId, setBalanceSnapshotWarehouseId] = useState<string | null>(null);
  const [needsRecountConfirmation, setNeedsRecountConfirmation] = useState(false);
  const createKeyRef = useRef<string | null>(null);
  const updateKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const masterDataSnapshotReadyRef = useRef(false);
  const balanceSnapshotWarehouseIdRef = useRef<string | null>(null);

  const identityReady = Boolean(isAuthenticated && accountId && !identityLoading && !identityError);
  const accessSnapshotKey = `${authUserId ?? ""}:${accountId ?? ""}:${[...roles].sort().join(",")}`;
  const accessSnapshotKeyRef = useRef("");
  const [activeSnapshotKey, setActiveSnapshotKey] = useState("");
  const accessSnapshotReady = identityReady && activeSnapshotKey === accessSnapshotKey;
  const scopedWarehouses = accessSnapshotReady ? warehouses : [];
  const scopedItems = useMemo(() => accessSnapshotReady ? items : [], [accessSnapshotReady, items]);
  const displayStocktake = accessSnapshotReady ? stocktake : null;
  const itemById = useMemo(() => new Map(scopedItems.map((item) => [item.id, item])), [scopedItems]);
  const selectedWarehouse = scopedWarehouses.find((warehouse) => warehouse.id === warehouseId);
  const visibleLines = selectedWarehouse ? lines : [];
  const canEdit = !displayStocktake || displayStocktake.status === "DRAFT";

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {
      ALL: scopedItems.length,
      "照服": 0, "護士": 0, "行政": 0, "廚師": 0, "工務": 0, "幼兒園": 0, OTHER: 0,
    };
    for (const item of scopedItems) {
      const cat = getUniformCategory(item.item_name, item.item_code);
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }, [scopedItems]);

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

  const filteredTagItems = useMemo(() => {
    const q = itemTagFilter.trim().toLowerCase();
    return scopedItems.filter((item) => {
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
        const sz = extractUniformSize(item.size, item.item_name);
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
  }, [categoryFilter, genderFilter, itemTagFilter, scopedItems, seasonFilter, sizeFilter]);

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filteredTagItems.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const pagedItems = useMemo(
    () => filteredTagItems.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [currentPage, filteredTagItems, pageSize],
  );
  const balancesLoading = isReadPendingForSelection(
    warehouseId,
    balanceLoadingWarehouseId,
    panelActive && accessSnapshotReady && masterDataSnapshotReady && Boolean(selectedWarehouse) && !stocktake,
  );
  const dataLoading = masterDataLoading || balancesLoading;
  const mutationLocked = busy || completionOutcomeUnknown;
  const messageIsSuccess = message.startsWith("已建立盤點草稿")
    || message.startsWith("已重新擷取帳面")
    || message.startsWith("盤點帳面與版本已重新擷取")
    || message.startsWith("盤點已完成")
    || message.startsWith("本筆盤點已完成");
  const masterDataReadBlocked = !accessSnapshotReady || !masterDataSnapshotReady;
  const balanceReadBlocked = Boolean(warehouseId) && balanceSnapshotWarehouseId !== warehouseId;
  const sourceReadBlocked = !identityReady || masterDataReadBlocked || balanceReadBlocked;

  useEffect(() => {
    if (!panelActive || !client || !hasSession || identityLoading || identityError || !accountId) return;
    const supabase = client;
    let active = true;
    async function load() {
      if (accessSnapshotKeyRef.current !== accessSnapshotKey) {
        accessSnapshotKeyRef.current = accessSnapshotKey;
        setActiveSnapshotKey(accessSnapshotKey);
        masterDataSnapshotReadyRef.current = false;
        balanceSnapshotWarehouseIdRef.current = null;
        setMasterDataSnapshotReady(false);
        setBalanceSnapshotWarehouseId(null);
        setBalanceLoadingWarehouseId(null);
        setWarehouses([]);
        setItems([]);
        setBalances({});
        setWarehouseId("");
        setSelectedItemId("");
        setSelectedItemIds([]);
        setItemTagFilter("");
        setLines([]);
        setStocktake(null);
        setNeedsRecountConfirmation(false);
      }
      setMasterDataLoading(true);
      try {
        const [warehouseMasterData, itemMasterData] = await Promise.all([
          loadActiveWarehouseOptions(supabase),
          loadActiveItemOptions(supabase),
        ]);
        if (!active) return;
        const readErrors = [...warehouseMasterData.errors, ...itemMasterData.errors];
        if (readErrors.length > 0) {
          const preserveSnapshot = masterDataSnapshotReadyRef.current
            && readErrors.every((error) => isSupabaseSessionSyncError(error));
          if (!preserveSnapshot) {
            masterDataSnapshotReadyRef.current = false;
            setMasterDataSnapshotReady(false);
          }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("盤點主檔選項")
            : "盤點主檔載入失敗，請確認 HR／WAREHOUSE 角色與資料權限。");
          return;
        }
        const canCountHr = roles.includes("HR");
        const canCountGeneral = roles.includes("WAREHOUSE");
        const loadedWarehouses = (warehouseMasterData.warehouses as Warehouse[]).filter((warehouse) =>
          (warehouse.purpose === "HR" && canCountHr) ||
          (warehouse.purpose === "GENERAL" && canCountGeneral),
        );
        const loadedItems = itemMasterData.items as Item[];
        setWarehouses(loadedWarehouses);
        setItems(loadedItems);
        masterDataSnapshotReadyRef.current = true;
        setMasterDataSnapshotReady(true);
        setWarehouseId((current) => loadedWarehouses.some((warehouse) => warehouse.id === current) ? current : "");
        if (loadedWarehouses.length === 0) {
          setMessage("目前登入角色沒有可盤點的倉庫；HR 僅能盤點人資倉，WAREHOUSE 僅能盤點總倉。");
        }
      } finally {
        if (active) setMasterDataLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accessSnapshotKey, accountId, client, hasSession, identityError, identityLoading, panelActive, roles]);

  useEffect(() => {
    if (!panelActive || !client || !hasSession || identityLoading || identityError || !accountId || !warehouseId || !warehouses.some((warehouse) => warehouse.id === warehouseId) || stocktake) return;
    const supabase = client;
    let active = true;
    async function loadBalances() {
      setBalanceLoadingWarehouseId(warehouseId);
      try {
        const [result] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("inventory_balances").select("item_id,on_hand_quantity,version").eq("warehouse_id", warehouseId)] as const,
        );
        if (!active) return;
        if (result.error) {
          const preserveSnapshot = balanceSnapshotWarehouseIdRef.current === warehouseId
            && isSupabaseSessionSyncError(result.error);
          if (!preserveSnapshot) {
            balanceSnapshotWarehouseIdRef.current = null;
            setBalanceSnapshotWarehouseId(null);
          }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("帳面庫存")
            : `帳面庫存載入失敗：${safeSupabaseReadErrorMessage(result.error)}`);
          return;
        }
        const next: Record<string, Balance> = {};
        for (const row of (result.data ?? []) as Balance[]) next[row.item_id] = row;
        balanceSnapshotWarehouseIdRef.current = warehouseId;
        setBalances(next);
        setBalanceSnapshotWarehouseId(warehouseId);
      } finally {
        if (active) setBalanceLoadingWarehouseId((current) => current === warehouseId ? null : current);
      }
    }
    void loadBalances();
    return () => { active = false; };
  }, [accountId, client, hasSession, identityError, identityLoading, panelActive, warehouseId, warehouses, stocktake]);

  function resetOperationKeys() {
    if (completionOutcomeUnknown) return;
    clearOperationKeys();
  }

  function clearOperationKeys() {
    createKeyRef.current = null;
    updateKeyRef.current = null;
    postKeyRef.current = null;
  }

  function changeWarehouse(nextId: string) {
    if (stocktake || completionOutcomeUnknown || nextId === warehouseId) return;
    resetOperationKeys();
    setWarehouseId(nextId);
    balanceSnapshotWarehouseIdRef.current = null;
    setBalanceSnapshotWarehouseId(null);
    setBalances({});
    setLines([]);
    setSelectedItemId("");
    setSelectedItemIds([]);
    setItemTagFilter("");
  }

  function startNextStocktake() {
    resetOperationKeys();
    setStocktake(null);
    setLines([]);
    setSelectedItemId("");
    setSelectedItemIds([]);
    setItemTagFilter("");
    setStocktakeNo(generateStocktakeNo());
    setNote("");
    setNeedsRecountConfirmation(false);
    setMessage("本筆盤點已完成，可以建立下一張盤點單。");
  }

  function addLine(itemId?: string) {
    const idToAdd = typeof itemId === "string" && itemId ? itemId : selectedItemId;
    if (completionOutcomeUnknown || !selectedWarehouse || !idToAdd || visibleLines.some((line) => line.item_id === idToAdd)) return;
    const balance = balances[idToAdd] ?? { item_id: idToAdd, on_hand_quantity: 0, version: 0 };
    setLines((current) => [...current, {
      item_id: idToAdd,
      book_quantity_snapshot: balance.on_hand_quantity,
      balance_version_snapshot: balance.version,
      counted_quantity: balance.on_hand_quantity,
      reason: "",
    }]);
    if (idToAdd === selectedItemId) setSelectedItemId("");
    resetOperationKeys();
  }

  function appendStocktakeItems(idsToAdd: string[] = selectedItemIds) {
    if (completionOutcomeUnknown || !selectedWarehouse || idsToAdd.length === 0) return;
    const existingIds = new Set(lines.map((line) => line.item_id));
    const toAdd = idsToAdd.filter((id) => !existingIds.has(id));
    if (toAdd.length === 0) {
      setSelectedItemIds([]);
      return;
    }
    const newLines: StocktakeLine[] = toAdd.map((id) => {
      const balance = balances[id] ?? { item_id: id, on_hand_quantity: 0, version: 0 };
      return {
        item_id: id,
        book_quantity_snapshot: balance.on_hand_quantity,
        balance_version_snapshot: balance.version,
        counted_quantity: balance.on_hand_quantity,
        reason: "",
      };
    });
    setLines((current) => [...current, ...newLines]);
    setSelectedItemIds([]);
    resetOperationKeys();
  }

  function addAllItems() {
    if (completionOutcomeUnknown || !selectedWarehouse || scopedItems.length === 0) return;
    const existingIds = new Set(lines.map((line) => line.item_id));
    const unaddedItems = scopedItems.filter((item) => !existingIds.has(item.id));
    if (unaddedItems.length === 0) return;
    const newLines: StocktakeLine[] = unaddedItems.map((item) => {
      const balance = balances[item.id] ?? { item_id: item.id, on_hand_quantity: 0, version: 0 };
      return {
        item_id: item.id,
        book_quantity_snapshot: balance.on_hand_quantity,
        balance_version_snapshot: balance.version,
        counted_quantity: balance.on_hand_quantity,
        reason: "",
      };
    });
    setLines((current) => [...current, ...newLines]);
    setSelectedItemIds([]);
    resetOperationKeys();
  }

  function addAllFilteredItems() {
    if (completionOutcomeUnknown || !selectedWarehouse || filteredTagItems.length === 0) return;
    const existingIds = new Set(lines.map((line) => line.item_id));
    const unadded = filteredTagItems.filter((item) => !existingIds.has(item.id));
    if (unadded.length === 0) return;
    const newLines: StocktakeLine[] = unadded.map((item) => {
      const balance = balances[item.id] ?? { item_id: item.id, on_hand_quantity: 0, version: 0 };
      return {
        item_id: item.id,
        book_quantity_snapshot: balance.on_hand_quantity,
        balance_version_snapshot: balance.version,
        counted_quantity: balance.on_hand_quantity,
        reason: "",
      };
    });
    setLines((current) => [...current, ...newLines]);
    setSelectedItemIds([]);
    resetOperationKeys();
  }

  function removeAllItems() {
    if (stocktake || completionOutcomeUnknown) return;
    resetOperationKeys();
    setLines([]);
    setSelectedItemIds([]);
  }

  function toggleItemTag(itemId: string) {
    if (stocktake || completionOutcomeUnknown || !selectedWarehouse) return;
    const isAdded = visibleLines.some((line) => line.item_id === itemId);
    if (isAdded) {
      removeLine(itemId);
    } else {
      const balance = balances[itemId] ?? { item_id: itemId, on_hand_quantity: 0, version: 0 };
      setLines((current) => [...current, {
        item_id: itemId,
        book_quantity_snapshot: balance.on_hand_quantity,
        balance_version_snapshot: balance.version,
        counted_quantity: balance.on_hand_quantity,
        reason: "",
      }]);
      resetOperationKeys();
    }
  }

  function updateLine(itemId: string, field: "counted_quantity" | "reason", value: string) {
    if (completionOutcomeUnknown) return;
    resetOperationKeys();
    setLines((current) => current.map((line) => line.item_id === itemId ? {
      ...line,
      [field]: field === "counted_quantity" ? numberValue(value) : value,
    } : line));
  }

  function removeLine(itemId: string) {
    if (stocktake || completionOutcomeUnknown) return;
    resetOperationKeys();
    setLines((current) => current.filter((line) => line.item_id !== itemId));
  }

  async function loadDraftLines(stocktakeId: string) {
    if (!client) return;
    const [result] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("stocktake_lines")
        .select("id,item_id,book_quantity_snapshot,balance_version_snapshot,counted_quantity,reason")
        .eq("stocktake_id", stocktakeId).order("item_id")] as const,
    );
    if (result.error) throw result.error;
    setLines((result.data ?? []) as StocktakeLine[]);
  }

  function fingerprint() {
    return JSON.stringify({ warehouseId, stocktakeNo: stocktake?.stocktake_no ?? stocktakeNo.trim(), note: note.trim(), lines });
  }

  async function createDraft(): Promise<Stocktake | null> {
    if (!client || !selectedWarehouse || !warehouseId || !stocktakeNo.trim() || visibleLines.length === 0) {
      setMessage("請選擇倉庫、填寫盤點單號並至少加入一個品號。"); return null;
    }
    const hasMissingReason = visibleLines.some((line) => line.counted_quantity - line.book_quantity_snapshot !== 0 && !line.reason.trim());
    if (hasMissingReason) {
      setMessage("實盤數量與帳面有差異的品項，請填寫差異原因後再建立草稿。");
      return null;
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
      const errorMsg = formatStocktakeErrorMessage(error, "盤點草稿結果尚未確認；請使用相同操作重試，系統會查回既有結果。");
      setMessage(errorMsg);
      if (error && String((error as { message?: string })?.message || "").includes("duplicate key")) {
        setStocktakeNo(generateStocktakeNo());
        createKeyRef.current = null;
      }
      setBusy(false);
      return null;
    }
    const created = data as Stocktake;
    setStocktake(created);
    createKeyRef.current = null;
    try {
      await loadDraftLines(created.id);
      setMessage(`已建立盤點草稿 ${created.stocktake_no}；請完成實盤後保存或送出。`);
    } catch (loadError) {
      setMessage("盤點草稿已建立，但明細載入失敗；請重新整理後確認目前草稿。");
    }
    setBusy(false);
    return created;
  }

  async function updateDraft(linesToSave = lines): Promise<Stocktake | null> {
    if (!client || !stocktake || !canEdit || linesToSave.length === 0) return null;
    const hasMissingReason = linesToSave.some((line) => line.counted_quantity - line.book_quantity_snapshot !== 0 && !line.reason.trim());
    if (hasMissingReason) {
      setMessage("實盤數量與帳面有差異的品項，請填寫差異原因後再保存草稿。");
      return null;
    }
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
      setMessage(formatStocktakeErrorMessage(error, "盤點草稿更新結果尚未確認；請使用相同操作重試，系統會查回既有結果。"));
      setBusy(false);
      return null;
    }
    updateKeyRef.current = null;
    setStocktake(data as Stocktake);
    setNeedsRecountConfirmation(false);
    try {
      await loadDraftLines(stocktake.id);
      setMessage("盤點帳面與版本已重新擷取；請確認實盤數量後再送出。");
    } catch (loadError) {
      setMessage("盤點草稿已更新，但明細載入失敗；請重新整理後確認目前草稿。");
    }
    setBusy(false);
    return data as Stocktake;
  }

  async function recaptureBook() {
    if (!client || !stocktake || lines.length === 0) return;
    setBusy(true); setMessage("");
    const key = updateKeyRef.current ?? crypto.randomUUID();
    updateKeyRef.current = key;
    const requestFingerprint = JSON.stringify({ stocktakeId: stocktake.id, note: note.trim(), recount: true });

    // Prefer the transactional server path; use the legacy sequence only after
    // the shared client-scoped capability probe explicitly confirms it is absent.
    let recaptureAttempt;
    try {
      recaptureAttempt = await attemptOptionalRpc(
        client,
        (functionName, args) => client.rpc(functionName, args),
        "recapture_stocktake_draft",
        {
        p_stocktake_id: stocktake.id,
        p_note: note.trim(),
        p_idempotency_key: `RECOUNT-STOCKTAKE-${key}`,
        p_request_fingerprint: requestFingerprint,
        },
      );
    } catch {
      setMessage("重新擷取帳面結果尚未確認；請使用相同操作重試。");
      setBusy(false);
      return;
    }
    if (recaptureAttempt.status === "called") {
      const serverPayload = recaptureAttempt.data as { stocktake?: Stocktake; lines?: StocktakeLine[] } | null;
      if (recaptureAttempt.error || !serverPayload?.stocktake?.id) {
        setMessage(safeSupabaseMutationErrorMessage(recaptureAttempt.error, "重新擷取帳面結果尚未確認；請使用相同操作重試。"));
        setBusy(false);
        return;
      }
      updateKeyRef.current = null;
      setStocktake(serverPayload.stocktake);
      setLines(serverPayload.lines ?? []);
      setNeedsRecountConfirmation(true);
      setMessage("已重新擷取帳面並將實盤量重設為最新帳面；請重新確認實盤後保存，再送出。");
      setBusy(false);
      return;
    }

    const [result] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("inventory_balances").select("item_id,on_hand_quantity,version").eq("warehouse_id", stocktake.warehouse_id)] as const,
    );
    if (result.error) { setMessage(`重新擷取帳面失敗：${safeSupabaseReadErrorMessage(result.error)}`); setBusy(false); return; }
    const fresh = new Map((result.data ?? []).map((row) => [row.item_id, row as Balance]));
    const resetLines = lines.map((line) => {
      const balance = fresh.get(line.item_id) ?? { item_id: line.item_id, on_hand_quantity: 0, version: 0 };
      return { ...line, book_quantity_snapshot: balance.on_hand_quantity, balance_version_snapshot: balance.version, counted_quantity: balance.on_hand_quantity, reason: "" };
    });
    setLines(resetLines);
    const { data, error } = await client.rpc("update_stocktake_draft", {
      p_stocktake_id: stocktake.id, p_note: `RECOUNT_CONFIRMED:${note.trim()}`, p_recount: true,
      p_lines: resetLines.map((line) => ({ itemId: line.item_id, countedQuantity: line.counted_quantity, reason: "" })),
      p_idempotency_key: `RECOUNT-STOCKTAKE-${key}`,
      p_request_fingerprint: requestFingerprint,
    });
    if (error || !data?.id) { setMessage(safeSupabaseMutationErrorMessage(error, "重新擷取帳面結果尚未確認；請使用相同操作重試。")); setBusy(false); return; }
    updateKeyRef.current = null;
    setStocktake(data as Stocktake);
    setNeedsRecountConfirmation(true);
    setMessage("已重新擷取帳面並將實盤量重設為最新帳面；請重新確認實盤後保存，再送出。");
    setBusy(false);
  }

  async function completeStocktake() {
    if (!client || lines.length === 0 || (stocktake && stocktake.status !== "DRAFT")) return;
    if (!stocktake && (!selectedWarehouse || !stocktakeNo.trim())) {
      setMessage("請選擇倉庫並填寫盤點單號。");
      return;
    }

    setBusy(true);
    setMessage("");
    const createKey = createKeyRef.current ?? crypto.randomUUID();
    const updateKey = updateKeyRef.current ?? crypto.randomUUID();
    const postKey = postKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = createKey;
    updateKeyRef.current = updateKey;
    postKeyRef.current = postKey;

    const completionLines = lines.map((line) => ({
      itemId: line.item_id,
      countedQuantity: line.counted_quantity,
      reason: line.reason.trim(),
    }));
    const completionFingerprint = JSON.stringify({
      stocktakeNo: stocktake?.stocktake_no ?? stocktakeNo.trim(),
      warehouseId: stocktake?.warehouse_id ?? warehouseId,
      note: note.trim(),
      lines: completionLines,
    });
    const stocktakeId = stocktake?.id ?? null;
    const rpc = (client as unknown as { rpc: StocktakeRpcCall }).rpc.bind(client);
    const result = await completeStocktakeOperation(rpc, {
      stocktake: stocktake as Stocktake | null,
      stocktakeNo: stocktake?.stocktake_no ?? stocktakeNo.trim(),
      warehouseId: stocktake?.warehouse_id ?? warehouseId,
      note: note.trim(),
      lines,
      createIdempotencyKey: `CREATE-STOCKTAKE-${createKey}`,
      createRequestFingerprint: completionFingerprint,
      updateIdempotencyKey: `UPDATE-STOCKTAKE-${updateKey}`,
      updateRequestFingerprint: JSON.stringify({ stocktakeId, note: note.trim(), lines: completionLines, recount: false }),
      postIdempotencyKey: `POST-STOCKTAKE-${postKey}`,
      postRequestFingerprint: completionFingerprint,
    }, client);

    let savedDraftReadFailed = false;
    if (result.stocktake) {
      setStocktake(result.stocktake);
      if (result.failureStage === "post" && result.stocktake.status === "DRAFT") {
        try {
          await loadDraftLines(result.stocktake.id);
        } catch {
          savedDraftReadFailed = true;
        }
      }
    }

    if (result.failureStage) {
      const outcomeUnknown = result.error === null;
      setCompletionOutcomeUnknown(outcomeUnknown);
      if (result.stocktake && result.failureStage === "post" && result.stocktake.status === "DRAFT") {
        const failureMessage = result.error
          ? formatStocktakeErrorMessage(result.error, "盤點已保存但尚未過帳；請使用相同操作重試。")
          : "盤點完成結果尚未確認；資料已鎖定，請沿用相同資料重試，不要重新建立盤點單。";
        setMessage(savedDraftReadFailed ? `${failureMessage} 草稿明細讀回失敗，請重新查詢。` : failureMessage);
      } else {
        setMessage(outcomeUnknown
          ? "盤點完成結果尚未確認；資料已鎖定，請沿用相同資料重試，不要重新建立盤點單。"
          : formatStocktakeErrorMessage(result.error, "盤點無法完成；請檢查資料後重試。"));
      }
      setBusy(false);
      return;
    }

    const completed = result.stocktake;
    setCompletionOutcomeUnknown(false);
    clearOperationKeys();
    if (completed?.status === "STALE_COUNT") {
      setNeedsRecountConfirmation(false);
      setMessage("盤點資料已過期；請重新擷取帳面並重新實盤，不能沿用舊數量。");
    } else if (completed?.status === "POSTED") {
      setNeedsRecountConfirmation(false);
      notifyInventoryDataChanged();
      window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
      setMessage("盤點已完成；差額已寫入庫存紀錄，帳面餘額已同步更新。");
    } else {
      setCompletionOutcomeUnknown(true);
      setMessage("盤點完成結果尚未確認；資料已鎖定，請沿用相同資料重試。");
    }
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="庫存盤點"><div className="panel-heading"><div><p className="eyebrow">08 / STOCKTAKE</p><h2>庫存盤點</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 HR／WAREHOUSE 帳號後，選擇倉庫、擷取帳面版本、填寫實盤量，再由系統確認資料版本後送出。</p></section>;
  if (!identityReady) return <section className="panel import-panel" aria-label="庫存盤點" aria-busy="true"><div className="panel-heading"><div><p className="eyebrow">08 / STOCKTAKE</p><h2>庫存盤點</h2></div><span className="status-pill">確認登入狀態</span></div><p className="auth-message" role="status" aria-live="polite">{identityLoading ? "正在確認目前登入帳號與角色…" : "目前登入身份無法載入盤點資料，請重新登入後再試。"}</p></section>;

  return <section className="panel import-panel" aria-label="庫存盤點" aria-busy={dataLoading}>
    <div className="panel-heading"><div><p className="eyebrow">08 / STOCKTAKE</p><h2>庫存盤點</h2></div><span className={`status-pill ${workflowStatusTone(displayStocktake?.status)}`}>{workflowStatusLabel(displayStocktake?.status, "建立盤點")}</span></div>
    <p className="auth-message">盤點單會保存帳面數量與版本；送出前系統會重新鎖定品號、餘額與預留。資料版本過期時需要重新擷取帳面，避免套用舊實盤。</p>
    {dataLoading ? <p className="auth-message" role="status" aria-live="polite">{sourceReadBlocked ? "正在載入可盤點倉庫、品號或帳面數量；盤點單號與備註仍可先填寫。" : "正在背景更新盤點資料；已載入的內容仍可繼續編輯。"}</p> : null}
    <div className="form-grid">
      <label className="field"><span>盤點倉庫</span><select value={warehouseId} onChange={(event) => changeWarehouse(event.target.value)} disabled={mutationLocked || sourceReadBlocked || Boolean(displayStocktake)}><option value="">{masterDataReadBlocked && masterDataLoading ? "載入倉庫中…" : masterDataReadBlocked ? "暫不可用" : "請選擇"}</option>{scopedWarehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code}｜{warehouse.name}（{warehouse.purpose === "HR" ? "人資倉" : "總倉"}）</option>)}</select></label>
      <label className="field"><span>盤點單號</span><input value={stocktakeNo} onChange={(event) => { resetOperationKeys(); setStocktakeNo(event.target.value); }} disabled={mutationLocked || Boolean(stocktake)} maxLength={80} /></label>
    </div>
    {selectedWarehouse && !displayStocktake ? (
      <div className="stocktake-tag-section" style={{ margin: "16px 0", padding: "16px", background: "var(--card-subtle, #f8fbf8)", border: "1px solid var(--line, #e0e6df)", borderRadius: "14px" }}>
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
                key={`st-cat-${cat.key}`}
                type="button"
                role="tab"
                aria-selected={isActive}
                disabled={mutationLocked || sourceReadBlocked}
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
                  cursor: mutationLocked || sourceReadBlocked ? "not-allowed" : "pointer",
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
                      key={`st-gender-${g.key}`}
                      type="button"
                      disabled={mutationLocked || sourceReadBlocked}
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
                        cursor: mutationLocked || sourceReadBlocked ? "not-allowed" : "pointer",
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
                      key={`st-season-${s.key}`}
                      type="button"
                      disabled={mutationLocked || sourceReadBlocked}
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
                        cursor: mutationLocked || sourceReadBlocked ? "not-allowed" : "pointer",
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
                      key={`st-size-${s.key}`}
                      type="button"
                      disabled={mutationLocked || sourceReadBlocked}
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
                        cursor: mutationLocked || sourceReadBlocked ? "not-allowed" : "pointer",
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
            {categoryFilter !== "ALL" || genderFilter !== "ALL" || seasonFilter !== "ALL" || sizeFilter !== "ALL" || itemTagFilter ? (
              <button
                type="button"
                className="text-button"
                disabled={mutationLocked || sourceReadBlocked}
                onClick={() => {
                  setCategoryFilter("ALL");
                  setGenderFilter("ALL");
                  setSeasonFilter("ALL");
                  setSizeFilter("ALL");
                  setItemTagFilter("");
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
              value={itemTagFilter}
              disabled={mutationLocked || sourceReadBlocked}
              onChange={(e) => {
                setItemTagFilter(e.target.value);
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
                  disabled={mutationLocked || sourceReadBlocked || currentPage <= 1}
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
                  disabled={mutationLocked || sourceReadBlocked || currentPage >= totalPages}
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
            <h3 style={{ margin: 0, fontSize: "15px" }}>【{selectedWarehouse.name}】制服品項選擇</h3>
            <span style={{ fontSize: "12px", color: "var(--muted, #666)" }}>
              點擊加入盤點清單（每頁 {pageSize} 筆，目前篩選共 {filteredTagItems.length} 個品號；已加入 {visibleLines.length} 項）
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              className="secondary-button"
              style={{ marginTop: 0, padding: "5px 12px", fontSize: "12px", fontWeight: 700 }}
              onClick={addAllFilteredItems}
              disabled={mutationLocked || sourceReadBlocked || filteredTagItems.length === 0 || filteredTagItems.every((it) => visibleLines.some((l) => l.item_id === it.id))}
            >
              全選目前篩選品項（{filteredTagItems.length} 項）
            </button>
            <button
              type="button"
              className="secondary-button"
              style={{ marginTop: 0, padding: "5px 12px", fontSize: "12px", fontWeight: 700 }}
              onClick={addAllItems}
              disabled={mutationLocked || sourceReadBlocked || scopedItems.length === 0 || visibleLines.length === scopedItems.length}
            >
              全選全部品項（{scopedItems.length} 項）
            </button>
            {visibleLines.length > 0 ? (
              <button
                type="button"
                className="text-button"
                style={{ padding: "4px 8px", fontSize: "12px" }}
                onClick={removeAllItems}
                disabled={mutationLocked}
              >
                清空已選品項
              </button>
            ) : null}
          </div>
        </div>

        {/* 4. 品項卡片清單 */}
        {filteredTagItems.length === 0 ? (
          <p className="empty-state" style={{ padding: "16px 0", textAlign: "center", color: "var(--muted, #888)" }}>
            查無符合目前分類或條件的品號；請調整分類頁籤、篩選條件或點擊「重設篩選」。
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {pagedItems.map((item) => {
              const line = visibleLines.find((l) => l.item_id === item.id);
              const isAdded = Boolean(line);
              const bookQty = balances[item.id]?.on_hand_quantity ?? 0;
              return (
                <div
                  key={`st-item-${item.id}`}
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
                      帳面庫存：{bookQty} {isAdded ? `（實盤：${line?.counted_quantity ?? bookQty}，差額：${(line?.counted_quantity ?? bookQty) - bookQty}）` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={mutationLocked || sourceReadBlocked}
                    onClick={() => toggleItemTag(item.id)}
                    style={{
                      padding: "6px 14px",
                      borderRadius: "6px",
                      fontSize: "13px",
                      fontWeight: 700,
                      cursor: mutationLocked || sourceReadBlocked ? "not-allowed" : "pointer",
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
              顯示第 {(currentPage - 1) * pageSize + 1} 至 {Math.min(currentPage * pageSize, filteredTagItems.length)} 筆，共 {filteredTagItems.length} 筆
            </span>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <button
                className="secondary-button"
                type="button"
                disabled={mutationLocked || sourceReadBlocked || currentPage <= 1}
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
                disabled={mutationLocked || sourceReadBlocked || currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                style={{ padding: "4px 10px", fontSize: "12px", margin: 0 }}
              >
                下一頁
              </button>
            </div>
          </div>
        ) : null}
      </div>
    ) : null}
    <label className="field reason-field"><span>盤點備註（選填）</span><input value={note} onChange={(event) => { resetOperationKeys(); setNote(event.target.value); }} disabled={mutationLocked || displayStocktake?.status === "POSTED"} maxLength={2000} /></label>
    {visibleLines.length > 0 ? <div className="summary-list">{visibleLines.map((line) => { const item = itemById.get(line.item_id); const difference = line.counted_quantity - line.book_quantity_snapshot; const hasDiff = difference !== 0; return <div className="summary-row" key={line.item_id}><span><strong>{item?.item_code ?? line.item_id}｜{item?.item_name ?? "品號"}</strong><small>帳面 {line.book_quantity_snapshot}／版本 {line.balance_version_snapshot}／差額 {difference}</small></span><label className="field"><span className="sr-only">實盤量</span><input type="number" min={0} value={line.counted_quantity} disabled={mutationLocked || !canEdit} onChange={(event) => updateLine(line.item_id, "counted_quantity", event.target.value)} /></label><label className="field"><span className="sr-only">差異原因</span><input value={hasDiff ? line.reason : ""} disabled={mutationLocked || !canEdit || !hasDiff} onChange={(event) => updateLine(line.item_id, "reason", event.target.value)} placeholder={hasDiff ? "差異原因（必填）" : "無差異"} maxLength={500} /></label>{!displayStocktake ? <button className="text-button" type="button" onClick={() => removeLine(line.item_id)} disabled={mutationLocked}>移除</button> : null}</div>; })}</div> : <p className="auth-message">請先加入要盤點的品號。</p>}
    <WorkflowActionBar
      primary={{
        onClick: () => void completeStocktake(),
        busy,
        busyLabel: "處理中…",
        disabled: busy || (!completionOutcomeUnknown && !displayStocktake && sourceReadBlocked) || visibleLines.length === 0 || needsRecountConfirmation || visibleLines.some((line) => line.counted_quantity - line.book_quantity_snapshot !== 0 && !line.reason.trim()) || displayStocktake?.status === "POSTED" || displayStocktake?.status === "STALE_COUNT",
        label: completionOutcomeUnknown ? "沿用相同資料重試" : displayStocktake?.status === "POSTED" ? "已完成" : needsRecountConfirmation ? "請先保存重新實盤" : "確認並完成盤點",
      }}
      secondary={!displayStocktake
        ? <button className="secondary-button" type="button" onClick={() => void createDraft()} disabled={mutationLocked || sourceReadBlocked || visibleLines.length === 0 || visibleLines.some((line) => line.counted_quantity - line.book_quantity_snapshot !== 0 && !line.reason.trim())}>{busy ? "建立中…" : sourceReadBlocked ? "載入資料中…" : "先建立盤點草稿"}</button>
        : displayStocktake.status === "DRAFT"
          ? <button className="secondary-button" type="button" onClick={() => void updateDraft()} disabled={mutationLocked || visibleLines.length === 0 || visibleLines.some((line) => line.counted_quantity - line.book_quantity_snapshot !== 0 && !line.reason.trim())}>{busy ? "保存中…" : "保存盤點草稿"}</button>
          : displayStocktake.status === "STALE_COUNT"
            ? <button className="secondary-button" type="button" onClick={() => void recaptureBook()} disabled={mutationLocked}>{busy ? "擷取中…" : "重新擷取帳面並開始重盤"}</button>
            : <button className="secondary-button" type="button" onClick={startNextStocktake} disabled={mutationLocked}>建立下一張盤點</button>}
    />
    {displayStocktake?.status === "POSTED" ? <p className="success-note">盤點單 {displayStocktake.stocktake_no} 已完成，原盤點與紀錄均已鎖定。</p> : null}
    {message ? <p className={messageIsSuccess ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
