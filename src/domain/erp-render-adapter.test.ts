import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const adapter = join(process.cwd(), "scripts", "renderer", "adapters", "uniform-erp-sales-v0.mjs");

const payload = {
  schema: "uniform-erp-render-payload-v1",
  format_version: "UNIFORM-ERP-SALES-v0",
  lines: [
    { line_no: 2, item_id: "item-2", item_code: "U002", item_name: "冬外套", unit: "件", quantity: 3 },
    { line_no: 1, item_id: "item-1", item_code: "U001", item_name: "上衣", unit: "件", quantity: 2 },
  ],
};

describe("ERP renderer demo adapter", () => {
  it("renders a deterministic sorted CSV from the versioned DTO", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-erp-adapter-"));
    try {
      const payloadPath = join(directory, "payload.json");
      const outputPath = join(directory, "output.csv");
      await writeFile(payloadPath, JSON.stringify(payload), "utf8");
      await execFileAsync(process.execPath, [adapter, "--attempt-id", "attempt-1", "--payload", payloadPath, "--output", outputPath]);
      await expect(readFile(outputPath, "utf8")).resolves.toBe(
        "item_code,item_name,unit,quantity\n\"U001\",\"上衣\",\"件\",\"2\"\n\"U002\",\"冬外套\",\"件\",\"3\"",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a duplicate item or an unvalidated format", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-erp-adapter-"));
    try {
      const payloadPath = join(directory, "payload.json");
      const outputPath = join(directory, "output.csv");
      await writeFile(payloadPath, JSON.stringify({ ...payload, format_version: "DINGXIN-UNKNOWN" }), "utf8");
      await expect(execFileAsync(process.execPath, [adapter, "--attempt-id", "attempt-1", "--payload", payloadPath, "--output", outputPath])).rejects.toThrow(/validated demo format/);
      await writeFile(payloadPath, JSON.stringify({ ...payload, lines: [payload.lines[0], { ...payload.lines[1], item_id: payload.lines[0].item_id }] }), "utf8");
      await expect(execFileAsync(process.execPath, [adapter, "--attempt-id", "attempt-1", "--payload", payloadPath, "--output", outputPath])).rejects.toThrow(/Duplicate item_id/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
