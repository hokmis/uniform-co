import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0086_sso_server_read_grants.sql"),
  "utf8",
).replace(/\s+/g, " ");

describe("SSO server read grants migration contract", () => {
  it("grants only the minimum target-table read access to the server role", () => {
    expect(migration).toContain("grant usage on schema public to service_role");
    expect(migration).toContain("grant select on public.app_accounts, public.user_roles to service_role");
    expect(migration).not.toMatch(/grant\s+all/i);
    expect(migration).not.toMatch(/grant\s+(insert|update|delete)\s+on\s+public\.(app_accounts|user_roles)/i);
  });
});
