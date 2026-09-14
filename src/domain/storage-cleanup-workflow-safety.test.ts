import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = join(process.cwd(), ".github", "workflows", "storage-cleanup.yml");

describe("storage cleanup workflow safety", () => {
  it("keeps the scheduled path dry-run only", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("schedule:");
    expect(workflow).toContain(
      "if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'dry-run')",
    );
    expect(workflow).toContain("run: npm run cleanup:storage");
  });

  it("allows destructive execution only for an exactly confirmed manual dispatch", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const executeCommands = workflow.match(/npm run cleanup:storage -- --execute/g) ?? [];

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.mode == 'execute' && inputs.confirmation == 'DELETE_ELIGIBLE_STORAGE'",
    );
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.mode == 'execute' && inputs.confirmation != 'DELETE_ELIGIBLE_STORAGE'",
    );
    expect(workflow).toContain("CLEANUP_EXECUTE_CONFIRM: DELETE_ELIGIBLE_STORAGE");
    expect(workflow).toContain("environment: staging-storage-cleanup");
    expect(executeCommands).toHaveLength(1);
  });
});
