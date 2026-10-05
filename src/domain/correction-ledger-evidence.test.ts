import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyCorrectionLedgerEvidence } from "./correction-ledger-evidence";

const transferRows = [
  { ledger_entry_id: "entry-out", posting_id: "posting-1", item_id: "item-1", warehouse_id: "warehouse-general", posting_kind: "CORRECTION", movement_kind: "WAREHOUSE_TRANSFER_CORRECTION_OUT", quantity_delta: -3 },
  { ledger_entry_id: "entry-in", posting_id: "posting-1", item_id: "item-1", warehouse_id: "warehouse-hr", posting_kind: "CORRECTION", movement_kind: "WAREHOUSE_TRANSFER_CORRECTION_IN", quantity_delta: 3 },
];

describe("correction ledger evidence", () => {
  it("confirms a balanced two-warehouse transfer correction even though total stock is unchanged", () => {
    expect(verifyCorrectionLedgerEvidence("WAREHOUSE_TRANSFER", transferRows)).toBe("verified");
  });

  it("does not confirm a posted transfer correction when either warehouse movement is missing", () => {
    expect(verifyCorrectionLedgerEvidence("WAREHOUSE_TRANSFER", transferRows.slice(0, 1))).toBe("missing");
  });

  it("flags malformed or unbalanced transfer evidence", () => {
    expect(verifyCorrectionLedgerEvidence("WAREHOUSE_TRANSFER", [
      transferRows[0], { ...transferRows[1], quantity_delta: 2 },
    ])).toBe("mismatch");
  });

  it("confirms one non-zero stocktake correction movement", () => {
    const ledgerRows = [{ ...transferRows[0], movement_kind: "STOCKTAKE_CORRECTION", quantity_delta: -2 }];
    expect(verifyCorrectionLedgerEvidence("STOCKTAKE", ledgerRows)).toBe("verified");
  });

  it("does not confirm a stocktake correction without exactly one non-zero ledger movement", () => {
    expect(verifyCorrectionLedgerEvidence("STOCKTAKE", [])).toBe("missing");
    expect(verifyCorrectionLedgerEvidence("STOCKTAKE", [
      { ...transferRows[0], movement_kind: "STOCKTAKE_CORRECTION", quantity_delta: 0 },
    ])).toBe("mismatch");
  });

  it.each([
    ["WarehouseTransferCorrectionPanel.tsx", "WAREHOUSE_TRANSFER"],
    ["StocktakeCorrectionPanel.tsx", "STOCKTAKE"],
  ])("requires inventory ledger read-back before success in %s", (fileName, kind) => {
    const source = readFileSync(resolve(process.cwd(), "src", "app", fileName), "utf8");
    expect(source).toContain("readCorrectionInventoryEvidence");
    expect(source).toContain(`\"${kind}\"`);
    expect(source).toContain("庫存異動紀錄尚未核對");
    expect(source).toContain("重新核對異動紀錄");
    expect(source).toContain("inventoryEvidenceWarning");
    expect(source).toContain('type: "correction-id", value: data.id as string');
    expect(source).toContain('type: "correction-id", value: correction.id');
  });

  it("reads only protected base tables so verification does not depend on reporting-view rollout", () => {
    const adapter = readFileSync(resolve(process.cwd(), "src", "lib", "correction-ledger-evidence-read.ts"), "utf8");
    expect(adapter).toContain('from("inventory_postings")');
    expect(adapter).toContain('from("inventory_ledger_entries")');
    expect(adapter).toContain("verifyCorrectionLedgerEvidence");
    expect(adapter).not.toContain('from("v_inventory_history")');
    expect(adapter).toContain("retrySupabaseQueriesAfterSessionRefresh");
  });
});
