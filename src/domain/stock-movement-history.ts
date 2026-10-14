export type StockMovementPostingKind =
  | "WAREHOUSE_SHIPMENT"
  | "REPLENISHMENT"
  | "HR_REQUEST_RESERVATION"
  | "HR_ISSUE_CORRECTION"
  | "RETURN"
  | "RETURN_CORRECTION"
  | "RECEIPT"
  | "PURCHASE_RECEIPT_CORRECTION"
  | "STOCKTAKE"
  | "STOCKTAKE_CORRECTION"
  | "ADJUSTMENT"
  | "TRANSFER_CORRECTION"
  | "OPENING";

export type StockMovementRow = {
  id: string; // posting_id + "_" + item_id
  postingId: string;
  postingKind: StockMovementPostingKind;
  postingKindLabel: string;
  sourceNo: string;
  occurredOn: string;
  postedAt: string;
  postedByName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  size: string;
  unit: string;
  hrDelta: number;
  generalDelta: number;
  hrOnHand: number;
  generalOnHand: number;
};

export type StockMovementFilter = {
  query?: string;
  postingKind?: StockMovementPostingKind | "ALL";
  postingKinds?: StockMovementPostingKind[];
  startDate?: string;
  endDate?: string;
};

export const ALL_POSTING_KINDS: Array<{ kind: StockMovementPostingKind; label: string }> = [
  { kind: "HR_REQUEST_RESERVATION", label: "需求預留(待發貨)" },
  { kind: "WAREHOUSE_SHIPMENT", label: "員工需求發貨" },
  { kind: "REPLENISHMENT", label: "額外補庫調撥" },
  { kind: "HR_ISSUE_CORRECTION", label: "人資發放更正" },
  { kind: "RETURN", label: "員工制服退回" },
  { kind: "RETURN_CORRECTION", label: "退回更正" },
  { kind: "RECEIPT", label: "廠商採購入庫" },
  { kind: "PURCHASE_RECEIPT_CORRECTION", label: "採購驗收更正" },
  { kind: "STOCKTAKE", label: "倉庫盤點盈虧" },
  { kind: "STOCKTAKE_CORRECTION", label: "盤點更正" },
  { kind: "ADJUSTMENT", label: "庫存調整" },
  { kind: "TRANSFER_CORRECTION", label: "調撥更正" },
  { kind: "OPENING", label: "期初開帳導入" },
];

export type StockMovementSortKey =
  | "posted_at"
  | "source_no"
  | "item_code"
  | "item_name"
  | "size"
  | "hr_delta"
  | "general_delta"
  | "hr_on_hand"
  | "general_on_hand";

export type StockMovementSortDirection = "asc" | "desc";

export function postingKindToLabel(kind: string): string {
  switch (kind) {
    case "WAREHOUSE_SHIPMENT":
      return "員工需求發貨";
    case "REPLENISHMENT":
      return "額外補庫調撥";
    case "HR_REQUEST_RESERVATION":
      return "需求預留(待發貨)";
    case "HR_ISSUE_CORRECTION":
      return "人資發放更正";
    case "RETURN":
      return "員工制服退回";
    case "RETURN_CORRECTION":
      return "退回更正";
    case "RECEIPT":
      return "廠商採購入庫";
    case "PURCHASE_RECEIPT_CORRECTION":
      return "採購驗收更正";
    case "STOCKTAKE":
      return "倉庫盤點盈虧";
    case "STOCKTAKE_CORRECTION":
      return "盤點更正";
    case "ADJUSTMENT":
      return "庫存調整";
    case "TRANSFER_CORRECTION":
      return "調撥更正";
    case "OPENING":
      return "期初開帳導入";
    case "CORRECTION":
      return "更正作業";
    default:
      return kind;
  }
}

/**
 * 將 v_inventory_history 中的發貨與補庫流水，連同待發貨需求預留（v_hr_request_item_totals 中 status='SUBMITTED'），
 * 與 v_item_availability 的品項規格及兩倉現有量聚合為單一條列式進出貨紀錄
 */
