import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = join(process.cwd(), ".github", "workflows", "import-staging-retention.yml");

describe("import staging retention workflow safety", () => {
  it("keeps the scheduled path dry-run only", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("schedule:");
    expect(workflow).toContain(
      "if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'dry-run')",
    );
    expect(workflow).toContain("run: npm run retention:import-staging");
  });

  it("allows destructive execution only for an exactly confirmed manual dispatch", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const executeCommands = workflow.match(/npm run retention:import-staging -- --execute/g) ?? [];

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.mode == 'execute' && inputs.confirmation == 'PURGE_ELIGIBLE_IMPORT_STAGING'",
    );
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.mode == 'execute' && inputs.confirmation != 'PURGE_ELIGIBLE_IMPORT_STAGING'",
    );
    expect(workflow).toContain("IMPORT_RETENTION_EXECUTE_CONFIRM: PURGE_ELIGIBLE_IMPORT_STAGING");
    expect(workflow).toContain("environment: staging-import-retention");
    expect(executeCommands).toHaveLength(1);
  });
});
