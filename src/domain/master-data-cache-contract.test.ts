import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cacheSource = readFileSync(resolve(process.cwd(), "src/lib/master-data-cache.ts"), "utf8");
const catalogSources = [
  "src/app/ProductCatalogPanel.tsx",
  "src/app/ProductMasterEditorPanel.tsx",
  "src/app/OrganizationCatalogPanel.tsx",
  "src/app/OrganizationMasterEditorPanel.tsx",
  "src/app/EmployeeCatalogPanel.tsx",
  "src/app/EmployeeMasterEditorPanel.tsx",
  "src/app/EmployeeImportPanel.tsx",
  "src/app/AccountAdminPanel.tsx",
  "src/app/SeasonalCampaignPanel.tsx",
  "src/app/ReplenishmentPanel.tsx",
  "src/app/StocktakePanel.tsx",
  "src/app/ErpExportPanel.tsx",
].map((file) => readFileSync(resolve(process.cwd(), file), "utf8"));
const employeeDirectorySources = [
  "src/app/EmployeeCatalogPanel.tsx",
  "src/app/EmployeeImportPanel.tsx",
].map((file) => readFileSync(resolve(process.cwd(), file), "utf8"));
const employeeDirectoryReadSource = readFileSync(resolve(process.cwd(), "src/lib/employee-directory-read.ts"), "utf8");

