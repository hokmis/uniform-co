export type ReportRow = Record<string, unknown>;
export type ReportSortDirection = "asc" | "desc";

type ReportDefinition = Readonly<{
  name: string;
  label: string;
  description: string;
  columns: readonly string[];
}>;

export const reportDefinitions = [
  { name: "v_item_availability", label: "品號可用量", description: "比較人資倉、總倉、合計庫存、有效預留與目前可申請量。", columns: ["item_id", "item_code", "item_name", "unit", "size", "category", "season", "is_active", "hr_on_hand_quantity", "general_on_hand_quantity", "combined_on_hand_quantity", "active_reserved_quantity", "available_to_request_quantity"] },
  { name: "v_hr_request_item_totals", label: "人資需求品號合計", description: "按需求單與品號檢視發放量、增庫量、調撥量及員工明細合計。", columns: ["request_id", "request_no", "status", "distribution_date", "created_at", "item_id", "item_code", "item_name", "unit", "issue_quantity", "increase_quantity", "requested_transfer_quantity", "issue_line_quantity", "issue_line_count"] },
  { name: "v_pending_warehouse_shipments", label: "待處理發貨差異", description: "列出發貨草稿、可調撥上限、實際調撥量及仍需倉庫處理的差異。", columns: ["shipment_id", "shipment_no", "shipment_status", "created_by", "shipment_note", "request_id", "request_no", "distribution_date", "shipment_line_id", "hr_request_item_id", "item_id", "requested_transfer_quantity_snapshot", "general_on_hand_snapshot", "maximum_transfer_quantity_snapshot", "actual_transfer_quantity", "transfer_difference_quantity", "short_ship_reason_code", "is_line_ready", "needs_warehouse_attention"] },
  { name: "v_inventory_history", label: "庫存流水", description: "依倉庫、品號與過帳時間顯示不可變庫存流水及每筆異動後庫存。", columns: ["ledger_entry_id", "posting_id", "line_no", "warehouse_id", "warehouse_code", "warehouse_name", "warehouse_purpose", "item_id", "item_code", "item_name", "unit", "posting_kind", "movement_kind", "quantity_delta", "occurred_on", "source_entity_id", "source_no", "idempotency_key", "posted_by", "posted_by_name", "posted_at", "on_hand_after_entry", "current_on_hand_quantity"] },
  { name: "v_employee_distribution_history", label: "員工發放／更正／退回", description: "按員工與品號追蹤發放、更正及退回造成的有效數量變化。", columns: ["employee_id", "employee_no", "employee_name", "item_id", "item_code", "item_name", "size", "unit", "source_id", "source_no", "occurred_on", "event_kind", "quantity_delta", "source_line_id"] },
  { name: "v_seasonal_demand_summary", label: "換季需求彙總", description: "按活動、組織與品號彙總參與員工、需求數量及需求明細筆數。", columns: ["campaign_id", "campaign_no", "campaign_name", "season", "campaign_status", "window_start", "window_end", "institution_id", "department_id", "item_id", "item_code", "item_name", "unit", "employee_count", "demand_quantity", "demand_line_count"] },
  { name: "v_purchase_order_receipt_progress", label: "採購入庫進度", description: "比較訂購、到貨、驗收、拒收與尚待驗收數量，包含短結案差額。", columns: ["purchase_order_id", "po_no", "purchase_order_status", "supplier_id", "supplier_name_snapshot", "purchase_order_line_id", "line_no", "seasonal_procurement_line_id", "item_id", "item_code", "item_name", "size", "unit", "ordered_quantity", "current_purchase_limit", "allocated_quantity", "purchase_order_count", "delivered_to_date", "accepted_to_date", "rejected_to_date", "remaining_to_accept", "closed_short_quantity", "line_fully_accepted"] },
  { name: "v_erp_export_candidates", label: "ERP 發放候選", description: "列出已發貨且尚未被 ERP 邏輯批次鎖定的員工發放明細。", columns: ["issue_line_id", "request_id", "request_no", "distribution_date", "employee_id", "employee_no", "employee_name", "institution_id", "institution_code", "institution_name", "department_id", "department_code", "department_name", "item_id", "item_code", "item_name", "size", "unit", "quantity"] },
  { name: "v_audit_event_history", label: "稽核事件", description: "檢視目前角色可讀取的業務異動事件、前後資料與關聯追蹤碼。", columns: ["id", "occurred_at", "actor_account_id", "action", "entity_table", "entity_id", "before_data", "after_data", "reason", "request_id", "correlation_id", "client_metadata"] },
] as const satisfies readonly ReportDefinition[];

