import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0092_hr_request_active_master_guard.sql"),
  "utf8",
);

describe("HR request active master guard", () => {
  it("rejects submit when the employee, institution or department is no longer active", () => {
    expect(migration).toContain("create or replace function private.validate_hr_request_active_master_data");
    expect(migration).toContain("old.status = 'DRAFT' and new.status = 'SUBMITTED'");
    expect(migration).toContain("e.employment_status <> 'ACTIVE'");
    expect(migration).toContain("not i.is_active");
    expect(migration).toContain("not d.is_active");
    expect(migration).toContain("create trigger hr_request_active_master_guard");
  });
});
