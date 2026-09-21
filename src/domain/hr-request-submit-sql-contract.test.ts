import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0094_hr_request_submit_scope_hardening.sql"),
  "utf8",
);

describe("submit_hr_request SQL alias contract", () => {
  it("keeps the update target out of FROM JOIN conditions and removes the short l alias", () => {
    const submitFunction = migration.slice(
      migration.indexOf("create or replace function public.submit_hr_request"),
    );
    const issueUpdate = submitFunction.match(
      /update public\.hr_issue_lines as target_line[\s\S]*?and target_line\.request_id = p_request_id;/i,
    )?.[0];
    expect(issueUpdate).toBeDefined();
    expect(issueUpdate).toContain("from (\n    select issue_line.id,");
    expect(issueUpdate).toContain("where target_line.id = source_line.id");
    expect(issueUpdate).not.toMatch(/\bl\./i);
    expect(issueUpdate).not.toMatch(/join public\.uniform_items ui on ui\.id = l\.item_id/i);
  });

  it("uses descriptive aliases in the submission validation trigger", () => {
    expect(migration).not.toMatch(/from public\.hr_issue_lines l[\s\S]*?left join public\.hr_request_items r/i);
    expect(migration).toContain("from public.hr_issue_lines source_line");
    expect(migration).toContain("left join public.hr_request_items request_item");
  });
});
