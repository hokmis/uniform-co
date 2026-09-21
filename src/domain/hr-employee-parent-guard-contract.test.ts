import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0090_employee_parent_active_guard.sql"),
  "utf8",
);

describe("HR employee parent active guard migration", () => {
  it("rejects deactivating an institution or department that still has active employees", () => {
    expect(migration).toContain("private.reject_active_employee_parent_deactivation");
    expect(migration).toContain("Cannot deactivate institution with active employees");
    expect(migration).toContain("Cannot deactivate department with active employees");
    expect(migration).toContain("e.employment_status = 'ACTIVE'");
    expect(migration).toContain("reject_institution_deactivation_with_active_employees");
    expect(migration).toContain("reject_department_deactivation_with_active_employees");
  });
});