export type ReportName = (typeof reportDefinitions)[number]["name"];
export type ReportColumn = Readonly<{ key: string; label: string }>;

const columnLabels: Readonly<Record<string, string>> = {
  id: "事件識別碼", item_id: "品號識別碼", item_code: "品號", item_name: "品名", unit: "單位", size: "尺寸", category: "分類", season: "季別", is_active: "啟用狀態",
  hr_on_hand_quantity: "人資倉現有量", general_on_hand_quantity: "總倉現有量", combined_on_hand_quantity: "兩倉合計現有量", active_reserved_quantity: "有效預留量", available_to_request_quantity: "可申請量",
  request_id: "需求單識別碼", request_no: "需求單號", status: "需求狀態", distribution_date: "預定發放日期", created_at: "建立時間", issue_quantity: "發放數量", increase_quantity: "增庫數量", requested_transfer_quantity: "申請調撥數量", issue_line_quantity: "員工明細數量合計", issue_line_count: "員工明細筆數",
  shipment_id: "發貨單識別碼", shipment_no: "發貨單號", shipment_status: "發貨狀態", created_by: "建立人識別碼", shipment_note: "發貨備註", shipment_line_id: "發貨明細識別碼", hr_request_item_id: "需求品項識別碼", requested_transfer_quantity_snapshot: "申請調撥量快照", general_on_hand_snapshot: "總倉現有量快照", maximum_transfer_quantity_snapshot: "最高可調撥量快照", actual_transfer_quantity: "實際調撥數量", transfer_difference_quantity: "調撥差異數量", short_ship_reason_code: "短撥原因碼", is_line_ready: "明細完成狀態", needs_warehouse_attention: "是否需要倉庫處理",
  ledger_entry_id: "庫存流水識別碼", posting_id: "過帳識別碼", line_no: "明細序號", warehouse_id: "倉庫識別碼", warehouse_code: "倉庫代碼", warehouse_name: "倉庫名稱", warehouse_purpose: "倉庫用途", posting_kind: "過帳類型", movement_kind: "庫存異動類型", quantity_delta: "數量增減", occurred_on: "發生日期", source_entity_id: "來源單據識別碼", source_no: "來源單號", idempotency_key: "冪等識別鍵", posted_by: "過帳人識別碼", posted_by_name: "過帳人", posted_at: "過帳時間", on_hand_after_entry: "本筆異動後庫存", current_on_hand_quantity: "目前現有量",
  employee_id: "員工識別碼", employee_no: "員工編號", employee_name: "員工姓名", source_id: "來源單據識別碼", event_kind: "事件類型", source_line_id: "來源明細識別碼",
  campaign_id: "換季活動識別碼", campaign_no: "換季活動編號", campaign_name: "換季活動名稱", campaign_status: "換季活動狀態", window_start: "登記開始時間", window_end: "登記截止時間", institution_id: "機構識別碼", institution_code: "機構代碼", institution_name: "機構名稱", department_id: "部門識別碼", department_code: "部門代碼", department_name: "部門名稱", employee_count: "員工人數", demand_quantity: "需求數量", demand_line_count: "需求明細筆數",
  purchase_order_id: "採購單識別碼", po_no: "採購單號", purchase_order_status: "採購單狀態", supplier_id: "供應商識別碼", supplier_name_snapshot: "供應商名稱快照", purchase_order_line_id: "採購明細識別碼", seasonal_procurement_line_id: "換季採購明細識別碼", ordered_quantity: "訂購數量", current_purchase_limit: "目前採購上限", allocated_quantity: "已配置數量", purchase_order_count: "採購單數量", delivered_to_date: "累計到貨數量", accepted_to_date: "累計驗收合格數量", rejected_to_date: "累計拒收數量", remaining_to_accept: "尚待驗收數量", closed_short_quantity: "短結案數量", line_fully_accepted: "明細是否全數驗收",
  issue_line_id: "發放明細識別碼", quantity: "數量", occurred_at: "事件發生時間", actor_account_id: "操作帳號識別碼", action: "操作動作", entity_table: "資料表名稱", entity_id: "資料識別碼", before_data: "異動前資料", after_data: "異動後資料", reason: "操作理由", correlation_id: "關聯追蹤碼", client_metadata: "用戶端摘要資料",
};

