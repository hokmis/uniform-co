import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("warehouse shipment POST SQL contract", () => {
  it("does not collide with the PL/pgSQL item_id_row variable", () => {
    const migration = fs.readFileSync(
      path.resolve("supabase/migrations/0095_warehouse_post_alias_fix.sql"),
      "utf8",
    );

    expect(migration).toContain(
      "create or replace function public.post_warehouse_shipment(",
    );
    expect(migration).toContain("unnest(item_ids) as requested_item(item_id)");
    expect(migration).not.toContain("unnest(item_ids) as item_id_row(item_id)");
  });
});
