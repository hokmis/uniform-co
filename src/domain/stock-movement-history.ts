export type StockMovementPostingKind = "WAREHOUSE_SHIPMENT" | "REPLENISHMENT" | "HR_REQUEST_RESERVATION";

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
  startDate?: string;
  endDate?: string;
};

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
  if (kind === "WAREHOUSE_SHIPMENT") return "員工需求發貨";
  if (kind === "REPLENISHMENT") return "額外補庫調撥";
  if (kind === "HR_REQUEST_RESERVATION") return "需求預留(待發貨)";
  return kind;
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

  // 2. 處理不可變發貨與補庫流水
  for (const h of historyRows) {
    const postingKind = String(h.posting_kind ?? "");
    // 僅處理「員工制服需求發貨」與「額外補庫」
    if (postingKind !== "WAREHOUSE_SHIPMENT" && postingKind !== "REPLENISHMENT") {
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
        postingKind: postingKind as StockMovementPostingKind,
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
  const postingKind = filter.postingKind ?? "ALL";
  const startDate = filter.startDate?.trim() ?? "";
  const endDate = filter.endDate?.trim() ?? "";

  return rows.filter((row) => {
    if (postingKind !== "ALL" && row.postingKind !== postingKind) {
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