const valueLabels: Readonly<Record<string, string>> = {
  HR: "人資倉", GENERAL: "總倉", DRAFT: "草稿", SUBMITTED: "已送出", APPROVED: "已核准", REJECTED: "已退回", SHIPPED: "已發貨", POSTED: "已過帳", CANCELLED: "已取消", CLOSED_SHORT: "短結案", ORDERED: "已下單", REOPENED: "重新開啟", OPEN: "開放中", CLOSED: "已關閉",
  HR_ISSUE: "人資發放", HR_ISSUE_CORRECTION: "發放更正", RETURN: "員工退回", RETURN_CORRECTION: "退回更正", WAREHOUSE_SHIPMENT: "倉庫發貨", REPLENISHMENT: "額外補庫", RECEIPT: "採購入庫", STOCKTAKE: "庫存盤點", OPENING: "期初庫存", CORRECTION: "庫存更正",
};

const contextualColumnLabels: Readonly<Record<string, string>> = {
  "v_audit_event_history.request_id": "請求追蹤識別碼",
};

export function getReportDefinition(name: ReportName) {
  return reportDefinitions.find((definition) => definition.name === name) ?? reportDefinitions[0];
}

export function getReportColumns(name: ReportName, rows: readonly ReportRow[] = []): ReportColumn[] {
  const definition = getReportDefinition(name);
  const known = new Set<string>(definition.columns);
  const extra = new Set<string>();
  rows.forEach((row) => Object.keys(row).forEach((key) => { if (!known.has(key)) extra.add(key); }));
  return [...definition.columns, ...extra].map((key) => ({
    key,
    label: contextualColumnLabels[`${name}.${key}`] ?? columnLabels[key] ?? "未設定中文欄位",
  }));
}

export function formatReportValue(column: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (column === "is_active" && typeof value === "boolean") return value ? "啟用" : "停用";
  if (["is_line_ready", "needs_warehouse_attention", "line_fully_accepted"].includes(column) && typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return value.toLocaleString("zh-TW");
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  if (valueLabels[text]) return valueLabels[text];
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-TW", { hour12: false });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replaceAll("-", "/");
  return text;
}

export function filterReportRows(rows: readonly ReportRow[], query: string): ReportRow[] {
  const normalized = query.trim().toLocaleLowerCase("zh-Hant");
  if (!normalized) return [...rows];
  return rows.filter((row) => Object.entries(row).some(([column, value]) => formatReportValue(column, value).toLocaleLowerCase("zh-Hant").includes(normalized)));
}

function comparable(value: unknown): string | number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return String(value ?? "").toLocaleLowerCase("zh-Hant");
}

export function sortReportRows(rows: readonly ReportRow[], column: string | null, direction: ReportSortDirection): ReportRow[] {
  if (!column) return [...rows];
  const multiplier = direction === "asc" ? 1 : -1;
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const leftValue = comparable(left.row[column]);
    const rightValue = comparable(right.row[column]);
    const result = typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), "zh-Hant", { numeric: true, sensitivity: "base" });
    return result ? result * multiplier : left.index - right.index;
  }).map(({ row }) => row);
}
