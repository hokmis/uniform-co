import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const adapter = join(process.cwd(), "scripts", "renderer", "adapters", "uniform-pdf-smoke-v0.mjs");

const payload = {
  schema: "uniform-document-render-payload-v1",
  document_type: "STOCKTAKE",
  artifact_kind: "DRAFT_WATERMARK",
  revision: 1,
  template_version: "staging-renderer-smoke-v1",
};

describe("PDF renderer smoke adapter", () => {
  it("renders deterministic structurally valid PDF bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-pdf-adapter-"));
    try {
      const payloadPath = join(directory, "payload.json");
      const firstOutput = join(directory, "first.pdf");
      const secondOutput = join(directory, "second.pdf");
      await writeFile(payloadPath, JSON.stringify(payload), "utf8");

      await execFileAsync(process.execPath, [adapter, "--attempt-id", "attempt-1", "--payload", payloadPath, "--output", firstOutput]);
      await execFileAsync(process.execPath, [adapter, "--attempt-id", "attempt-2", "--payload", payloadPath, "--output", secondOutput]);

      const first = await readFile(firstOutput);
      const second = await readFile(secondOutput);
      expect(first.equals(second)).toBe(true);
      expect(first.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
      expect(first.toString("ascii")).toContain("xref\n0 6\n");
      expect(first.toString("ascii")).toMatch(/startxref\n\d+\n%%EOF\n$/);
      expect(first.length).toBeGreaterThan(300);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsupported payloads and supports intentional failure mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-pdf-adapter-"));
    try {
      const payloadPath = join(directory, "payload.json");
      const outputPath = join(directory, "output.pdf");
      await writeFile(payloadPath, JSON.stringify({ ...payload, schema: "unknown" }), "utf8");

      await expect(
        execFileAsync(process.execPath, [adapter, "--attempt-id", "attempt-1", "--payload", payloadPath, "--output", outputPath]),
      ).rejects.toThrow(/Unsupported document payload schema/);

      await expect(
        execFileAsync(process.execPath, [adapter, "--attempt-id", "attempt-1", "--payload", payloadPath, "--output", outputPath, "--mode", "fail"]),
      ).rejects.toThrow(/Intentional smoke adapter failure/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
