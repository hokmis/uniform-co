import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/0116_correction_history_view.sql"), "utf8");
const adapter = readFileSync(resolve(process.cwd(), "src/lib/correction-history-read.ts"), "utf8");
const panels = [
  "HrIssueCorrectionPanel.tsx",
  "StocktakeCorrectionPanel.tsx",
  "WarehouseTransferCorrectionPanel.tsx",
  "PurchaseReceiptCorrectionPanel.tsx",
  "ReturnCorrectionPanel.tsx",
] as const;

describe("correction history read seam", () => {
  it("has one security-invoker view for every correction source kind", () => {
    expect(migration).toContain("create or replace view public.v_correction_history");
    expect(migration).toContain("with (security_invoker = true)");
    for (const sourceKind of ["PURCHASE_RECEIPT", "RETURN", "HR_ISSUE", "SHIPMENT", "REPLENISHMENT", "STOCKTAKE"]) {
      expect(migration).toContain(`'${sourceKind}'::text as source_kind`);
    }
    expect(migration).toContain("grant select on public.v_correction_history to authenticated");
  });

  it("keeps the old two-read path behind one rollout-compatible adapter", () => {
    expect(adapter).toContain('from("v_correction_history")');
    expect(adapter).toContain("shouldProbeReadModel");
    expect(adapter).toContain("shouldUseLegacyReadModel");
    for (const fileName of panels) {
      const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");
      expect(source, fileName).toContain("loadCorrectionHistory");
    }
  });

  it("does not silently choose the first correction source", () => {
    for (const fileName of panels) {
      const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");
      expect(source, fileName).not.toContain("loadedLines[0]");
      expect(source, fileName).not.toContain("loaded[0]");
      expect(source, fileName).not.toContain(":id`)) setLineId");
      expect(source, fileName).not.toContain(":id`)) setSourceId");
      expect(source, fileName).not.toContain(":id`)) setSourceKey");
    }
    expect(readFileSync(resolve(process.cwd(), "src/app/HrIssueCorrectionPanel.tsx"), "utf8")).toContain("setLineId((current) =>");
    expect(readFileSync(resolve(process.cwd(), "src/app/StocktakeCorrectionPanel.tsx"), "utf8")).toContain("setSourceId((current) =>");
    expect(readFileSync(resolve(process.cwd(), "src/app/WarehouseTransferCorrectionPanel.tsx"), "utf8")).toContain("setSourceKey((current) =>");
  });
});
