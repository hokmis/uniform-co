import { describe, expect, it } from "vitest";
import { isArtifactTerminalStatus, workflowStatusLabel, workflowStatusTone } from "./workflow-status";

describe("workflow status display adapter", () => {
  it("uses concise Chinese labels for technical workflow states", () => {
    expect(workflowStatusLabel("VALIDATED")).toBe("等待確認");
    expect(workflowStatusLabel("POSTED")).toBe("已完成");
    expect(workflowStatusLabel("GENERATION_FAILED")).toBe("產生失敗");
  });

  it("does not expose an unknown database code in the UI", () => {
    expect(workflowStatusLabel("A_FUTURE_INTERNAL_STATE")).toBe("待處理");
    expect(workflowStatusLabel(null)).toBe("待建立");
  });

  it("keeps tone decisions independent from the label", () => {
    expect(workflowStatusTone("APPLIED")).toBe("success");
    expect(workflowStatusTone("FAILED")).toBe("danger");
    expect(workflowStatusTone("PARSING")).toBe("neutral");
  });

  it("allows a new artifact revision only after the current artifact is terminal", () => {
    expect(isArtifactTerminalStatus("READY")).toBe(true);
    expect(isArtifactTerminalStatus("FAILED")).toBe(true);
    expect(isArtifactTerminalStatus("PREPARING")).toBe(false);
    expect(isArtifactTerminalStatus(null)).toBe(false);
    expect(isArtifactTerminalStatus("UNKNOWN")).toBe(false);
  });
});
