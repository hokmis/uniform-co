import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const hookSource = readFileSync(resolve(process.cwd(), "src/app/use-workflow-status-poll.ts"), "utf8");
const pdfSource = readFileSync(resolve(process.cwd(), "src/app/PdfArtifactPanel.tsx"), "utf8");
const erpSource = readFileSync(resolve(process.cwd(), "src/app/ErpExportPanel.tsx"), "utf8");
const importSource = readFileSync(resolve(process.cwd(), "src/app/DurableImportPanel.tsx"), "utf8");

describe("workflow polling seam", () => {
  it("serializes visible-panel polling and stops at terminal states", () => {
    expect(hookSource).toContain("useWorkflowStatusPoll");
    expect(hookSource).toContain("window.setTimeout");
    expect(hookSource).toContain("terminalRef.current(value)");
    expect(hookSource).toContain("cancelled = true");
    expect(hookSource).toContain("try {");
    expect(hookSource).toContain("catch {");
    expect(hookSource).toContain("retry on the next interval");
    expect(hookSource).toContain("inFlightRef");
    expect(hookSource).toContain("if (inFlightRef.current) return inFlightRef.current;");
    expect(hookSource).toContain("return { refresh };");
  });

  it("is shared by PDF and ERP artifact panels", () => {
    expect(pdfSource).toContain("useWorkflowStatusPoll");
    expect(erpSource).toContain("useWorkflowStatusPoll");
    expect(pdfSource).toContain("isTerminal: (value) => isArtifactTerminalStatus(value.status)");
    expect(erpSource).toContain("isTerminal: (value) => isArtifactTerminalStatus(value.status)");
    expect(pdfSource).toContain("retrySupabaseQueriesAfterSessionRefresh");
    expect(pdfSource).toContain("refresh: refreshArtifactStatus");
    expect(pdfSource).toContain("const result = await refreshArtifactStatus();");
    expect(erpSource).toContain("refresh: refreshArtifactStatus");
    expect(erpSource).toContain("const result = await refreshArtifactStatus();");
  });

  it("does not lock artifact rechecks or completed downloads behind a read-only refresh", () => {
    for (const source of [pdfSource, erpSource]) {
      const refreshBody = source.match(/async function refreshArtifact\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
      expect(refreshBody).not.toContain("artifactLoading");
      expect(source).toContain('onClick={() => void refreshArtifact()} disabled={busy || !identityReady}');
    }

    expect(pdfSource).toContain('disabled: busy || !identityReady, label: "下載 PDF"');
    expect(erpSource).toContain('disabled: busy || !identityReady, label: "下載檔案"');
    expect(pdfSource).toContain("if (!identityReady || !client || !artifact || artifact.status !== \"READY\") return;");
  });

  it("allows leaving terminal artifacts during refresh and fences the late status response", () => {
    for (const source of [pdfSource, erpSource]) {
      const refreshBody = source.match(/async function refreshArtifact\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
      const startAnotherBody = source.match(/function startAnother\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
      const startAnotherAction = source.match(/onClick=\{startAnother\} disabled=\{([^}]+)\}/)?.[1] ?? "";

      expect(refreshBody).toContain("artifactStatusReadControllerRef.current.begin()");
      expect(refreshBody).toContain("artifactStatusReadControllerRef.current.isCurrent(sequence)");
      expect(refreshBody).toContain("current?.id === artifact.id ? result : current");
      expect(startAnotherBody).toContain("artifactStatusReadControllerRef.current.invalidate()");
      expect(startAnotherBody).toContain("setArtifactLoading(false)");
      expect(startAnotherAction).not.toContain("artifactLoading");
      expect(startAnotherAction).toContain("isArtifactTerminalStatus");
      expect(source).toContain("if (currentArtifactIdRef.current === value.id) setArtifact(value);");
    }

    expect(erpSource).toContain('disabled: busy || !identityReady, label: "同批次重試"');
  });

  it("waits for an authenticated active workspace before ERP batch recovery", () => {
    expect(erpSource).toContain("if (!identityReady || !client || batch) return;");
  });

  it("keeps durable import processing on the same retryable polling seam", () => {
    expect(importSource).toContain("useWorkflowStatusPoll");
    expect(importSource).toContain("active: panelActive && operationReady && isDurableImportProcessingStatus(batch?.status)");
    expect(importSource).toContain("kickEdgeProcessor");
    expect(importSource).toContain("refreshBatch(batch.id, false)");
    expect(importSource).toContain("intervalMs: 2500");
    expect(importSource).not.toContain("window.setTimeout(() => void processBatch()");
  });
});
