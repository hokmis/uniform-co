import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canCancelHrRequest } from "./hr-request-cancellation";

describe("HR request cancellation eligibility", () => {
  it.each(["DRAFT", "SUBMITTED", "INVENTORY_REVIEW_REQUIRED"])("allows HR to cancel %s", (status) => {
    expect(canCancelHrRequest(status, ["HR"])).toBe(true);
  });
  it.each(["SHIPPED", "CANCELLED", "UNKNOWN"])("does not offer cancellation for %s", (status) => {
    expect(canCancelHrRequest(status, ["HR"])).toBe(false);
  });
  it("does not expose the mutation to warehouse-only users", () => {
    expect(canCancelHrRequest("SUBMITTED", ["WAREHOUSE"])).toBe(false);
    expect(canCancelHrRequest("SUBMITTED", ["SYSTEM_ADMIN"])).toBe(true);
  });
  it("routes history cancellation through the existing idempotent RPC and refresh event", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/HrRequestHistoryPanel.tsx"), "utf8");
    expect(source).toContain('client.rpc("cancel_hr_request"');
    expect(source).toContain('const operationId = `${actorAccountId}:${requestId}`;');
    expect(source).toContain('const reason = previous?.reason ?? cancelReason.trim();');
    expect(source).toContain('p_idempotency_key: operation.key');
    expect(source).toContain('data?.id !== requestId || data?.status !== "CANCELLED"');
    expect(source).toContain('window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent))');
    expect(source).toContain('cancelFlightRef.current');
    expect(source).not.toContain('.delete()');
  });
});