export function aggregateStockMovements(
  historyRows: Array<Record<string, unknown>>,
  availabilityRows: Array<Record<string, unknown>>,
  pendingRequestRows: Array<Record<string, unknown>> = [],
): StockMovementRow[] {
  // 建立品項規格與現有量快取 Map
  const availabilityMap = new Map<string, { size: string; hrOnHand: number; generalOnHand: number; unit: string }>();
  for (const item of availabilityRows) {
    const itemId = String(item.item_id ?? "");
    if (itemId) {
      availabilityMap.set(itemId, {
        size: typeof item.size === "string" ? item.size : "",
        hrOnHand: Number(item.hr_on_hand_quantity) || 0,
        generalOnHand: Number(item.general_on_hand_quantity) || 0,
        unit: typeof item.unit === "string" ? item.unit : "件",
      });
    }
  }

  // 以 posting_id + "_" + item_id 聚合
  const groupMap = new Map<string, StockMovementRow>();

  // 1. 處理待發貨需求（需求預留）：人資倉增減量 -issue_quantity
  for (const req of pendingRequestRows) {
    const status = String(req.status ?? "");
    if (status !== "SUBMITTED") continue;

    const requestId = String(req.request_id ?? "");
    const itemId = String(req.item_id ?? "");
    if (!requestId || !itemId) continue;

    const issueQty = Number(req.issue_quantity) || 0;
    if (issueQty <= 0) continue;

    const groupKey = `REQ_${requestId}_${itemId}`;
    const avail = availabilityMap.get(itemId);
    const itemCode = String(req.item_code ?? "");
    const itemName = String(req.item_name ?? itemCode);
    const unit = String(req.unit ?? avail?.unit ?? "件");
    const size = avail?.size || "—";
    const hrOnHand = avail?.hrOnHand ?? 0;
    const generalOnHand = avail?.generalOnHand ?? 0;
    const sourceNo = String(req.request_no ?? "—");
    const distributionDate = String(req.distribution_date ?? "").slice(0, 10);
    const createdAt = String(req.created_at ?? distributionDate);

    groupMap.set(groupKey, {
      id: groupKey,
      postingId: requestId,
      postingKind: "HR_REQUEST_RESERVATION",
      postingKindLabel: postingKindToLabel("HR_REQUEST_RESERVATION"),
      sourceNo,
      occurredOn: distributionDate || createdAt.slice(0, 10),
      postedAt: createdAt,
      postedByName: "人資單位",
      itemId,
      itemCode,
      itemName,
      size,
      unit,
      hrDelta: -issueQty,
      generalDelta: 0,
      hrOnHand,
      generalOnHand,
    });
  }

  // 2. 處理全系統所有影響兩倉數量的不可變過帳流水
  for (const h of historyRows) {
    const rawPostingKind = String(h.posting_kind ?? "");
    const movementKind = String(h.movement_kind ?? "");

    let postingKind: StockMovementPostingKind;

    if (rawPostingKind === "CORRECTION" || movementKind.includes("CORRECTION")) {
      if (movementKind === "RETURN_CORRECTION") {
        postingKind = "RETURN_CORRECTION";
      } else if (movementKind === "PURCHASE_RECEIPT_CORRECTION") {
        postingKind = "PURCHASE_RECEIPT_CORRECTION";
      } else if (movementKind === "STOCKTAKE_CORRECTION") {
        postingKind = "STOCKTAKE_CORRECTION";
      } else if (movementKind === "TRANSFER_CORRECTION") {
        postingKind = "TRANSFER_CORRECTION";
      } else {
        // 預設 HR_ISSUE_CORRECTION 或一般更正
        postingKind = "HR_ISSUE_CORRECTION";
      }
    } else if (rawPostingKind === "WAREHOUSE_SHIPMENT") {
      postingKind = "WAREHOUSE_SHIPMENT";
    } else if (rawPostingKind === "REPLENISHMENT") {
      postingKind = "REPLENISHMENT";
    } else if (rawPostingKind === "RETURN") {
      postingKind = "RETURN";
    } else if (rawPostingKind === "RECEIPT") {
      postingKind = "RECEIPT";
    } else if (rawPostingKind === "STOCKTAKE") {
      postingKind = "STOCKTAKE";
    } else if (rawPostingKind === "ADJUSTMENT") {
      postingKind = "ADJUSTMENT";
    } else if (rawPostingKind === "OPENING") {
      postingKind = "OPENING";
    } else {
      continue;
    }

    const postingId = String(h.posting_id ?? "");
    const itemId = String(h.item_id ?? "");
    if (!postingId || !itemId) continue;

    const groupKey = `${postingId}_${itemId}`;
    const warehousePurpose = String(h.warehouse_purpose ?? "");
    const delta = Number(h.quantity_delta) || 0;

    let row = groupMap.get(groupKey);
    if (!row) {
      const avail = availabilityMap.get(itemId);
      const itemCode = String(h.item_code ?? "");
      const itemName = String(h.item_name ?? itemCode);
      const unit = String(h.unit ?? avail?.unit ?? "件");
      const size = avail?.size || (typeof h.size === "string" ? h.size : "—");
      const hrOnHand = avail?.hrOnHand ?? (warehousePurpose === "HR" ? (Number(h.current_on_hand_quantity) || 0) : 0);
      const generalOnHand = avail?.generalOnHand ?? (warehousePurpose === "GENERAL" ? (Number(h.current_on_hand_quantity) || 0) : 0);
      const sourceNo = String(h.source_no ?? "—");
      const occurredOn = String(h.occurred_on ?? "").slice(0, 10);
      const postedAt = String(h.posted_at ?? occurredOn);
      const postedByName = String(h.posted_by_name ?? "系統");

      row = {
        id: groupKey,
        postingId,
        postingKind,
        postingKindLabel: postingKindToLabel(postingKind),
        sourceNo,
        occurredOn,
        postedAt,
        postedByName,
        itemId,
        itemCode,
        itemName,
        size,
        unit,
        hrDelta: 0,
        generalDelta: 0,
        hrOnHand,
        generalOnHand,
      };
      groupMap.set(groupKey, row);
    }

    if (warehousePurpose === "HR") {
      row.hrDelta += delta;
    } else if (warehousePurpose === "GENERAL") {
      row.generalDelta += delta;
    }
  }

  return Array.from(groupMap.values()).sort((a, b) => {
    return (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0);
  });
}

