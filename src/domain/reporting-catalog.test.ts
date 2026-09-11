import { describe, expect, it } from "vitest";
import { filterReportRows, formatReportValue, getReportColumns, reportDefinitions, sortReportRows } from "./reporting-catalog";

describe("reporting catalog", () => {
  it("defines a Chinese label for every documented reporting-view column", () => {
    expect(reportDefinitions).toHaveLength(9);
    for (const report of reportDefinitions) {
      const columns = getReportColumns(report.name);
      expect(columns.map((column) => column.key)).toEqual(report.columns);
      for (const column of columns) {
        expect(column.label).not.toBe(column.key);
        expect(column.label).not.toContain("_");
        expect(column.label).not.toContain("其他資料欄位");
      }
    }
  });

  it("keeps configured order and appends newly observed database columns", () => {
    const columns = getReportColumns("v_item_availability", [{ item_code: "A1", future_metric: 3 }]);
    expect(columns.at(0)).toEqual({ key: "item_id", label: "品號識別碼" });
    expect(columns.at(-1)).toEqual({ key: "future_metric", label: "未設定中文欄位" });
    expect(getReportColumns("v_audit_event_history").find((column) => column.key === "request_id")?.label).toBe("請求追蹤識別碼");
  });

  it("formats common reporting values for Traditional Chinese display", () => {
    expect(formatReportValue("is_active", true)).toBe("啟用");
    expect(formatReportValue("warehouse_purpose", "GENERAL")).toBe("總倉");
    expect(formatReportValue("status", "POSTED")).toBe("已過帳");
    expect(formatReportValue("occurred_on", "2026-08-30")).toBe("2026/08/30");
    expect(formatReportValue("quantity", 1234)).toBe("1,234");
    expect(formatReportValue("after_data", { status: "POSTED" })).toBe('{"status":"POSTED"}');
  });

  it("filters formatted values and sorts numbers without mutating source rows", () => {
    const rows = [{ item_code: "A10", quantity: 10, warehouse_purpose: "HR" }, { item_code: "A2", quantity: 2, warehouse_purpose: "GENERAL" }];
    expect(filterReportRows(rows, "總倉")).toEqual([rows[1]]);
    expect(sortReportRows(rows, "quantity", "asc")).toEqual([rows[1], rows[0]]);
    expect(rows[0].item_code).toBe("A10");
  });
});
