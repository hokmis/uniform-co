import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pdfSource = readFileSync(resolve(process.cwd(), "src/app/PdfArtifactPanel.tsx"), "utf8");
const erpSource = readFileSync(resolve(process.cwd(), "src/app/ErpExportPanel.tsx"), "utf8");
const stocktakeSource = readFileSync(resolve(process.cwd(), "src/app/StocktakePanel.tsx"), "utf8");
const ssoPromptSource = readFileSync(resolve(process.cwd(), "src/app/SsoLoginPrompt.tsx"), "utf8");
const ssoLoadingSource = readFileSync(resolve(process.cwd(), "src/app/SsoLoadingShell.tsx"), "utf8");

describe("workflow status UI contract", () => {
  it("keeps PDF and ERP screens on user-facing status labels", () => {
    expect(pdfSource).toContain("workflowStatusLabel");
    expect(pdfSource).toContain("workflowStatusTone");
    expect(erpSource).toContain("workflowStatusLabel");
    expect(erpSource).not.toContain("error?.message");
    expect(pdfSource).not.toContain("error?.message");
  });

  it("keeps visible loading labels in the user's language", () => {
    expect(ssoPromptSource).toContain(">處理中</span>");
    expect(ssoLoadingSource).toContain(">處理中</span>");
    expect(ssoPromptSource).not.toContain(">PROCESSING</span>");
    expect(ssoLoadingSource).not.toContain(">PROCESSING</span>");
  });

  it("does not expose the technical stale-count code in the recount prompt", () => {
    expect(stocktakeSource).toContain("盤點資料已過期");
    expect(stocktakeSource).not.toContain("盤點標記為 STALE_COUNT");
  });
});