/**
 * 依關鍵字、單據類型與日期區間過濾進出貨紀錄
 */
export function filterStockMovements(
  rows: StockMovementRow[],
  filter: StockMovementFilter,
): StockMovementRow[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const selectedKinds =
    filter.postingKinds && filter.postingKinds.length > 0
      ? new Set(filter.postingKinds)
      : null;
  const postingKind = filter.postingKind ?? "ALL";
  const startDate = filter.startDate?.trim() ?? "";
  const endDate = filter.endDate?.trim() ?? "";

  return rows.filter((row) => {
    if (selectedKinds) {
      if (!selectedKinds.has(row.postingKind)) {
        return false;
      }
    } else if (postingKind !== "ALL" && row.postingKind !== postingKind) {
      return false;
    }

    const rowDate = (row.occurredOn || row.postedAt.slice(0, 10)).replace(/\//g, "-");
    if (startDate && rowDate < startDate) return false;
    if (endDate && rowDate > endDate) return false;

    if (!query) return true;

    const searchable = [
      row.sourceNo,
      row.itemCode,
      row.itemName,
      row.size,
      row.postingKindLabel,
      row.occurredOn,
      row.postedByName,
    ]
      .join(" ")
      .toLowerCase();

    return searchable.includes(query);
  });
}

/**
 * 排序進出貨紀錄
 */
export function sortStockMovements(
  rows: StockMovementRow[],
  sortKey: StockMovementSortKey,
  direction: StockMovementSortDirection,
): StockMovementRow[] {
  const sorted = [...rows];
  const factor = direction === "asc" ? 1 : -1;

  sorted.sort((a, b) => {
    switch (sortKey) {
      case "posted_at":
        return ((Date.parse(a.postedAt) || 0) - (Date.parse(b.postedAt) || 0)) * factor;
      case "source_no":
        return a.sourceNo.localeCompare(b.sourceNo, "zh-TW") * factor;
      case "item_code":
        return a.itemCode.localeCompare(b.itemCode, "zh-TW") * factor;
      case "item_name":
        return a.itemName.localeCompare(b.itemName, "zh-TW") * factor;
      case "size":
        return a.size.localeCompare(b.size, "zh-TW") * factor;
      case "hr_delta":
        return (a.hrDelta - b.hrDelta) * factor;
      case "general_delta":
        return (a.generalDelta - b.generalDelta) * factor;
      case "hr_on_hand":
        return (a.hrOnHand - b.hrOnHand) * factor;
      case "general_on_hand":
        return (a.generalOnHand - b.generalOnHand) * factor;
      default:
        return 0;
    }
  });

  return sorted;
}
