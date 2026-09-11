import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = join(process.cwd(), ".github", "workflows", "ci.yml");

describe("CI workflow safety", () => {
  it("runs the repository verification commands for pushes and pull requests", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const commands = [
      "npm ci",
      "npm test",
      "npm run lint",
      "npm run typecheck",
      "npm run build",
    ];

    expect(workflow).toMatch(/^\s*push:/m);
    expect(workflow).toMatch(/^\s*pull_request:/m);
    expect(workflow).toMatch(/^permissions:\r?\n  contents: read\s*$/m);

    let previousIndex = -1;
    for (const command of commands) {
      const commandIndex = workflow.indexOf(`- run: ${command}`);
      expect(commandIndex).toBeGreaterThan(previousIndex);
      previousIndex = commandIndex;
    }
  });

  it("does not turn verification CI into a privileged deployment workflow", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toMatch(/^\s*environment:/m);
    expect(workflow).not.toMatch(/^\s*(deployments|id-token|packages|pull-requests):\s*write\s*$/m);
    expect(workflow).not.toMatch(/\b(vercel|supabase)\b/i);
  });
});
