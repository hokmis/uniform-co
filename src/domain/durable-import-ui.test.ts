import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canChangeDurableImportType, formatDurableImportDate, formatDurableImportCount, isDurableImportAwaitingUpload, isDurableImportObjectAlreadyUploaded, isDurableImportProcessingStatus, isDurableImportRowsVisibleStatus, isDurableImportTerminalStatus, summarizeDurableImportPreview } from "./durable-import-ui";

const durableImportPanelSource = readFileSync(resolve(process.cwd(), "src/app/DurableImportPanel.tsx"), "utf8");

describe("durable import UI recovery", () => {
  it("locks import type only while a batch is still active", () => {
    expect(canChangeDurableImportType(false, null)).toBe(true);
    expect(canChangeDurableImportType(false, "CANCELLED")).toBe(true);
    expect(canChangeDurableImportType(false, "FAILED")).toBe(true);
    expect(canChangeDurableImportType(false, "AWAITING_UPLOAD")).toBe(false);
    expect(canChangeDurableImportType(true, "CANCELLED")).toBe(false);
  });

  it("does not render missing batch fields as epoch time or blank counts", () => {
    expect(formatDurableImportDate(undefined)).toBe("時間未取得");
    expect(formatDurableImportDate(0)).toBe("時間未取得");
    expect(formatDurableImportCount(undefined)).toBe("—");
    expect(formatDurableImportCount(0)).toBe("0");
  });

  it("treats a fixed-key storage conflict as an already uploaded file", () => {
    expect(isDurableImportObjectAlreadyUploaded({ message: "The resource already exists" })).toBe(true);
    expect(isDurableImportObjectAlreadyUploaded({ statusCode: 409 })).toBe(true);
    expect(isDurableImportObjectAlreadyUploaded({ message: "new row violates row-level security policy" })).toBe(false);
  });

  it("keeps processing, review and terminal states distinct", () => {
    expect(isDurableImportProcessingStatus("PARSING")).toBe(true);
    expect(isDurableImportProcessingStatus("VALIDATED")).toBe(false);
    expect(isDurableImportRowsVisibleStatus("VALIDATED")).toBe(true);
    expect(isDurableImportRowsVisibleStatus("FAILED")).toBe(true);
    expect(isDurableImportRowsVisibleStatus("APPLYING")).toBe(false);
    expect(isDurableImportRowsVisibleStatus("APPLIED")).toBe(false);
    expect(isDurableImportTerminalStatus("APPLIED")).toBe(true);
    expect(isDurableImportAwaitingUpload("AWAITING_UPLOAD")).toBe(true);
  });

  it("counts every unconfirmed difference while keeping the rendered preview bounded", () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      row_number: index + 1,
      validation_errors: index < 11 ? ["invalid"] : [],
      import_field_diffs: [
        { field_name: `field-${index}-a`, old_value: null, new_value: index, confirmed: false },
        { field_name: `field-${index}-b`, old_value: index, new_value: index + 1, confirmed: index === 0 },
      ],
    }));

    const summary = summarizeDurableImportPreview(rows);

    expect(summary.validationErrorRows.map((row) => row.row_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(summary.unconfirmedDifferenceCount).toBe(23);
    expect(summary.visibleUnconfirmedDifferences).toHaveLength(10);
    expect(summary.visibleUnconfirmedDifferences[0]?.field_name).toBe("field-0-a");
  });

  it("serializes processing refreshes and pauses at the user confirmation state", () => {
    expect(durableImportPanelSource).not.toContain("window.setInterval");
    expect(durableImportPanelSource).toContain("useWorkflowStatusPoll");
    expect(durableImportPanelSource).toContain("active: panelActive && operationReady && isDurableImportProcessingStatus(batch?.status)");
    expect(durableImportPanelSource).toContain("intervalMs: 2500");
    expect(durableImportPanelSource).toContain("await kickEdgeProcessor(batch.id);");
    expect(durableImportPanelSource).toContain("return refreshBatch(batch.id, false);");
    expect(durableImportPanelSource).not.toContain("window.setTimeout(() => void processBatch()");
    expect(durableImportPanelSource).toContain('"VALIDATED"');
    expect(durableImportPanelSource).not.toContain("error?.message");
    expect(durableImportPanelSource).not.toContain("uploadResult.error.message");
  });

  it("keeps cancellation details collapsed until the user asks to cancel", () => {
    expect(durableImportPanelSource).toContain("cancelFormOpen");
    expect(durableImportPanelSource).toContain("收起取消");
    expect(durableImportPanelSource).toContain("確認取消批次");
  });

  it("starts ordinary file inspection from file selection while preserving final apply confirmation", () => {
    expect(durableImportPanelSource).toContain("void startUpload(nextFile, false, false)");
    expect(durableImportPanelSource).toContain("確認後匯入");
    expect(durableImportPanelSource).toContain("fileInputDisabled");
    expect(durableImportPanelSource).toContain("window.localStorage.removeItem(recoveryStorageKey)");
  });

  it("separates foreground batch reads from mutation busy state", () => {
    expect(durableImportPanelSource).toContain("const [dataLoading, setDataLoading] = useState(false);");
    expect(durableImportPanelSource).toContain("const [recoveryLoading, setRecoveryLoading] = useState(false);");
    expect(durableImportPanelSource).toContain("const readGenerationRef = useRef(0);");
    expect(durableImportPanelSource).toContain("const readControllerRef = useRef<ReadRequestController | null>(null);");
    expect(durableImportPanelSource).toContain("const readSequence = readController.begin();");
    expect(durableImportPanelSource).toContain("const canChangeType = canChangeDurableImportType(busy || recoveryLoading, batch?.status);");
    expect(durableImportPanelSource).toContain("aria-busy={busy || dataLoading || recoveryLoading}");
    expect(durableImportPanelSource).toContain("refreshBatch(batch.id, false)");
    expect(durableImportPanelSource).toContain("disabled={busy || recoveryLoading || !file");
    expect(durableImportPanelSource).toContain("readGeneration !== readGenerationRef.current");
    expect(durableImportPanelSource).toContain("!readController.isCurrent(readSequence)");
    expect(durableImportPanelSource).toContain("if (readController.isCurrent(readSequence)) setDataLoading(false);");
    expect(durableImportPanelSource).toContain("readControllerRef.current?.invalidate();");
    expect(durableImportPanelSource).toContain("const reloadSequenceRef = useRef(0);");
    expect(durableImportPanelSource).toContain("const reloadSequence = ++reloadSequenceRef.current;");
    expect(durableImportPanelSource).toContain("if (reloadSequence !== reloadSequenceRef.current) return;");
    expect(durableImportPanelSource).toContain("const refreshBatchDetailed = useCallback");
    expect(durableImportPanelSource).toContain("const refreshedResult = await refreshBatchDetailed(batchId);");
    expect(durableImportPanelSource).toContain("!refreshedResult.isCurrent");
    expect(durableImportPanelSource).toContain("onClick={() => void reloadBatch()} disabled={busy || recoveryLoading}");
    expect(durableImportPanelSource).not.toContain("onClick={() => void reloadBatch()} disabled={busy || dataLoading || recoveryLoading}");
  });
});
