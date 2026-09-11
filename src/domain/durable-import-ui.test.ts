import { describe, expect, it } from "vitest";
import { canChangeDurableImportType, formatDurableImportDate, formatDurableImportCount } from "./durable-import-ui";

describe("durable import UI recovery", () => {
  it("locks import type only while a batch is still active", () => {
    expect(canChangeDurableImportType(false, null)).toBe(true);
    expect(canChangeDurableImportType(false, "CANCELLED")).toBe(true);
    expect(canChangeDurableImportType(false, "FAILED")).toBe(true);
    expect(canChangeDurableImportType(false, "AWAITING_UPLOAD")).toBe(false);
    expect(canChangeDurableImportType(true, "CANCELLED")).toBe(false);
  });

  it("does not render missing batch fields as epoch time or blank counts", () => {
    expect(formatDurableImportDate(undefined)).toBe("時間未取得");
    expect(formatDurableImportDate(0)).toBe("時間未取得");
    expect(formatDurableImportCount(undefined)).toBe("—");
    expect(formatDurableImportCount(0)).toBe("0");
  });
});
