import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/app/HrRequestWorkbench.tsx"), "utf8");

describe("HR request UI flow", () => {
  it("offers a clean next-request entry after a submitted request", () => {
    expect(source).toContain("function resetEntryForm()");
    expect(source).toContain("function startNextRequest()");
    expect(source).toContain("建立下一筆需求");
    expect(source).toContain("resetEntryForm();");
  });

  it("provides an in-panel data retry without requiring a full page refresh", () => {
    expect(source).toContain("function reloadOperationalData()");
    expect(source).toContain("setDataReloadToken((current) => current + 1)");
    expect(source).toContain("重新載入資料");
    expect(source).toContain("dataReloadToken");
  });

  it("does not repeat a master-data read failure as a form validation error", () => {
    expect(source).toContain('{dataReadBlocked ? "等待主檔資料" : result.error ? "不可送出" : "可送出預覽"}');
    expect(source).toContain("主檔資料載入後，這裡會顯示需求量、可用庫存與品號彙總。");
    expect(source).toContain("{dataReadBlocked ? (");
    expect(source).toContain("<span>{result.error}</span>");
  });

  it("does not downgrade a usable form while its data snapshot is refreshing", () => {
    const reloadFunction = source.slice(
      source.indexOf("function reloadOperationalData()"),
      source.indexOf("\n  useEffect(() =>", source.indexOf("function reloadOperationalData()")),
    );
    expect(reloadFunction).not.toContain("setDataReady(false)");
    expect(source).toContain("disabled: submitting || (!submissionRecovering && (dataReadBlocked || Boolean(result.error)))");
    expect(source).toContain("shouldPreserveReadSnapshot(");
    expect(source).toContain('staleReadSnapshotMessage("人資需求選項")');
    expect(source).toContain("safeHrRequestMasterDataErrorMessage(masterData.errors)");
    expect(source).not.toContain("disabled={submitting || loadingData || (Boolean(submittedRequestId) && !editingSubmitted)}");
    expect(source).toContain("disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}");
    expect(source).toContain("onClick={reloadOperationalData} disabled={submitting}");
    expect(source).not.toContain("onClick={reloadOperationalData} disabled={loadingData || submitting}");
  });

  it("requires an explicit department and item before adding an issue line", () => {
    expect(source).toContain('setLines((current) => sameAccountSnapshot ? preserveHrRequestDraftLines(current, null) : [])');
    expect(source).toContain('if (dataReadBlocked || visibleItemOptions.length === 0) return;');
    expect(source).toContain('<option value="">請選擇報局單位</option>');
    expect(source).toContain('<option value="">請選擇制服品號</option>');
    expect(source).not.toContain('<span>員工／機構</span>');
    expect(source).not.toContain('itemId: itemOptions[0].itemId');
  });

  it("submits new and draft requests through one adapter without component-level RPC capability state", () => {
    expect(source).toContain("submitHrRequestOperation(");
    expect(source).toContain("submissionInput,");
    expect(source).toContain("client,");
    expect(source).not.toContain("atomicSubmitRpcSupported");
    expect(source).toContain("submissionRecovery?.input ?? nextSubmissionInput");
    expect(source).toContain("setSubmissionRecovery(submission.outcomeUnknown");
    expect(source).toContain("submissionRecovering ||");
    expect(source).toContain("以相同資料查回／重試送出");
    expect(source).not.toContain('client.rpc("create_hr_request_draft"');
    expect(source).not.toContain('client.rpc("update_hr_request_draft"');
    expect(source).toContain('client.rpc("update_hr_request"');
  });

  it("does not treat an already-submitted request as a cancellable draft", () => {
    const submitFunction = source.slice(
      source.indexOf("async function submitRequest()"),
      source.indexOf("async function cancelRequest()"),
    );

    expect(source).toContain('const hasDraftOperation = requestEntryState.kind === "draft";');
    expect(source).toContain('if (!client || requestEntryState.kind !== "draft") return;');
    expect(submitFunction).not.toContain("setHasDraftOperation");
    expect(source).not.toContain("const [hasDraftOperation, setHasDraftOperation]");
    expect(source).not.toContain("const [submittedRequestId, setSubmittedRequestId]");
    expect(source).not.toContain("const [editingSubmitted, setEditingSubmitted]");
  });
});
