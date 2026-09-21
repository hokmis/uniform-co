import { describe, expect, it } from "vitest";
import {
  emptyOrganizationEditorForm,
  filterOrganizationCatalog,
  organizationEditorImportRow,
  organizationEditorKey,
  sortOrganizationCatalog,
  type OrganizationCatalogEntry,
  type OrganizationInstitutionOption,
  validateOrganizationEditor,
} from "./organization-management";

const rows: OrganizationCatalogEntry[] = [
  { id: "i-2", entityType: "INSTITUTIONS", institutionCode: "B10", institutionName: "乙機構", code: "B10", name: "乙機構", isActive: false },
  { id: "d-2", entityType: "DEPARTMENTS", institutionCode: "A2", institutionName: "甲機構", code: "D10", name: "照護部", isActive: true },
  { id: "d-1", entityType: "DEPARTMENTS", institutionCode: "A2", institutionName: "甲機構", code: "D2", name: "行政部", isActive: true },
];

describe("organization management interface", () => {
  const institutionA2: OrganizationInstitutionOption = { id: "institution-a2", code: " A2 ", isActive: true };

  it("builds stable institution and department keys", () => {
    expect(organizationEditorKey("INSTITUTIONS", { ...emptyOrganizationEditorForm, code: " A2 " })).toBe("A2");
    expect(organizationEditorKey("DEPARTMENTS", { ...emptyOrganizationEditorForm, institutionCode: " A2 ", code: " D1 " })).toBe("A2:D1");
    expect(organizationEditorKey("DEPARTMENTS", { ...emptyOrganizationEditorForm, code: " D1 " })).toBe("D1");
  });

  it("maps one editor form to the existing master import contract", () => {
    expect(organizationEditorImportRow("DEPARTMENTS", {
      institutionCode: " A2 ", code: " D1 ", name: " 行政部 ", isActive: false,
    }, institutionA2)).toEqual({
      institutionId: "institution-a2",
      institutionCode: "A2",
      code: "D1",
      name: "行政部",
      isActive: false,
    });
  });

  it("validates required and unsafe fields before calling the server", () => {
    expect(validateOrganizationEditor("INSTITUTIONS", emptyOrganizationEditorForm)).toBe("代碼與名稱為必填。");
    expect(validateOrganizationEditor("DEPARTMENTS", { ...emptyOrganizationEditorForm, code: "D1", name: "行政" })).toBeNull();
    expect(validateOrganizationEditor("INSTITUTIONS", { ...emptyOrganizationEditorForm, code: "=A1", name: "測試" })).toContain("公式");
  });

  it("filters by type, status and parent institution text", () => {
    expect(filterOrganizationCatalog(rows, { query: "甲機構", entityType: "DEPARTMENTS", status: "ACTIVE" }).map((row) => row.id)).toEqual(["d-2", "d-1"]);
    expect(filterOrganizationCatalog(rows, { query: "", entityType: "ALL", status: "INACTIVE" }).map((row) => row.id)).toEqual(["i-2"]);
  });

  it("sorts codes using natural numeric order", () => {
    expect(sortOrganizationCatalog(rows.filter((row) => row.entityType === "DEPARTMENTS"), "code", "asc").map((row) => row.code)).toEqual(["D2", "D10"]);
  });
});
