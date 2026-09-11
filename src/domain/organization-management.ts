export type OrganizationEntityType = "INSTITUTIONS" | "DEPARTMENTS";
export type OrganizationCatalogStatus = "ALL" | "ACTIVE" | "INACTIVE";
export type OrganizationCatalogSortKey = "type" | "institution" | "code" | "name";
export type OrganizationCatalogSortDirection = "asc" | "desc";

export type OrganizationCatalogEntry = {
  id: string;
  entityType: OrganizationEntityType;
  institutionCode: string;
  institutionName: string;
  code: string;
  name: string;
  isActive: boolean;
};

export type OrganizationCatalogFilter = {
  query: string;
  entityType: "ALL" | OrganizationEntityType;
  status: OrganizationCatalogStatus;
};

export type OrganizationEditorForm = {
  institutionCode: string;
  code: string;
  name: string;
  isActive: boolean;
};

export const emptyOrganizationEditorForm: OrganizationEditorForm = {
  institutionCode: "",
  code: "",
  name: "",
  isActive: true,
};

function clean(value: string): string {
  return value.trim();
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "zh-Hant", { numeric: true, sensitivity: "base" });
}

function unsafeText(value: string): boolean {
  return /^[=+@-]/.test(clean(value)) || /[\t\r\n]/.test(value);
}

export function organizationEditorKey(entityType: OrganizationEntityType, form: OrganizationEditorForm): string {
  const code = clean(form.code);
  return entityType === "INSTITUTIONS" ? code : `${clean(form.institutionCode)}:${code}`;
}

export function organizationEditorImportRow(
  entityType: OrganizationEntityType,
  form: OrganizationEditorForm,
): Record<string, string | boolean> {
  if (entityType === "INSTITUTIONS") {
    return { code: clean(form.code), name: clean(form.name), isActive: form.isActive };
  }
  return {
    institutionCode: clean(form.institutionCode),
    code: clean(form.code),
    name: clean(form.name),
    isActive: form.isActive,
  };
}

export function validateOrganizationEditor(
  entityType: OrganizationEntityType,
  form: OrganizationEditorForm,
): string | null {
  if (!clean(form.code) || !clean(form.name)) return "代碼與名稱為必填。";
  if (entityType === "DEPARTMENTS" && !clean(form.institutionCode)) return "部門必須選擇所屬機構。";
  if ([form.institutionCode, form.code, form.name].some(unsafeText)) return "文字不可使用公式前綴、Tab 或換行。";
  return null;
}

export function filterOrganizationCatalog(
  rows: readonly OrganizationCatalogEntry[],
  filter: OrganizationCatalogFilter,
): OrganizationCatalogEntry[] {
  const query = clean(filter.query).toLocaleLowerCase("zh-Hant");
  return rows.filter((row) => {
    if (filter.entityType !== "ALL" && row.entityType !== filter.entityType) return false;
    if (filter.status === "ACTIVE" && !row.isActive) return false;
    if (filter.status === "INACTIVE" && row.isActive) return false;
    if (!query) return true;
    return [row.institutionCode, row.institutionName, row.code, row.name]
      .join(" ")
      .toLocaleLowerCase("zh-Hant")
      .includes(query);
  });
}

export function sortOrganizationCatalog(
  rows: readonly OrganizationCatalogEntry[],
  key: OrganizationCatalogSortKey,
  direction: OrganizationCatalogSortDirection,
): OrganizationCatalogEntry[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = key === "type"
      ? left.entityType
      : key === "institution"
        ? `${left.institutionCode} ${left.institutionName}`
        : left[key];
    const rightValue = key === "type"
      ? right.entityType
      : key === "institution"
        ? `${right.institutionCode} ${right.institutionName}`
        : right[key];
    return compareText(leftValue, rightValue) * multiplier;
  });
}
