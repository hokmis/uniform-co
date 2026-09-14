import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../supabase/migrations/0079_employee_master_management.sql", import.meta.url), "utf8");

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
});
