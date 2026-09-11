import { describe, expect, it } from "vitest";
import { durableImportMimeForFilename, durableImportMappingVersion, durableImportFingerprintPayload } from "./durable-import";

describe("durable import contract", () => {
  it("accepts only csv and xlsx by filename", () => {
    expect(durableImportMimeForFilename("employees.CSV")).toBe("text/csv");
    expect(durableImportMimeForFilename("employees.xlsx")).toContain("spreadsheetml");
    expect(durableImportMimeForFilename("employees.xls")).toBeNull();
  });

  it("builds the server fingerprint payload with bounded fields", () => {
    const payload = durableImportFingerprintPayload({
      importType: "EMPLOYEES",
      filename: "  employees.csv  ",
      mimeType: "text/csv",
      sizeBytes: 123,
      mappingVersion: durableImportMappingVersion.EMPLOYEES,
      ttlSeconds: 1800,
    });
    expect(payload).toEqual({
      import_type: "EMPLOYEES",
      filename: "employees.csv",
      mime: "text/csv",
      size: 123,
      mapping_version: "EMPLOYEES-v1",
      ttl_seconds: 1800,
    });
  });
});
