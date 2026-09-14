import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const inventoryPath = join(root, "docs", "deployment", "secret-inventory.md");
const workflowPaths = [
  join(root, ".github", "workflows", "supabase-migrations.yml"),
  join(root, ".github", "workflows", "backup.yml"),
  join(root, ".github", "workflows", "storage-cleanup.yml"),
  join(root, ".github", "workflows", "import-staging-retention.yml"),
];

describe("secret inventory contract", () => {
  it("documents every secret referenced by privileged GitHub workflows", async () => {
    const inventory = await readFile(inventoryPath, "utf8");
    const workflows = await Promise.all(workflowPaths.map((path) => readFile(path, "utf8")));
    const names = new Set<string>();

    for (const workflow of workflows) {
      for (const match of workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)) names.add(match[1]);
    }

    expect(names.size).toBeGreaterThan(0);
    for (const name of names) expect(inventory).toContain(`\`${name}\``);
  });

  it("documents privileged runtime credentials enforced by staging preflight", async () => {
    const inventory = await readFile(inventoryPath, "utf8");
    const requiredProtectedNames = [
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_SECRET_KEY",
      "STAGING_DATABASE_URL",
      "IMPORT_WORKER_DATABASE_URL",
      "DATABASE_URL",
      "IMPORT_STORAGE_PROXY_TOKEN",
      "RENDER_STORAGE_PROXY_TOKEN",
      "DOCUMENT_RENDERER_DATABASE_URL",
      "ERP_RENDERER_DATABASE_URL",
      "RENDER_STORAGE_PROXY_DATABASE_URL",
      "SUPABASE_STORAGE_ADMIN_KEY",
      "BACKUP_DECRYPT_COMMAND",
      "TARGET_DATABASE_URL",
      "CLEANUP_DATABASE_URL",
      "CLEANUP_STORAGE_ADMIN_KEY",
      "IMPORT_RETENTION_DATABASE_URL",
    ];

    for (const name of requiredProtectedNames) expect(inventory).toContain(`\`${name}\``);
  });

  it("keeps privileged-looking values out of the documented browser-safe namespace", async () => {
    const inventory = await readFile(inventoryPath, "utf8");
    const publicRows = inventory
      .split(/\r?\n/)
      .filter((line) => line.startsWith("| `NEXT_PUBLIC_"));

    expect(publicRows).toHaveLength(2);
    for (const row of publicRows) {
      expect(row).not.toMatch(/SERVICE_ROLE|SECRET|ADMIN|DATABASE|PASSWORD|TOKEN/i);
    }
  });
});
