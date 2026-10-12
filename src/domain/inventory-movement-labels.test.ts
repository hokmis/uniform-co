import { describe, expect, it } from "vitest";
import { formatReportValue } from "./reporting-catalog";

describe("inventory movement labels", () => {
  it.each([
    ["MANUAL_ADJUSTMENT", "庫存調整"],
    ["STOCKTAKE_ADJUSTMENT", "盤點調整"],
    ["STOCKTAKE_CORRECTION", "盤點更正"],
    ["REPLENISHMENT_OUT", "補庫調出"],
    ["REPLENISHMENT_IN", "補庫調入"],
    ["WAREHOUSE_TRANSFER_CORRECTION_OUT", "調庫更正（總倉）"],
    ["WAREHOUSE_TRANSFER_CORRECTION_IN", "調庫更正（人資倉）"],
    ["WAREHOUSE_SHIPMENT_OUT", "發貨調出"],
    ["HR_ISSUE_AND_REPLENISH", "人資發放與補庫淨異動"],
    ["RETURN_IN", "退回入庫"],
    ["OPENING_BALANCE", "期初庫存"],
    ["RECEIPT_IN", "採購入庫"],
    ["RECEIPT_CORRECTION", "入庫更正"],
  ])("renders %s in Chinese", (code, label) => {
    expect(formatReportValue("movement_kind", code)).toBe(label);
    expect(formatReportValue("item_code", code)).toBe(code);
  });
});
