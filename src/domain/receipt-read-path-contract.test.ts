import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/app/PurchaseReceiptPanel.tsx"), "utf8");

describe("purchase receipt read path", () => {
  it("loads purchase-order lines only after one order is selected", () => {
    expect(source).toContain('select("id,po_no,supplier_code_snapshot,supplier_name_snapshot,status")');
    expect(source).toContain('.eq("purchase_order_id", orderId)');
    expect(source).not.toContain('.in("purchase_order_id", orderIds)');
    expect(source).toContain("retrySupabaseQueriesAfterSessionRefresh");
    expect(source).toContain("採購單明細");
    expect(source).toContain("const dataReadBlocked = !hasCurrentDataSnapshot;");
    expect(source).toContain("const visibleOrders = useMemo(() => hasCurrentDataSnapshot ? orders : [], [hasCurrentDataSnapshot, orders]);");
    expect(source).toContain("dataSnapshotAccountIdRef.current === accountId");
    expect(source).toContain("staleReadSnapshotMessage(\"採購單資料\")");
  });
});
