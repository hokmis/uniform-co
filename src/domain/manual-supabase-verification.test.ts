import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const verificationSql = readFileSync(
  join(process.cwd(), "supabase", "manual", "verify-production-setup.sql"),
  "utf8",
);
const normalizedSql = verificationSql.replace(/\s+/g, " ");

describe("manual Supabase verification SQL", () => {
  it("uses the app_accounts contact column defined by the migrations", () => {
    expect(normalizedSql).toContain("a.email_snapshot");
    expect(normalizedSql).not.toContain("a.contact_email");
  });

  it("derives active role assignments from active accounts", () => {
    expect(normalizedSql).toContain("from public.user_roles r join public.app_accounts a on a.id = r.account_id");
    expect(normalizedSql).toContain("where a.is_active");
    expect(normalizedSql).not.toContain("from public.user_roles where is_active");
  });
});
