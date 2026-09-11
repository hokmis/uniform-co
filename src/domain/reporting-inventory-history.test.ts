import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../supabase/migrations/0065_inventory_history_source_number.sql", import.meta.url),
  "utf8",
);

describe("inventory history source number", () => {
  it("resolves source numbers without replacing the UUID source identity", () => {
    expect(migration).toContain("source_entity_id,");
    expect(migration).toContain("end as source_no");
    for (const kind of ["WAREHOUSE_SHIPMENT", "REPLENISHMENT", "RECEIPT", "STOCKTAKE", "RETURN", "OPENING", "CORRECTION"]) {
      expect(migration).toContain(`when '${kind}'`);
    }
  });
});
