export function canCancelHrRequest(status: string, roles: readonly string[]): boolean {
  return (roles.includes("HR") || roles.includes("SYSTEM_ADMIN"))
    && (status === "DRAFT" || status === "SUBMITTED" || status === "INVENTORY_REVIEW_REQUIRED");
}
