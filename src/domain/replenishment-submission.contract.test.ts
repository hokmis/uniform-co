import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src", "app", "ReplenishmentPanel.tsx"),
  "utf8",
);

describe("replenishment submission client contract", () => {
  it("routes the one-click submit action through an atomic, testable operation seam", () => {
    expect(source).toContain("submitReplenishmentOperation");
    expect(source).not.toContain('client.rpc("create_replenishment_draft"');
    expect(source).not.toContain('client.rpc("update_replenishment_request_draft"');
    expect(source).not.toContain('client.rpc("submit_replenishment_request"');
  });

  it("locks the submitted payload only while a response is genuinely unknown", () => {
    expect(source).toContain('const [entryState, setEntryState] = useState<ReplenishmentEntryState>({ kind: "new" });');
    expect(source).toContain("resolveReplenishmentEntryState(entryState, result)");
    expect(source).not.toContain("const [submitted, setSubmitted]");
    expect(source).not.toContain("const [submissionUnresolved, setSubmissionUnresolved]");
    expect(source).not.toContain("const [hasDraftOperation, setHasDraftOperation]");
    expect(source).toContain('submissionUnresolved ? "重試同一筆送出"');
    expect(source).toContain("disabled={busy || !canEditReplenishmentEntry(entryState) || itemsReadBlocked}");
    expect(source).toContain("disabled={busy || submitted || cancellationUnresolved || (!submissionUnresolved && itemsReadBlocked) || !identityReady}");
    expect(source).toContain('cancellationUnresolved ? "重試同一筆取消"');
    expect(source).toContain("catch {\n      setEntryState(markReplenishmentCancellationUnknown(entryState, reason));");
    expect(source).toContain('(message.includes("已送出") || message.includes("已取消")) && !identityError ? "success-note"');
    expect(source).not.toContain('message.startsWith("補庫單")');
    expect(source).toContain("不要修改內容或另建補庫單");
  });
});
