import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../supabase/migrations/0079_employee_master_management.sql", import.meta.url), "utf8");
const directoryMigration = readFileSync(new URL("../../supabase/migrations/0120_employee_directory_view.sql", import.meta.url), "utf8");
const employeeCatalogSource = readFileSync(new URL("../app/EmployeeCatalogPanel.tsx", import.meta.url), "utf8");
const employeeImportSource = readFileSync(new URL("../app/EmployeeImportPanel.tsx", import.meta.url), "utf8");

describe("employee master management SQL contract", () => {
  it("provides HR-only idempotent save and audited export RPCs", () => {
    expect(migration).toContain("create or replace function public.save_employee_master");
    expect(migration).toContain("create or replace function public.record_employee_master_export");
    expect(migration.match(/private\.has_role\('HR'\)/g)).toHaveLength(2);
    expect(migration).toContain("'SAVE_EMPLOYEE_MASTER'");
    expect(migration).toContain("'EXPORT_EMPLOYEE_MASTER'");
    expect(migration).toContain("private.append_audit_event");
    expect(migration).toContain("'EMPLOYEE_MASTER_EXPORTED'");
    expect(migration).toContain("Active employee cannot have a termination date");
    expect(migration).toContain("p_employee_id uuid");
    expect(migration).toContain("Employee number already exists; load the existing employee before editing");
    expect(migration).toContain("Employee number is immutable after creation");
  });

  it("keeps table mutation behind the RPC instead of granting browser DML", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("revoke all on function public.save_employee_master");
    expect(migration).not.toMatch(/grant\s+(insert|update|delete)\s+on\s+(table\s+)?public\.employees/i);
    expect(migration).not.toMatch(/delete\s+from\s+public\.employees/i);
  });

  it("shares one employee directory read seam across catalog and import", () => {
    expect(employeeCatalogSource).toContain("loadEmployeeDirectory");
    expect(employeeCatalogSource).not.toContain("loadEmployeeMasterData");
    expect(employeeImportSource).toContain("loadEmployeeDirectory");
    expect(employeeImportSource).not.toContain("loadOrganizationMasterData");
    expect(directoryMigration).toContain("security_invoker = true");
    expect(directoryMigration).toContain("v_employee_directory");
    expect(directoryMigration).toContain("grant select on public.v_employee_directory to authenticated");
  });
});
