export type WorkflowStatusTone = "success" | "danger" | "neutral";

const labels: Record<string, string> = {
  AWAITING_UPLOAD: "等待檔案處理",
  UPLOADED: "檔案已上傳",
  PARSING: "資料解析中",
  VALIDATING: "資料檢查中",
  VALIDATED: "等待確認",
  APPLYING: "資料匯入中",
  APPLIED: "已匯入",
  PREPARING: "準備中",
  PROCESSING: "處理中",
  PENDING: "等待處理",
  QUEUED: "等待處理",
  DRAFT: "草稿",
  SUBMITTED: "待處理",
  INVENTORY_REVIEW_REQUIRED: "待庫存覆核",
  READY: "可下載",
  GENERATED: "已產生",
  POSTED: "已完成",
  SHIPPED: "已完成發放",
  COMPLETED: "已完成",
  SUCCEEDED: "已完成",
  OPEN: "開放中",
  CLOSED: "已關閉",
  CANCELLED: "已取消",
  FAILED: "需要處理",
  ERROR: "需要處理",
  RETRYABLE_FAILED: "需要重試",
  GENERATION_FAILED: "產生失敗",
  STALE_COUNT: "需要重新盤點",
};

const successStatuses = new Set([
  "APPLIED",
  "READY",
  "GENERATED",
  "POSTED",
  "SHIPPED",
  "COMPLETED",
  "SUCCEEDED",
  "OPEN",
]);

const dangerStatuses = new Set([
  "FAILED",
  "ERROR",
  "RETRYABLE_FAILED",
  "GENERATION_FAILED",
  "STALE_COUNT",
]);

/**
 * 將資料庫工作流狀態轉成前台可理解的短標籤。
 * 未知狀態刻意不回傳 raw code，避免把內部契約洩漏到操作介面。
 */
export function workflowStatusLabel(status: string | null | undefined, emptyLabel = "待建立"): string {
  const normalized = status?.trim().toUpperCase();
  if (!normalized) return emptyLabel;
  return labels[normalized] ?? "待處理";
}

export function workflowStatusTone(status: string | null | undefined): WorkflowStatusTone {
  const normalized = status?.trim().toUpperCase() ?? "";
  if (successStatuses.has(normalized)) return "success";
  if (dangerStatuses.has(normalized)) return "danger";
  return "neutral";
}

/** A new artifact revision may start only after its current revision is terminal. */
export function isArtifactTerminalStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toUpperCase();
  return normalized === "READY" || normalized === "FAILED";
}
