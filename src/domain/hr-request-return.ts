export type PendingHrRequestReturn = { requestId: string; requestNo: string; version: number; reason: string; key: string };
export function parsePendingHrRequestReturn(value: unknown): PendingHrRequestReturn | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<PendingHrRequestReturn>;
  if (typeof row.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.requestId)
    || typeof row.requestNo !== "string" || row.requestNo.length > 100
    || !Number.isSafeInteger(row.version) || row.version! < 0
    || typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 2000
    || typeof row.key !== "string" || !row.key || row.key.length > 100) return null;
  return row as PendingHrRequestReturn;
}
export function hrReturnFailureMessage(error: { code?: string | null; message?: string | null } | null): string | null {
  const messages: Record<string, string> = {
    HR_RETURN_SOURCE_STALE: "來源已變更，未退回；請重新載入單據再核對。",
    HR_RETURN_NOT_PENDING: "單據已不在待發貨狀態，不能退回，請重新載入。",
    HR_RETURN_ALREADY_SHIPPED: "單據已完成發貨，不可退回修改。",
    HR_RETURN_INVALID_INPUT: "請填寫退回原因並核對來源單據。",
  };
  if (error?.code === "42501") return "目前帳號沒有退回此單據的權限。";
  return messages[error?.message ?? ""] ?? null;
}
