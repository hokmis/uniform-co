import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), "utf8");
}

describe("warehouse replenishment wiring", () => {
  it("loads submitted replenishment requests into the warehouse queue", () => {
    const panel = read("src/app/WarehouseShipmentPanel.tsx");
    const queueAdapter = read("src/lib/warehouse-shipment-queue-read.ts");
    const queueView = read("supabase/migrations/0103_warehouse_shipment_queue_view.sql");

    expect(panel).toContain("loadWarehouseShipmentQueue(supabase)");
    expect(queueAdapter).toContain('client.from("replenishment_requests")');
    expect(queueAdapter).toContain('row.source !== "HR_REQUEST" && row.source !== "REPLENISHMENT"');
    expect(queueView).toContain("replenishment_row.status = 'SUBMITTED'");
  });

  it("refreshes the warehouse queue after replenishment submit or cancel", () => {
    const panel = read("src/app/ReplenishmentPanel.tsx");

    expect(panel).toContain('hrRequestWorkflowChangedEvent');
    expect(panel.match(/window\.dispatchEvent\(new Event\(hrRequestWorkflowChangedEvent\)\)/g)?.length).toBe(2);
  });

  it("lets the requester start another replenishment without leaving the panel", () => {
    const panel = read("src/app/ReplenishmentPanel.tsx");

    expect(panel).toContain("function startNextRequest()");
    expect(panel).toContain("建立下一筆補庫單");
  });

  it("does not expose preview items while formal item options are loading", () => {
    const panel = read("src/app/ReplenishmentPanel.tsx");

    expect(panel).toContain("useState<ItemOption[]>(previewMode ? previewItems : [])");
    expect(panel).toContain("const [dataLoading, setDataLoading] = useState(false);");
    expect(panel).toContain("setItems([]);");
    expect(panel).toContain("aria-busy={dataLoading || busy}");
    expect(panel).toContain("disabled={busy || !canEditReplenishmentEntry(entryState) || itemsReadBlocked}");
  });

  it("keeps replenishment cancellation idempotent across unknown-result retries", () => {
    const panel = read("src/app/ReplenishmentPanel.tsx");

    expect(panel).toContain("cancelKey?: string");
    expect(panel).toContain("const cancelKey = operation.cancelKey ?? crypto.randomUUID();");
    expect(panel).toContain("p_idempotency_key: `CANCEL-REPLENISHMENT-${cancelKey}`");
    expect(panel).not.toContain("p_idempotency_key: `CANCEL-REPLENISHMENT-${crypto.randomUUID()}`");
    expect(panel).toContain("function changeCancelReason(nextReason: string)");
  });

  it("does not lock a warm replenishment form during a background item refresh", () => {
    const panel = read("src/app/ReplenishmentPanel.tsx");

    expect(panel).toContain("if (itemsReadBlocked || lines.length >= visibleItems.length) return;");
    expect(panel).toContain("disabled={busy || itemsReadBlocked || !canEditReplenishmentEntry(entryState) || lines.length >= visibleItems.length}");
    expect(panel).toContain("disabled={busy || !canEditReplenishmentEntry(entryState) || itemsReadBlocked}");
    expect(panel).toContain("disabled={busy || submitted || cancellationUnresolved || (!submissionUnresolved && itemsReadBlocked) || !identityReady}");
    expect(panel).not.toContain("disabled={busy || dataLoading || submitted || !dataReady}");
  });

  it("posts replenishment transfer quantities through a protected RPC", () => {
    const panel = read("src/app/WarehouseShipmentPanel.tsx");

    expect(panel).toContain('rpc("post_replenishment_request_with_lines"');
    expect(panel).toContain("p_transfer_lines");
  });

  it("provides a server-side replenishment post RPC without browser table mutation", () => {
    const migration = read("supabase/migrations/0096_replenishment_post_ui.sql");

    expect(migration).toContain("create or replace function public.post_replenishment_request_with_lines(");
    expect(migration).toContain("p_transfer_lines jsonb");
    expect(migration).toContain("create or replace function private.prevent_posted_replenishment_mutation()");
    expect(migration).toContain("set_config('private.replenishment_post_context', 'on', true)");
    expect(migration).toContain("create or replace function public.post_replenishment_request(");
    expect(migration).toContain("return public.post_replenishment_request_with_lines(");
    expect(migration).toContain("grant execute on function public.post_replenishment_request_with_lines");
  });

  it("keeps replenishment POST item locks ahead of the request lock", () => {
    const migration = read("supabase/migrations/0097_replenishment_post_lock_order.sql");

    expect(migration).toContain("alter function public.post_replenishment_request_with_lines(uuid, jsonb, text, text)");
    const itemLock = migration.indexOf("insert into public.inventory_item_locks");
    const delegate = migration.indexOf("return private.post_replenishment_request_with_lines(");
    expect(itemLock).toBeGreaterThanOrEqual(0);
    expect(delegate).toBeGreaterThan(itemLock);
    expect(migration).toContain("not private.has_role('WAREHOUSE')");
  });
});
