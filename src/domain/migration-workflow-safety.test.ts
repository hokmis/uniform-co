import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = join(process.cwd(), ".github", "workflows", "supabase-migrations.yml");

describe("Supabase migration workflow safety", () => {
  it("keeps migrations manual and prevents arbitrary project refs", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m);
    expect(workflow).not.toContain("inputs.project_ref");
    expect(workflow).toContain("SUPABASE_PROJECT_REF: ${{ secrets.SUPABASE_PROJECT_REF }}");
    expect(workflow).toContain('supabase link --project-ref "${SUPABASE_PROJECT_REF}"');
  });

  it("separates staging and production approvals and requires target-specific confirmation", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("environment: supabase-staging-migrations");
    expect(workflow).toContain("environment: supabase-production-migrations");
    expect(workflow).toContain('staging) expected="STAGING_MIGRATION"');
    expect(workflow).toContain('production) expected="PRODUCTION_MIGRATION"');
    expect(workflow).toContain('test "${MIGRATION_CONFIRMATION}" = "${expected}"');
    expect(workflow).toContain("cancel-in-progress: false");
  });
});
