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
import SearchableItemPicker from "./SearchableItemPicker";

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
  const [stocktakeNo, setStocktakeNo] = useState(`COUNT-${taipeiToday().replaceAll("-", "")}`);
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
  const canEdit = displayStocktake?.status === "DRAFT";
  const filteredTagItems = useMemo(() => {
    const q = itemTagFilter.trim().toLowerCase();
    if (!q) return scopedItems;
    return scopedItems.filter((item) =>
      item.item_code.toLowerCase().includes(q) ||
      item.item_name.toLowerCase().includes(q) ||
      (item.size && item.size.toLowerCase().includes(q))
    );
  }, [itemTagFilter, scopedItems]);
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
    setStocktakeNo(`COUNT-${taipeiToday().replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`);
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
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = key;
    const { data, error } = await client.rpc("create_stocktake_draft", {
      p_stocktake_no: stocktakeNo.trim(), p_warehouse_id: warehouseId, p_note: note.trim() || null,
      p_lines: lines.map((line) => ({ itemId: line.item_id, countedQuantity: line.counted_quantity, reason: line.reason.trim() })),
      p_idempotency_key: `CREATE-STOCKTAKE-${key}`, p_request_fingerprint: fingerprint(),
    });
    if (error || !data?.id) {
      setMessage(safeSupabaseMutationErrorMessage(error, "盤點草稿結果尚未確認；請使用相同操作重試，系統會查回既有結果。"));
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
      setMessage(safeSupabaseMutationErrorMessage(error, "盤點草稿更新結果尚未確認；請使用相同操作重試，系統會查回既有結果。"));
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
          ? safeSupabaseMutationErrorMessage(result.error, "盤點已保存但尚未過帳；請使用相同操作重試。")
          : "盤點完成結果尚未確認；資料已鎖定，請沿用相同資料重試，不要重新建立盤點單。";
        setMessage(savedDraftReadFailed ? `${failureMessage} 草稿明細讀回失敗，請重新查詢。` : failureMessage);
      } else {
        setMessage(outcomeUnknown
          ? "盤點完成結果尚未確認；資料已鎖定，請沿用相同資料重試，不要重新建立盤點單。"
          : safeSupabaseMutationErrorMessage(result.error, "盤點無法完成；請檢查資料後重試。"));
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
      <div className="field"><span>批次加入品號（可搜尋複選）</span><SearchableItemPicker label="盤點品號" placeholder="搜尋品號、品名或尺寸" options={scopedItems.filter((item) => !visibleLines.some((line) => line.item_id === item.id)).map((item) => ({ id: item.id, code: item.item_code, name: item.item_name, size: item.size, detail: `帳面 ${balances[item.id]?.on_hand_quantity ?? 0}` }))} value={selectedItemIds} multiple onChange={(value) => setSelectedItemIds(Array.isArray(value) ? value : [value])} disabled={mutationLocked || sourceReadBlocked || Boolean(displayStocktake) || !selectedWarehouse} /></div>
      <div className="field"><span>&nbsp;</span><button className="secondary-button" type="button" onClick={() => appendStocktakeItems()} disabled={mutationLocked || sourceReadBlocked || Boolean(displayStocktake) || selectedItemIds.length === 0 || !selectedWarehouse}>{sourceReadBlocked ? "載入帳面中…" : `加入 ${selectedItemIds.length} 個品號`}</button></div>
    </div>
    {selectedWarehouse && !displayStocktake ? (
      <div className="stocktake-tag-section" style={{ margin: "16px 0", padding: "16px", background: "var(--card-subtle, #f8fbf8)", border: "1px solid var(--line, #e0e6df)", borderRadius: "14px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "12px" }}>
          <div>
            <strong>標籤化品號選擇</strong>
            <span style={{ fontSize: "13px", color: "var(--muted, #667)", marginLeft: "8px" }}>
              （已加入 {visibleLines.length} / 全部 {scopedItems.length} 項）
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
            <input
              type="search"
              placeholder="搜尋品號標籤…"
              value={itemTagFilter}
              onChange={(e) => setItemTagFilter(e.target.value)}
              disabled={mutationLocked || sourceReadBlocked}
              style={{ padding: "6px 10px", fontSize: "13px", borderRadius: "8px", border: "1px solid var(--line, #ccc)" }}
            />
            <button
              type="button"
              className="secondary-button"
              style={{ marginTop: 0, padding: "6px 14px", fontSize: "13px", fontWeight: 700 }}
              onClick={addAllItems}
              disabled={mutationLocked || sourceReadBlocked || scopedItems.length === 0 || visibleLines.length === scopedItems.length}
            >
              全選目前全部品項（{scopedItems.length} 項）
            </button>
            {visibleLines.length > 0 ? (
              <button
                type="button"
                className="text-button"
                style={{ padding: "6px 8px", fontSize: "13px" }}
                onClick={removeAllItems}
                disabled={mutationLocked}
              >
                清空所有品項
              </button>
            ) : null}
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", maxHeight: "220px", overflowY: "auto", padding: "4px 2px" }}>
          {filteredTagItems.map((item) => {
            const isAdded = visibleLines.some((line) => line.item_id === item.id);
            const bookQty = balances[item.id]?.on_hand_quantity ?? 0;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => toggleItemTag(item.id)}
                disabled={mutationLocked || sourceReadBlocked}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "6px 12px",
                  borderRadius: "20px",
                  fontSize: "13px",
                  cursor: mutationLocked || sourceReadBlocked ? "not-allowed" : "pointer",
                  transition: "all 0.15s ease",
                  border: isAdded ? "1.5px solid var(--green, #2e7d32)" : "1px solid var(--line, #d0d7cf)",
                  background: isAdded ? "var(--green-subtle, #e8f5e9)" : "#ffffff",
                  color: isAdded ? "var(--green, #1b5e20)" : "inherit",
                  fontWeight: isAdded ? 700 : 400,
                }}
                title={isAdded ? "點擊自盤點清單移除" : "點擊加入盤點清單"}
              >
                <span style={{ fontSize: "12px", fontWeight: 800 }}>{isAdded ? "✓" : "+"}</span>
                <span>{item.item_code}｜{item.item_name}{item.size ? `｜${item.size}` : ""}</span>
                <span style={{ fontSize: "11px", opacity: 0.85, background: isAdded ? "#c8e6c9" : "#f0f2f0", padding: "1px 6px", borderRadius: "10px" }}>
                  帳面:{bookQty}
                </span>
              </button>
            );
          })}
          {filteredTagItems.length === 0 ? (
            <span style={{ fontSize: "13px", color: "var(--muted, #888)", padding: "8px 0" }}>
              {scopedItems.length === 0 ? "目前倉庫沒有可盤點品號" : "沒有符合搜尋條件的品號標籤"}
            </span>
          ) : null}
        </div>
      </div>
    ) : null}
    <label className="field reason-field"><span>盤點備註（選填）</span><input value={note} onChange={(event) => { resetOperationKeys(); setNote(event.target.value); }} disabled={mutationLocked || displayStocktake?.status === "POSTED"} maxLength={2000} /></label>
    {visibleLines.length > 0 ? <div className="summary-list">{visibleLines.map((line) => { const item = itemById.get(line.item_id); const difference = line.counted_quantity - line.book_quantity_snapshot; return <div className="summary-row" key={line.item_id}><span><strong>{item?.item_code ?? line.item_id}｜{item?.item_name ?? "品號"}</strong><small>帳面 {line.book_quantity_snapshot}／版本 {line.balance_version_snapshot}／差額 {difference}</small></span><label className="field"><span className="sr-only">實盤量</span><input type="number" min={0} value={line.counted_quantity} disabled={mutationLocked || !canEdit} onChange={(event) => updateLine(line.item_id, "counted_quantity", event.target.value)} /></label><label className="field"><span className="sr-only">差異原因</span><input value={line.reason} disabled={mutationLocked || !canEdit} onChange={(event) => updateLine(line.item_id, "reason", event.target.value)} placeholder={difference === 0 ? "無差異" : "差異原因（必填）"} maxLength={500} /></label>{!displayStocktake ? <button className="text-button" type="button" onClick={() => removeLine(line.item_id)} disabled={mutationLocked}>移除</button> : null}</div>; })}</div> : <p className="auth-message">請先加入要盤點的品號。</p>}
    <WorkflowActionBar
      primary={{
        onClick: () => void completeStocktake(),
        busy,
        busyLabel: "處理中…",
        disabled: busy || (!completionOutcomeUnknown && !displayStocktake && sourceReadBlocked) || visibleLines.length === 0 || needsRecountConfirmation || visibleLines.some((line) => line.counted_quantity - line.book_quantity_snapshot !== 0 && !line.reason.trim()) || displayStocktake?.status === "POSTED" || displayStocktake?.status === "STALE_COUNT",
        label: completionOutcomeUnknown ? "沿用相同資料重試" : displayStocktake?.status === "POSTED" ? "已完成" : needsRecountConfirmation ? "請先保存重新實盤" : "確認並完成盤點",
      }}
      secondary={!displayStocktake
        ? <button className="secondary-button" type="button" onClick={() => void createDraft()} disabled={mutationLocked || sourceReadBlocked || visibleLines.length === 0}>{busy ? "建立中…" : sourceReadBlocked ? "載入資料中…" : "先建立盤點草稿"}</button>
        : displayStocktake.status === "DRAFT"
          ? <button className="secondary-button" type="button" onClick={() => void updateDraft()} disabled={mutationLocked || visibleLines.length === 0}>{busy ? "保存中…" : "保存盤點草稿"}</button>
          : displayStocktake.status === "STALE_COUNT"
            ? <button className="secondary-button" type="button" onClick={() => void recaptureBook()} disabled={mutationLocked}>{busy ? "擷取中…" : "重新擷取帳面並開始重盤"}</button>
            : <button className="secondary-button" type="button" onClick={startNextStocktake} disabled={mutationLocked}>建立下一張盤點</button>}
    />
    {displayStocktake?.status === "POSTED" ? <p className="success-note">盤點單 {displayStocktake.stocktake_no} 已完成，原盤點與紀錄均已鎖定。</p> : null}
    {message ? <p className={messageIsSuccess ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
