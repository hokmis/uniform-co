import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readAppFile(fileName: string): string {
  return fs.readFileSync(path.resolve("src/app", fileName), "utf8");
}

describe("warehouse operation UI contracts", () => {
  it("allows the next shipment to be selected after the current shipment is posted", () => {
    const panel = readAppFile("WarehouseShipmentPanel.tsx");

    expect(panel).toContain("(draftDirty && row.id !== requestKey)");
    expect(panel).toContain("function startNextShipment()");
    expect(panel).toContain("處理下一筆");
  });

  it("does not show a queue row as active before its detail lines are loaded", () => {
    const panel = readAppFile("WarehouseShipmentPanel.tsx");

    expect(panel).toContain("const requestKeyRef = useRef(\"\");");
    expect(panel).toContain("if (!loaded.some((request) => request.queue_key === requestKeyRef.current))");
    expect(panel).toContain("setLines([]);");
  });

  it("loads the warehouse queue through the read adapter so an unapplied view does not blank the workbench", () => {
    const panel = readAppFile("WarehouseShipmentPanel.tsx");

    expect(panel).toContain("loadWarehouseShipmentQueue(supabase)");
    expect(panel).not.toContain('supabase.from("v_warehouse_shipment_queue")');
  });

  it("only blocks shipment queue switching when local line edits are unsaved", () => {
    const panel = readAppFile("WarehouseShipmentPanel.tsx");

    expect(panel).toContain("const [draftDirty, setDraftDirty] = useState(false)");
    expect(panel).toContain("changedWarehouseShipmentLines(updatedLines, persistedLinesRef.current).length > 0");
    expect(panel).toContain("尚未保存的變更");
    expect(panel).toContain("const canRefreshQueue = canRefreshWarehouseShipmentQueue({ queueLoading, detailsLoading, busy, draftDirty });");
    expect(panel).toContain("disabled={!canRefreshQueue}");
    expect(panel).toContain("changedWarehouseShipmentLines(activeLines, persistedLinesRef.current)");
    expect(panel).toContain("Promise.all(unsavedLines.map");
    expect(panel).toContain('.select("id").maybeSingle()');
    expect(panel).toContain("理貨明細保存結果尚未確認");
    expect(panel).not.toContain("for (const line of lines)");
    expect(panel).not.toContain("Boolean(selectedRequest && !posted && lines.length > 0 && row.id !== requestKey)");
  });

  it("allows terminal warehouse transactions to continue without leaving the panel", () => {
    const contracts = [
      ["PurchaseReceiptPanel.tsx", "startNextReceipt", "處理下一筆"],
      ["ReturnPanel.tsx", "startNextReturn", "處理下一筆"],
      ["StocktakePanel.tsx", "startNextStocktake", "建立下一張盤點"],
    ] as const;

    for (const [fileName, handler, label] of contracts) {
      const source = readAppFile(fileName);
      expect(source, fileName).toContain(`function ${handler}()`);
      expect(source, fileName).toContain(label);
    }
  });

  it("offers a one-step receipt completion path while retaining draft recovery", () => {
    const source = readAppFile("PurchaseReceiptPanel.tsx");

    expect(source).toContain("async function completeReceipt()");
    expect(source).toContain("確認並完成入庫");
    expect(source).toContain("先保存入庫草稿");
    expect(source).toContain("completePurchaseReceipt(");
    expect(source).toContain("const postFingerprintRef = useRef<string | null>(null)");
    expect(source).toContain("postFingerprintRef.current = postFingerprint");
    expect(source).toContain("p_request_fingerprint: postFingerprintRef.current");
    expect(source).not.toContain("const createdReceipt = await createDraft(true)");
    expect(source).toContain("onChange={(event) => chooseOrder(event.target.value)} disabled={busy || dataReadBlocked || Boolean(activeReceipt)}");
    expect(source).toContain("const lineSelectionLoading = linesLoading || (ordersLoading && !selectedOrder);");
    expect(source).toContain("onChange={(event) => chooseLine(event.target.value)} disabled={busy || dataReadBlocked || Boolean(activeReceipt) || lineSelectionLoading || !selectedOrder}");
    expect(source).toContain("setLines([]); setLinesLoading(false); setReceipt(null)");
    expect(source).toContain("setLinesLoading(false); setReceipt(null); setReceiptNo(\"\")");
    expect(source).toContain("const orderIdRef = useRef(\"\");");
    expect(source).toContain("const nextOrderId = sameAccountSnapshot");
    expect(source).not.toContain("onChange={(event) => chooseLine(event.target.value)} disabled={busy || Boolean(receipt) || dataLoading || !selectedOrder}");
    expect(source).not.toContain("onChange={(event) => chooseOrder(event.target.value)} disabled={busy || Boolean(receipt) || loadingData}");
  });

  it("offers a one-step return completion path while retaining draft recovery", () => {
    const source = readAppFile("ReturnPanel.tsx");

    expect(source).toContain("async function completeReturn()");
    expect(source).toContain("completeReturnOperation(rpc, client");
    expect(source).toContain("確認並完成退回");
    expect(source).toContain("先保存退回草稿");
    expect(source).toContain("await postReturn(returnNote)");
    expect(source).toContain("const requestFingerprint = postFingerprintRef.current");
    expect(source).toContain("postFingerprintRef.current = requestFingerprint");
  });

  it("loads return reason codes once per panel activation instead of once per selection", () => {
    const source = readAppFile("ReturnPanel.tsx");

    expect(source).toContain("async function loadReasonCodes()");
    expect(source).toContain("return () => { active = false; }");
    expect(source).toContain("}, [accountId, client, identityReady]);");
    expect(source).not.toContain("}, [client, panelActive, reasonCode]);");
  });

  it("keeps same-account return reason options usable during a background refresh", () => {
    const source = readAppFile("ReturnPanel.tsx");
    expect(source).toContain("const hasCurrentReasonCodeSnapshot = hasCurrentReadSnapshot(identityReady, reasonCodesSnapshotAccountId, accountId);");
    expect(source).toContain("const visibleReasonCodes = hasCurrentReasonCodeSnapshot ? reasonCodes : [];");
    expect(source).toContain("const selectedReasonCodeIsCurrent = Boolean(");
    expect(source).toContain("disabled={busy || !hasCurrentReasonCodeSnapshot || visibleReasonCodes.length === 0 || Boolean(activeReturnNote)}");
    expect(source).not.toContain("disabled={busy || reasonCodesLoading || Boolean(activeReturnNote)}");
    expect(source).toContain("reasonCodesSnapshotAccountIdRef.current !== activeAccountId");
    expect(source).toContain("reasonCodesSnapshotAccountIdRef.current === activeAccountId");
    expect(source).toContain("!selectedReasonCodeIsCurrent || !returnDate");
    expect(source).toContain("shouldPreserveReadSnapshot(reasonCodesRef.current, [result.error])");
  });

  it("separates transaction source loading from mutation busy state", () => {
    const returnSource = readAppFile("ReturnPanel.tsx");
    expect(returnSource).toContain("const dataLoading = requestsLoading || reasonCodesLoading || linesLoading;");
    expect(returnSource).toContain("const transactionLoading = requestsLoading || linesLoading;");
    expect(returnSource).toContain("const actionLoading = transactionLoading || (reasonCodesLoading && !hasCurrentReasonCodeSnapshot);");
    expect(returnSource).toContain("setRequestsLoading(true)");
    expect(returnSource).toContain("setReasonCodesLoading(true)");
    expect(returnSource).toContain("setLinesLoading(true)");
    expect(returnSource).toContain("aria-busy={dataLoading}");
    expect(returnSource).toContain("日期、單號與理由仍可先填寫");
    expect(returnSource).toContain("disabled: busy || dataReadBlocked || actionLoading || !selectedLine || !returnNo.trim()");
    expect(returnSource).toContain("disabled={busy || dataReadBlocked || actionLoading || !selectedLine || !selectedReasonCodeIsCurrent}");
    expect(returnSource).toContain("actionLoading ? \"載入必要資料中…\" : \"先保存退回草稿\"");
    expect(returnSource).toContain("const visibleRequests = useMemo(() => hasCurrentDataSnapshot ? requests : [], [hasCurrentDataSnapshot, requests]);");
    expect(returnSource).toContain("dataSnapshotAccountIdRef.current === accountId");
    expect(returnSource).toContain("staleReadSnapshotMessage(\"已發貨需求\")");
    expect(returnSource).toContain("setIssueLines([]); setLinesLoading(false); setSelectedLineId(\"\")");
    expect(returnSource).toContain("setRequestId(nextId); setLinesLoading(false);");
    expect(returnSource).toContain("const requestIdRef = useRef(\"\");");
    expect(returnSource).toContain("const nextRequestId = sameAccountSnapshot");

    const requestSelector = returnSource.split(/\r?\n/).find((line) => line.includes("<span>已發貨需求</span>"));
    const requestSelectorDisabled = requestSelector?.match(/disabled=\{([^}]*)\}/)?.[1] ?? "";
    expect(requestSelectorDisabled).toBe("busy || dataReadBlocked || Boolean(activeReturnNote)");
    expect(requestSelectorDisabled).not.toContain("requestsLoading");
    expect(returnSource).toContain("const transactionLoading = requestsLoading || linesLoading;");
    expect(returnSource).toContain("disabled={busy || dataReadBlocked || actionLoading || !selectedLine || !selectedReasonCodeIsCurrent}");

    const stocktakeSource = readAppFile("StocktakePanel.tsx");
    expect(stocktakeSource).toContain("const dataLoading = masterDataLoading || balancesLoading;");
    expect(stocktakeSource).toContain("const balancesLoading = isReadPendingForSelection(");
    expect(stocktakeSource).toContain("const [balanceLoadingWarehouseId, setBalanceLoadingWarehouseId] = useState<string | null>(null);");
    expect(stocktakeSource).toContain("setBalanceLoadingWarehouseId(warehouseId);");
    expect(stocktakeSource).toContain("if (active) setBalanceLoadingWarehouseId((current) => current === warehouseId ? null : current);");
    expect(stocktakeSource).not.toContain("const [balancesLoading, setBalancesLoading] = useState(false);");
    expect(stocktakeSource).not.toContain("setBalancesLoading(Boolean(nextId))");
    expect(stocktakeSource).toContain("const masterDataReadBlocked = !accessSnapshotReady || !masterDataSnapshotReady;");
    expect(stocktakeSource).toContain("const balanceReadBlocked = Boolean(warehouseId) && balanceSnapshotWarehouseId !== warehouseId;");
    expect(stocktakeSource).toContain("const identityReady = Boolean(isAuthenticated && accountId && !identityLoading && !identityError);");
    expect(stocktakeSource).toContain("const sourceReadBlocked = !identityReady || masterDataReadBlocked || balanceReadBlocked;");
    expect(stocktakeSource).toContain("const accessSnapshotKey = `${authUserId ?? \"\"}:${accountId ?? \"\"}:${[...roles].sort().join(\",\")}`;");
    expect(stocktakeSource).toContain("accessSnapshotKeyRef.current !== accessSnapshotKey");
    expect(stocktakeSource).toContain("setStocktake(null);");
    expect(stocktakeSource).toContain("setMasterDataLoading(true)");
    expect(stocktakeSource).toContain("setBalanceLoadingWarehouseId(null);");
    expect(stocktakeSource).toContain("setBalances({});");
    expect(stocktakeSource).toContain("aria-busy={dataLoading}");
    expect(stocktakeSource).toContain("staleReadSnapshotMessage(\"盤點主檔選項\")");
    expect(stocktakeSource).toContain("staleReadSnapshotMessage(\"帳面庫存\")");
    expect(stocktakeSource).toContain("背景更新盤點資料；已載入的內容仍可繼續編輯");
    expect(stocktakeSource).not.toContain("disabled={busy || dataLoading || visibleLines.length === 0}");

    const shipmentSource = readAppFile("WarehouseShipmentPanel.tsx");
    expect(shipmentSource).toContain("const [detailsLoading, setDetailsLoading] = useState(false);");
    expect(shipmentSource).toContain("if (busy) return;");
    expect(shipmentSource).toContain("const detailsReadControllerRef = useRef<ReadRequestController | null>(null);");
    expect(shipmentSource).toContain("const readSequence = readController.begin();");
    expect(shipmentSource).toContain("if (!readController.isCurrent(readSequence)) return;");
    expect(shipmentSource).toContain("if (readController.isCurrent(readSequence)) setDetailsLoading(false);");
    expect(shipmentSource).toContain("detailsReadControllerRef.current?.invalidate();");
    expect(shipmentSource).toContain("detailsReadControllerRef.current?.invalidate();\n          setDetailsLoading(false);");
    expect(shipmentSource).not.toContain("disabled={busy || detailsLoading || (draftDirty && row.id !== requestKey)}");
    expect(shipmentSource).toContain("setDetailsLoading(true)");
    expect(shipmentSource).toContain("aria-busy={queueLoading || detailsLoading || busy}");
    expect(shipmentSource).toContain("正在載入理貨明細…");

    const replenishmentSource = readAppFile("ReplenishmentPanel.tsx");
    expect(replenishmentSource).toContain("const hasCurrentItemSnapshot = previewMode || Boolean(");
    expect(replenishmentSource).toContain("shouldPreserveReadSnapshot(itemsRef.current, errors)");
    expect(replenishmentSource).toContain('staleReadSnapshotMessage("補庫品號")');
    expect(replenishmentSource).toContain("disabled={busy || submitted || cancellationUnresolved || (!submissionUnresolved && itemsReadBlocked) || !identityReady}");
    expect(replenishmentSource).not.toContain("disabled={busy || !dataReady || submitted || !identityReady}");
  });

  it("offers one-step HR shipment completion while retaining draft recovery", () => {
    const source = readAppFile("WarehouseShipmentPanel.tsx");

    expect(source).toContain("async function completeShipment()");
    expect(source).toContain("建立並完成發貨");
    expect(source).toContain("建立理貨草稿");
    expect(source).toContain("await postShipment({ shipmentId: created.id, lines: created.lines })");
  });

  it("uses a rollout-safe consolidated queue read seam without embedding database queries in the panel", () => {
    const source = readAppFile("WarehouseShipmentPanel.tsx");
    const adapter = fs.readFileSync(path.resolve("src", "lib", "warehouse-shipment-queue-read.ts"), "utf8");
    expect(source).toContain("loadWarehouseShipmentQueue(supabase)");
    expect(source).not.toContain('from("v_warehouse_shipment_queue")');
    expect(adapter).toContain('client.from(viewName).select(viewSelect)');
    expect(adapter).toContain('client.from("hr_requests")');
    expect(adapter).toContain('client.from("replenishment_requests")');
    expect(adapter).toContain('client.from("warehouse_shipments")');
    expect(adapter).toContain('result.error.code !== "PGRST200" && result.error.code !== "PGRST201"');

    const migration = fs.readFileSync(path.resolve("supabase", "migrations", "0103_warehouse_shipment_queue_view.sql"), "utf8");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("union all");
    expect(migration).toContain("grant select on public.v_warehouse_shipment_queue to authenticated");
  });

  it("uses one RLS-backed source view for transfer correction options", () => {
    const source = readAppFile("WarehouseTransferCorrectionPanel.tsx");
    expect(source).toContain('from("v_warehouse_transfer_correction_sources")');
    expect(source).not.toContain('from("warehouse_shipments")');
    expect(source).not.toContain('from("replenishment_requests")');
    expect(source).not.toContain('from("warehouse_shipment_lines")');
    expect(source).not.toContain('from("replenishment_request_lines")');

    const migration = fs.readFileSync(path.resolve("supabase", "migrations", "0105_warehouse_transfer_correction_source_view.sql"), "utf8");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("union all");
    expect(migration).toContain("actual_transfer_quantity is not null");
    expect(migration).toContain("grant select on public.v_warehouse_transfer_correction_sources to authenticated");
  });

  it("uses one RLS-backed source view for stocktake correction options", () => {
    const source = readAppFile("StocktakeCorrectionPanel.tsx");
    expect(source).toContain('from("v_stocktake_correction_sources")');
    expect(source).not.toContain('from("stocktakes")');
    expect(source).not.toContain('from("stocktake_lines")');
    expect(source).not.toContain("loadActiveWarehouseOptions");

    const migration = fs.readFileSync(path.resolve("supabase", "migrations", "0106_stocktake_correction_source_view.sql"), "utf8");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("join public.warehouses");
    expect(migration).toContain("join public.stocktake_lines");
    expect(migration).toContain("grant select on public.v_stocktake_correction_sources to authenticated");
  });

  it("uses consolidated source views for receipt and return correction options", () => {
    const receiptSource = readAppFile("PurchaseReceiptCorrectionPanel.tsx");
    const returnSource = readAppFile("ReturnCorrectionPanel.tsx");
    expect(receiptSource).toContain('from("v_purchase_receipt_correction_sources")');
    expect(receiptSource).not.toContain('from("purchase_receipts")');
    expect(receiptSource).not.toContain('from("purchase_receipt_lines")');
    expect(returnSource).toContain('from("v_return_correction_sources")');
    expect(returnSource).not.toContain('from("return_notes")');
    expect(returnSource).not.toContain('from("return_lines")');

    const migration = fs.readFileSync(path.resolve("supabase", "migrations", "0107_receipt_return_correction_source_views.sql"), "utf8");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("public.v_purchase_receipt_correction_sources");
    expect(migration).toContain("public.v_return_correction_sources");
    expect(migration).toContain("grant select on public.v_purchase_receipt_correction_sources");
  });

  it("uses one RLS-backed source view for HR issue correction options", () => {
    const source = readAppFile("HrIssueCorrectionPanel.tsx");
    expect(source).toContain('from("v_hr_issue_correction_sources")');
    expect(source).not.toContain('from("hr_requests")');
    expect(source).not.toContain('from("hr_issue_lines")');

    const migration = fs.readFileSync(path.resolve("supabase", "migrations", "0108_hr_issue_correction_source_view.sql"), "utf8");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("join public.hr_issue_lines");
    expect(migration).toContain("where request_row.status = 'SHIPPED'");
    expect(migration).toContain("grant select on public.v_hr_issue_correction_sources to authenticated");
  });

  it("completes stocktake through the atomic adapter while retaining recount fencing", () => {
    const source = readAppFile("StocktakePanel.tsx");
    const migration = fs.readFileSync(path.resolve("supabase", "migrations", "0127_atomic_stocktake_completion.sql"), "utf8");

    expect(source).toContain("async function completeStocktake()");
    expect(source).toContain("確認並完成盤點");
    expect(source).toContain("completeStocktakeOperation(rpc");
    expect(source).toContain("attemptOptionalRpc");
    expect(source).not.toContain("serverCompletionSupportedRef");
    expect(source).toContain("沿用相同資料重試");
    expect(source).not.toContain("await updateDraft(lines, true)");
    expect(source).not.toContain("await postStocktake(updated, lines)");
    expect(migration).toContain("public.create_stocktake_draft(");
    expect(migration).toContain("public.update_stocktake_draft(");
    expect(migration).toContain("public.post_stocktake(");
    expect(source).toContain("重新擷取帳面並開始重盤");
  });

  it("uses a server-side stocktake recapture seam with a pre-migration fallback", () => {
    const source = readAppFile("StocktakePanel.tsx");
    const migration = fs.readFileSync(path.resolve("supabase", "migrations", "0113_stocktake_server_recapture.sql"), "utf8");

    expect(source).toContain('"recapture_stocktake_draft"');
    expect(source).toContain("attemptOptionalRpc");
    expect(source).not.toContain("serverRecaptureSupportedRef");
    expect(source).not.toContain('serverError.code !== "42883"');
    expect(source).toContain('from("inventory_balances")');
    expect(migration).toContain("create or replace function public.recapture_stocktake_draft");
    expect(migration).toContain("public.update_stocktake_draft(");
    expect(migration).toContain("for update");
    expect(migration).toContain("grant execute on function public.recapture_stocktake_draft");
  });

  it("uses one server transaction for HR shipment line edits and posting", () => {
    const source = readAppFile("WarehouseShipmentPanel.tsx");
    const migration = fs.readFileSync(path.resolve("supabase", "migrations", "0114_warehouse_post_with_lines.sql"), "utf8");

    expect(source).toContain('"post_warehouse_shipment_with_lines"');
    expect(source).toContain("attemptOptionalRpc");
    expect(source).not.toContain('combinedResult.error.code !== "42883"');
    expect(source).toContain('rpc("post_warehouse_shipment"');
    expect(source).toContain("isWarehousePostConfirmed");
    expect(source).toContain("catch {");
    expect(migration).toContain("create or replace function public.post_warehouse_shipment_with_lines");
    expect(migration).toContain("public.post_warehouse_shipment(");
    expect(migration).toContain("POST_WAREHOUSE_SHIPMENT_WITH_LINES");
    expect(migration).toContain("grant execute on function public.post_warehouse_shipment_with_lines");
  });

  it("uses one server-shaped read for replenishment shipment lines with a rollout fallback", () => {
    const source = readAppFile("WarehouseShipmentPanel.tsx");
    const adapter = fs.readFileSync(path.resolve("src", "lib", "replenishment-shipment-read.ts"), "utf8");
    const migration = fs.readFileSync(path.resolve("supabase", "migrations", "0117_replenishment_shipment_lines_view.sql"), "utf8");

    expect(source).toContain("loadReplenishmentShipmentLines");
    expect(source).not.toContain('from("replenishment_request_lines")');
    expect(source).not.toContain('from("v_item_availability")');
    expect(adapter).toContain('from("v_replenishment_shipment_lines")');
    expect(adapter).toContain('from("replenishment_request_lines")');
    expect(adapter).toContain('from("v_item_availability")');
    expect(adapter).toContain("shouldProbeReadModel");
    expect(adapter).toContain("shouldUseLegacyReadModel");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("replenishment_request_lines_request_item_read_idx");
    expect(migration).toContain("grant select on public.v_replenishment_shipment_lines to authenticated");
  });

  it("uses one server-shaped read for HR shipment lines with a rollout fallback", () => {
    const source = readAppFile("WarehouseShipmentPanel.tsx");
    const loaderStart = source.indexOf("async function loadShipmentLines");
    const loaderEnd = source.indexOf("async function loadReplenishmentLines", loaderStart);
    const loader = source.slice(loaderStart, loaderEnd);
    const adapter = fs.readFileSync(path.resolve("src", "lib", "warehouse-shipment-read.ts"), "utf8");
    const migration = fs.readFileSync(path.resolve("supabase", "migrations", "0119_warehouse_shipment_lines_view.sql"), "utf8");

    expect(loader).toContain("loadWarehouseShipmentLines");
    expect(loader).not.toContain('from("warehouse_shipment_lines")');
    expect(loader).not.toContain('from("hr_request_items")');
    expect(adapter).toContain('from("v_warehouse_shipment_lines")');
    expect(adapter).toContain('from("warehouse_shipment_lines")');
    expect(adapter).toContain('from("hr_request_items")');
    expect(adapter).toContain("shouldProbeReadModel");
    expect(adapter).toContain("shouldUseLegacyReadModel");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("warehouse_shipment_lines_shipment_item_read_idx");
    expect(migration).toContain("grant select on public.v_warehouse_shipment_lines to authenticated");
  });

  it("offers a one-step HR issue correction path while retaining draft recovery", () => {
    const source = readAppFile("HrIssueCorrectionPanel.tsx");

    expect(source).toContain("async function completeCorrection()");
    expect(source).toContain("確認並完成更正");
    expect(source).toContain("先建立更正草稿");
    expect(source).toContain('atomicFunctionName: "complete_hr_issue_correction"');
    expect(source).toContain("completeCorrectionOperation");
    expect(source).toContain("await postDraft(correction)");
    expect(source).toContain('get_hr_issue_correction_status');
  });

  it("offers one-step completion for every remaining correction panel", () => {
    const contracts = [
      ["ReturnCorrectionPanel.tsx", "確認並完成退回更正", "先建立退回更正草稿", "complete_return_correction", "get_return_correction_status"],
      ["PurchaseReceiptCorrectionPanel.tsx", "確認並完成入庫更正", "先建立入庫更正草稿", "complete_purchase_receipt_correction", "get_purchase_receipt_correction_status"],
      ["WarehouseTransferCorrectionPanel.tsx", "確認並完成調撥更正", "先建立調撥更正草稿", "complete_warehouse_transfer_correction", "get_warehouse_transfer_correction_status"],
      ["StocktakeCorrectionPanel.tsx", "確認並完成盤點更正", "先建立盤點更正草稿", "complete_stocktake_correction", "get_stocktake_correction_status"],
    ] as const;

    for (const [fileName, completeLabel, draftLabel, atomicFunction, recoveryFunction] of contracts) {
      const source = readAppFile(fileName);
      expect(source, fileName).toContain("async function completeCorrection()");
      expect(source, fileName).toContain(completeLabel);
      expect(source, fileName).toContain(draftLabel);
      expect(source, fileName).toContain(`atomicFunctionName: "${atomicFunction}"`);
      expect(source, fileName).toContain("completeCorrectionOperation");
      expect(source, fileName).toContain(`"${recoveryFunction}"`);
      expect(source, fileName).toContain("function createDraft(");
    }
  });

  it("does not query protected warehouse data before the workspace identity is ready", () => {
    for (const fileName of [
      "WarehouseShipmentPanel.tsx",
      "StocktakePanel.tsx",
      "StocktakeCorrectionPanel.tsx",
      "WarehouseTransferCorrectionPanel.tsx",
      "InventoryHistoryExportPanel.tsx",
      "DurableImportPanel.tsx",
      "PurchaseReceiptPanel.tsx",
      "ReturnPanel.tsx",
      "PurchaseReceiptCorrectionPanel.tsx",
      "ReturnCorrectionPanel.tsx",
    ]) {
      const source = readAppFile(fileName);
      expect(source, fileName).toContain("useWorkspaceSession");
      expect(source, fileName).toContain("identityLoading");
      expect(source, fileName).toContain("identityError");
      expect(source, fileName).toContain("accountId");
      expect(source, fileName).toContain("hasSession");
    }
  });

  it("retries read-only warehouse queries after a transient browser session sync error", () => {
    for (const fileName of [
      "PurchaseReceiptPanel.tsx",
      "PurchaseReceiptCorrectionPanel.tsx",
      "ReturnPanel.tsx",
      "ReturnCorrectionPanel.tsx",
      "WarehouseShipmentPanel.tsx",
      "StocktakePanel.tsx",
      "StocktakeCorrectionPanel.tsx",
      "WarehouseTransferCorrectionPanel.tsx",
      "InventoryHistoryExportPanel.tsx",
      "DurableImportPanel.tsx",
    ]) {
      expect(readAppFile(fileName), fileName).toContain("retrySupabaseQueriesAfterSessionRefresh");
    }
  });

  it("refreshes inventory and overview projections after a posted inventory mutation", () => {
    expect(readAppFile("InventoryAvailabilityPanel.tsx")).toContain("inventoryDataChangedEvent");
    const overview = readAppFile("OverviewDashboard.tsx");
    expect(overview).toContain("inventoryDataChangedEvent");
    expect(overview).toContain('queueReload("inventory")');
    expect(overview).toContain('queueReload("workflow")');
    expect(overview).toContain("overviewReadPlanForScope");
    expect(overview).toContain("queueReload");
    expect(overview).toContain("hrRequestWorkflowChangedEvent");
    for (const fileName of [
      "WarehouseShipmentPanel.tsx",
      "StocktakePanel.tsx",
      "StocktakeCorrectionPanel.tsx",
      "WarehouseTransferCorrectionPanel.tsx",
    ]) {
      expect(readAppFile(fileName), fileName).toContain("notifyInventoryDataChanged");
    }
  });

  it("refreshes HR workflow projections when stocktake can invalidate reservations", () => {
    expect(readAppFile("StocktakePanel.tsx")).toContain("hrRequestWorkflowChangedEvent");
    expect(readAppFile("StocktakeCorrectionPanel.tsx")).toContain("hrRequestWorkflowChangedEvent");
  });

  it("keeps the selected request while workflow history refreshes", () => {
    const history = readAppFile("HrRequestHistoryPanel.tsx");
    expect(history).toContain("selectedIdRef");
    expect(history).toContain("refreshScheduledRef");
  });

  it("filters stocktake sources by the effective HR or WAREHOUSE role", () => {
    expect(readAppFile("StocktakePanel.tsx")).toContain("warehouse.purpose === \"GENERAL\" && canCountGeneral");
    expect(readAppFile("StocktakeCorrectionPanel.tsx")).toContain("purpose === \"GENERAL\" && canCountGeneral");
  });

  it("requires explicit source selection instead of silently choosing the first row", () => {
    const purchaseReceipt = readAppFile("PurchaseReceiptPanel.tsx");
    const returnPanel = readAppFile("ReturnPanel.tsx");
    const stocktake = readAppFile("StocktakePanel.tsx");
    const erpExport = readAppFile("ErpExportPanel.tsx");
    const replenishment = readAppFile("ReplenishmentPanel.tsx");

    expect(purchaseReceipt).toContain("const nextOrderId = sameAccountSnapshot");
    expect(purchaseReceipt).toContain('setLineId((current) => loadedLines.some((line) => line.id === current) ? current : "")');
    expect(purchaseReceipt).not.toContain("loadedOrders[0]?.id");
    expect(purchaseReceipt).not.toContain("loadedLines[0]?.id");

    expect(returnPanel).toContain("const nextRequestId = sameAccountSnapshot");
    expect(returnPanel).toContain('setSelectedLineId((current) => loaded.some((line) => line.id === current) ? current : "")');
    expect(returnPanel).not.toContain("setRequestId(loaded[0].id)");
    expect(returnPanel).not.toContain("setSelectedLineId(loaded[0]?.id");
    expect(returnPanel).not.toContain("loaded[0].code");

    expect(stocktake).toContain('setWarehouseId((current) => loadedWarehouses.some((warehouse) => warehouse.id === current) ? current : "")');
    expect(stocktake).not.toContain("setWarehouseId(loadedWarehouses[0].id)");
    expect(erpExport).toContain("const [institutionSelection, setInstitutionSelection]");
    expect(erpExport).toContain("institutionSelection?.accountId === accountId");
    expect(erpExport).toContain("setInstitutionSelection({ accountId, institutionId: event.target.value })");
    expect(erpExport).not.toContain("setInstitutionSelection({ accountId, institutionId: institutions[0]?.id");
    expect(replenishment).toContain('setLines([{ itemId: "", quantity: 1 }])');
    expect(replenishment).toContain('<option value="">{itemsReadBlocked && dataLoading ? "載入品號中…" : "請選擇制服品號"}</option>');
    expect(replenishment).not.toContain("setLines([{ itemId: loaded[0].id");
  });
});