describe("master data read seam", () => {
  it("retries stable catalog reads through the shared session adapter", () => {
    for (const functionName of ["loadOrganizationMasterData", "loadProductMasterData", "loadEmployeeMasterData"]) {
      const start = cacheSource.indexOf(`export function ${functionName}`);
      const next = cacheSource.indexOf("export function ", start + 1);
      expect(start, functionName).toBeGreaterThanOrEqual(0);
      expect(cacheSource.slice(start, next < 0 ? undefined : next), functionName)
        .toContain("retrySupabaseQueriesAfterSessionRefresh");
    }
  });

  it("deduplicates concurrent reads, expires them quickly, and exposes explicit invalidation", () => {
    expect(cacheSource).toContain("WeakMap<SupabaseClient");
    expect(cacheSource).toContain("CACHE_TTL_MS = 30_000");
    expect(cacheSource).toContain("function freshCached<T>");
    expect(cacheSource).toContain("errorsForResources");
    expect(cacheSource).toContain("INVALIDATION_KEYS");
    expect(cacheSource).toContain('product: ["product", "procurement", "active-items", "hr-request"]');
    expect(cacheSource).toContain('organization: ["organization", "active-institutions", "hr-request"]');
    expect(cacheSource).toContain("cache.delete(key)");
    expect(cacheSource).toContain("cache.get(key)?.promise !== promise");
    expect(cacheSource).toContain("invalidateMasterDataCache");
    expect(employeeDirectoryReadSource).toContain("WeakMap<SupabaseClient");
    expect(employeeDirectoryReadSource).toContain("EMPLOYEE_DIRECTORY_CACHE_TTL_MS = 30_000");
    expect(employeeDirectoryReadSource).toContain("invalidateEmployeeDirectory");
    expect(readFileSync(resolve(process.cwd(), "src/app/EmployeeMasterEditorPanel.tsx"), "utf8")).toContain("invalidateEmployeeDirectory");
    expect(readFileSync(resolve(process.cwd(), "src/app/OrganizationMasterEditorPanel.tsx"), "utf8")).toContain("invalidateEmployeeDirectory");
    expect(readFileSync(resolve(process.cwd(), "src/app/MasterDataPanel.tsx"), "utf8")).toContain("invalidateEmployeeDirectory");
  });

  it("keeps organization and product source queries in one adapter", () => {
    expect(cacheSource).toContain('client.from("institutions")');
    expect(cacheSource).toContain('client.from("departments")');
    expect(cacheSource).toContain('client.from("uniform_items")');
    expect(cacheSource).toContain('client.from("supplier_uniform_items")');
    expect(cacheSource).toContain('.from("employees")');
    expect(cacheSource).toContain("loadEmployeeMasterData");
    for (const source of catalogSources.filter((source) => !employeeDirectorySources.includes(source))) {
      expect(source).toContain("master-data-cache");
    }
    for (const source of employeeDirectorySources) expect(source).toContain("employee-directory-read");
    expect(readFileSync(resolve(process.cwd(), "src/app/MasterDataPanel.tsx"), "utf8")).toContain("invalidateMasterDataCache");
  });

  it("gives the HR request form one short-lived server-shaped option read seam", () => {
    expect(cacheSource).toContain('from("v_hr_request_employee_options")');
    expect(cacheSource).toContain('from("v_hr_request_item_options")');
    expect(cacheSource).toContain("loadHrRequestMasterData");
    expect(cacheSource).toContain("retrySupabaseQueriesAfterSessionRefresh");
    const workbenchSource = readFileSync(resolve(process.cwd(), "src/app/HrRequestWorkbench.tsx"), "utf8");
    expect(workbenchSource).toContain("loadHrRequestMasterData");
    expect(workbenchSource).toContain("buildActiveHrEmployeeOptions");
    expect(workbenchSource).toContain("invalidateMasterDataCache(client, \"hr-request\")");
    expect(workbenchSource).toContain("inventoryDataChangedEvent");
    expect(workbenchSource).toContain("hrRequestWorkflowChangedEvent");
    expect(workbenchSource).not.toContain('from("v_item_availability")');
    expect(workbenchSource).not.toContain('from("employees")');
    expect(workbenchSource).not.toContain('from("institutions")');
    expect(workbenchSource).not.toContain('from("departments")');
    expect(workbenchSource).not.toContain('from("uniform_items")');
    const optionViews = readFileSync(resolve(process.cwd(), "supabase/migrations/0104_hr_request_option_views.sql"), "utf8");
    expect(optionViews).toContain("v_hr_request_employee_options");
    expect(optionViews).toContain("v_hr_request_item_options");
    expect(optionViews).toContain("security_invoker = true");
    expect(optionViews).toContain("e.employment_status = 'ACTIVE'");
    expect(optionViews).toContain("grant select on public.v_hr_request_employee_options, public.v_hr_request_item_options to authenticated");
  });

  it("shares stable active item, institution, and warehouse options across workflow panels", () => {
    expect(cacheSource).toContain("loadActiveEmployeeOptions");
    expect(cacheSource).toContain('"active-employees"');
    expect(cacheSource).toContain("loadActiveItemOptions");
    expect(cacheSource).toContain("loadActiveInstitutionOptions");
    expect(cacheSource).toContain("loadActiveWarehouseOptions");
    expect(cacheSource).toContain('"active-institutions"');
    expect(cacheSource).toContain('"active-warehouses"');
    expect(cacheSource).toContain('freshCached<ProductMasterData>(client, "product")');
    expect(cacheSource).toContain('freshCached<EmployeeMasterData>(client, "employee")');
    expect(cacheSource).toContain('freshCached<OrganizationMasterData>(client, "organization")');
    expect(cacheSource).toContain('from("procurement_difference_reasons")');
    for (const source of catalogSources.filter((source) => !employeeDirectorySources.includes(source))) expect(source).toContain("master-data-cache");
    for (const source of employeeDirectorySources) expect(source).toContain("employee-directory-read");
    expect(readFileSync(resolve(process.cwd(), "src/app/ReplenishmentPanel.tsx"), "utf8")).not.toContain('from("uniform_items")');
    expect(readFileSync(resolve(process.cwd(), "src/app/StocktakePanel.tsx"), "utf8")).not.toContain('from("uniform_items")');
    expect(readFileSync(resolve(process.cwd(), "src/app/StocktakePanel.tsx"), "utf8")).not.toContain('from("warehouses")');
    expect(readFileSync(resolve(process.cwd(), "src/app/StocktakeCorrectionPanel.tsx"), "utf8")).not.toContain('from("warehouses")');
    expect(readFileSync(resolve(process.cwd(), "src/app/ErpExportPanel.tsx"), "utf8")).not.toContain('from("institutions")');
    expect(readFileSync(resolve(process.cwd(), "src/app/SeasonalCampaignPanel.tsx"), "utf8")).toContain("loadActiveEmployeeOptions");
    expect(readFileSync(resolve(process.cwd(), "src/app/SeasonalCampaignPanel.tsx"), "utf8")).not.toContain("loadEmployeeMasterData");
    expect(readFileSync(resolve(process.cwd(), "src/app/EmployeeImportPanel.tsx"), "utf8")).toContain('invalidateMasterDataCache(client, "employee")');
    expect(readFileSync(resolve(process.cwd(), "src/app/EmployeeMasterEditorPanel.tsx"), "utf8")).toContain('invalidateMasterDataCache(client, "employee")');
    expect(readFileSync(resolve(process.cwd(), "src/app/ProductMasterEditorPanel.tsx"), "utf8")).not.toContain('invalidateMasterDataCache(client, "active-items")');
    expect(readFileSync(resolve(process.cwd(), "src/app/OrganizationMasterEditorPanel.tsx"), "utf8")).not.toContain('invalidateMasterDataCache(client, "active-institutions")');
  });

  it("shares organization and procurement option reads instead of duplicating them in admin panels", () => {
    const accountSource = readFileSync(resolve(process.cwd(), "src/app/AccountAdminPanel.tsx"), "utf8");
    const procurementSource = readFileSync(resolve(process.cwd(), "src/app/SeasonalProcurementPanel.tsx"), "utf8");
    expect(cacheSource).toContain('"procurement"');
    expect(cacheSource).toContain("loadProcurementMasterData");
    expect(accountSource).toContain("loadOrganizationMasterData");
    expect(accountSource).not.toContain('from("institutions")');
    expect(accountSource).not.toContain('from("departments")');
    expect(procurementSource).toContain("loadProcurementMasterData");
    expect(procurementSource).not.toContain('from("suppliers")');
    expect(procurementSource).not.toContain('from("supplier_uniform_items")');
    expect(procurementSource).not.toContain('from("procurement_difference_reasons")');
  });

  it("makes manual refresh bypass the short-lived master-data snapshot", () => {
    expect(readFileSync(resolve(process.cwd(), "src/app/ProductCatalogPanel.tsx"), "utf8")).toContain("invalidateMasterDataCache(client, \"product\")");
    expect(readFileSync(resolve(process.cwd(), "src/app/ProductMasterEditorPanel.tsx"), "utf8")).toContain("invalidateMasterDataCache(client, \"product\")");
    expect(readFileSync(resolve(process.cwd(), "src/app/OrganizationCatalogPanel.tsx"), "utf8")).toContain("invalidateMasterDataCache(client, \"organization\")");
    expect(readFileSync(resolve(process.cwd(), "src/app/HrRequestWorkbench.tsx"), "utf8")).toContain("invalidateMasterDataCache(client, \"hr-request\")");
    expect(readFileSync(resolve(process.cwd(), "src/app/SeasonalCampaignPanel.tsx"), "utf8")).toContain("invalidateMasterDataCache(client, \"active-employees\")");
    expect(readFileSync(resolve(process.cwd(), "src/app/SeasonalProcurementPanel.tsx"), "utf8")).toContain("invalidateMasterDataCache(client, \"procurement\")");
    expect(readFileSync(resolve(process.cwd(), "src/app/EmployeeCatalogPanel.tsx"), "utf8")).toContain("invalidateEmployeeDirectory(client)");
  });
});
