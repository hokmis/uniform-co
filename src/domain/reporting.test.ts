import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../supabase/migrations/0063_reporting_views.sql", import.meta.url),
  "utf8",
);

const requiredViews = [
  "v_item_availability",
  "v_hr_request_item_totals",
  "v_pending_warehouse_shipments",
  "v_inventory_history",
  "v_employee_distribution_history",
  "v_seasonal_demand_summary",
  "v_purchase_order_receipt_progress",
  "v_erp_export_candidates",
  "v_audit_event_history",
];

describe("reporting view migration", () => {
  it("publishes every documented report as a security-invoker read-only view", () => {
    for (const view of requiredViews) {
      expect(migration).toContain(`create or replace view public.${view}`);
      expect(migration).toContain(`public.${view}`);
    }
    expect(migration).toContain("with (security_invoker = true)");
    expect(migration).toContain("grant select on public.v_item_availability");
    expect(migration).toContain("to authenticated");
  });
});
