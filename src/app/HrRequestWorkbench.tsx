"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  HrRequestValidationError,
  summarizeHrRequest,
  type EmployeeSnapshot,
  type IssueLineDraft,
  type UniformItemSnapshot,
} from "@/src/domain/hr-request";
import { buildActiveHrEmployeeOptions } from "@/src/domain/hr-employee-options";
import {
  createHrRequestOperation,
  preserveHrRequestDraftLines,
  preserveHrRequestIncreaseDraft,
  resolveHrRequestSubmissionRoute,
  rotateHrRequestDraftKeys,
  type HrRequestEntryState,
  type HrRequestLineSelection,
  type HrRequestOperation,
} from "@/src/domain/hr-request-workflow";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import {
  submitHrRequestOperation,
  type HrRequestSubmissionInput,
} from "@/src/domain/hr-request-submission";
import { inventoryDataChangedEvent } from "@/src/domain/inventory-events";
import { shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { invalidateMasterDataCache, loadHrRequestMasterData, loadOrganizationMasterData, safeHrRequestMasterDataErrorMessage } from "@/src/lib/master-data-cache";
import { isSupabaseSessionSyncError, retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import { useWorkspaceSession } from "./workspace-session";
import { usePanelActivity } from "./RetainedPanelSet";
import WorkflowActionBar from "./WorkflowActionBar";

type LineState = HrRequestLineSelection & {
  departmentCode?: string;
};

type DepartmentOption = { code: string; name: string };

const previewEmployees: EmployeeSnapshot[] = [
  {
    employeeId: "employee-1",
    employeeNo: "E001",
    employeeName: "測試員工一",
    institutionCode: "ABC",
    institutionName: "ABC 機構",
    departmentCode: "A",
    departmentName: "A 部門",
  },
  {
    employeeId: "employee-2",
    employeeNo: "E002",
    employeeName: "測試員工二",
    institutionCode: "ABD",
    institutionName: "ABD 機構",
    departmentCode: "B",
    departmentName: "B 部門",
  },
];

const previewDepartments: DepartmentOption[] = [
  { code: "A", name: "A 部門" },
  { code: "B", name: "B 部門" },
];

const previewItems: UniformItemSnapshot[] = [
  {
    itemId: "item-m",
    itemCode: "U-M",
    itemName: "測試上衣",
    size: "M",
    unit: "件",
    hrOnHand: 10,
    generalOnHand: 5,
    activeReserved: 0,
  },
  {
    itemId: "item-l",
    itemCode: "U-L",
    itemName: "測試長褲",
    size: "L",
    unit: "件",
    hrOnHand: 20,
    generalOnHand: 100,
    activeReserved: 0,
  },
];

const previewLines: LineState[] = [
  { lineId: "line-1", employeeId: "employee-1", itemId: "item-m", quantity: 10, departmentCode: "A" },
];

function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

export default function HrRequestWorkbench() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const previewMode = !client;
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeSnapshot[]>(previewMode ? previewEmployees : []);
  const [departmentOptions, setDepartmentOptions] = useState<DepartmentOption[]>(previewMode ? previewDepartments : []);
  const [itemOptions, setItemOptions] = useState<UniformItemSnapshot[]>(previewMode ? previewItems : []);
  const [lines, setLines] = useState<LineState[]>(previewMode ? previewLines : []);
  const [distributionDate, setDistributionDate] = useState(taipeiToday());
  const [requestNote, setRequestNote] = useState("");
  const [increases, setIncreases] = useState<Record<string, number>>(
    previewMode ? { "item-m": 0, "item-l": 0 } : {},
  );
  const [dataMessage, setDataMessage] = useState("");
  const [submitMessage, setSubmitMessage] = useState("");
  const [loadingData, setLoadingData] = useState(() => Boolean(client));
  const [dataReloadToken, setDataReloadToken] = useState(0);
  const [dataReady, setDataReady] = useState(previewMode);
  const [submitting, setSubmitting] = useState(false);
  const [requestEntryState, setRequestEntryState] = useState<HrRequestEntryState>({ kind: "new" });
  const [submissionRecovery, setSubmissionRecovery] = useState<{
    input: HrRequestSubmissionInput;
  } | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const operationRef = useRef<HrRequestOperation | null>(null);
  const cancelKeyRef = useRef<string | null>(null);
  const employeeOptionsRef = useRef<EmployeeSnapshot[]>(employeeOptions);
  const itemOptionsRef = useRef<UniformItemSnapshot[]>(itemOptions);
  const [dataSnapshotAccountId, setDataSnapshotAccountId] = useState<string | null>(previewMode ? accountId : null);
  const dataSnapshotAccountIdRef = useRef<string | null>(previewMode ? accountId : null);
  const hasSession = isAuthenticated;
  const submissionRecovering = submissionRecovery !== null;
  const submittedRequestId = requestEntryState.kind === "submitted" ? requestEntryState.requestId : "";
  const editingSubmitted = requestEntryState.kind === "submitted" && requestEntryState.editing;
  const hasDraftOperation = requestEntryState.kind === "draft";
  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);

  const hasCurrentDataSnapshot = previewMode || Boolean(
    identityReady
      && dataReady
      && dataSnapshotAccountId
      && dataSnapshotAccountId === accountId,
  );
  const dataReadBlocked = !hasCurrentDataSnapshot;
  const visibleEmployeeOptions = useMemo(() => hasCurrentDataSnapshot ? employeeOptions : [], [employeeOptions, hasCurrentDataSnapshot]);
  const visibleDepartmentOptions = useMemo(() => hasCurrentDataSnapshot ? departmentOptions : [], [departmentOptions, hasCurrentDataSnapshot]);
  const visibleItemOptions = useMemo(() => hasCurrentDataSnapshot ? itemOptions : [], [hasCurrentDataSnapshot, itemOptions]);
  const visibleLines = useMemo(() => hasCurrentDataSnapshot ? lines : [], [hasCurrentDataSnapshot, lines]);

  function markDraftChanged() {
    const operation = operationRef.current;
    if (operation) operationRef.current = rotateHrRequestDraftKeys(operation, () => crypto.randomUUID());
  }

  function resetEntryForm() {
    operationRef.current = null;
    setRequestEntryState({ kind: "new" });
    setSubmissionRecovery(null);
    setCancelReason("");
    cancelKeyRef.current = null;
    setRequestNote("");
    setLines([]);
    setIncreases(Object.fromEntries(itemOptions.map((item) => [item.itemId, 0])));
  }

  function resetEntryAfterCancel() {
    resetEntryForm();
  }

  function startNextRequest() {
    resetEntryForm();
    setSubmitMessage("可建立下一筆人資需求。");
  }

  function reloadOperationalData() {
    if (client) invalidateMasterDataCache(client, "hr-request");
    setDataMessage("正在重新載入正式資料…");
    setDataReloadToken((current) => current + 1);
  }

  useEffect(() => {
    if (!client || !panelActive) return;
    const refreshOptionSnapshot = () => {
      invalidateMasterDataCache(client, "hr-request");
      setDataReloadToken((current) => current + 1);
    };
    window.addEventListener(inventoryDataChangedEvent, refreshOptionSnapshot);
    window.addEventListener(hrRequestWorkflowChangedEvent, refreshOptionSnapshot);
    return () => {
      window.removeEventListener(inventoryDataChangedEvent, refreshOptionSnapshot);
      window.removeEventListener(hrRequestWorkflowChangedEvent, refreshOptionSnapshot);
    };
  }, [client, panelActive]);

  useEffect(() => {
    if (!client || !panelActive || identityLoading) return;
    const supabase = client;
    let active = true;
    async function loadOperationalData() {
      setLoadingData(true);
      if (identityError || !accountId || !hasSession) {
        setDataMessage("目前登入帳號尚未完成工作區身份查核，請重新整理後再試；已填資料會保留。");
        setDataReady(false);
        setLoadingData(false);
        return;
      }
      const [masterData, orgData] = await Promise.all([
        loadHrRequestMasterData(supabase),
        loadOrganizationMasterData(supabase).catch(() => ({ institutions: [], departments: [], errors: [] })),
      ]);
      if (!active) return;
      if (masterData.errors.length > 0) {
        const preserveSnapshot = employeeOptionsRef.current.length > 0
          && itemOptionsRef.current.length > 0
          && shouldPreserveReadSnapshot(
            [...employeeOptionsRef.current, ...itemOptionsRef.current],
            masterData.errors,
          );
        if (!preserveSnapshot) {
          employeeOptionsRef.current = [];
          itemOptionsRef.current = [];
          setEmployeeOptions([]);
          setDepartmentOptions([]);
          setItemOptions([]);
          setLines([]);
          setIncreases({});
          dataSnapshotAccountIdRef.current = null;
          setDataSnapshotAccountId(null);
          setDataReady(false);
        }
        setDataMessage(preserveSnapshot
          ? staleReadSnapshotMessage("人資需求選項")
          : masterData.errors
          .some((error) => isSupabaseSessionSyncError(error))
          ? "登入狀態尚未同步，已重新整理登入狀態；請按「重新整理」再試，已填資料會保留。"
          : safeHrRequestMasterDataErrorMessage(masterData.errors)
        );
        setLoadingData(false);
        return;
      }
      const employeeRows = buildActiveHrEmployeeOptions(masterData.employees);
      const itemRows = masterData.items.map((row) => {
        return {
          itemId: row.id,
          itemCode: row.item_code,
          itemName: row.item_name,
          size: row.size ?? "",
          unit: row.unit,
          hrOnHand: Number(row.hr_on_hand_quantity ?? 0),
          generalOnHand: Number(row.general_on_hand_quantity ?? 0),
          activeReserved: Number(row.active_reserved_quantity ?? 0),
        };
      });
      const previousSnapshotAccountId = dataSnapshotAccountIdRef.current;
      const sameAccountSnapshot = previousSnapshotAccountId === accountId;
      if (employeeRows.length > 0 && itemRows.length > 0) {
        employeeOptionsRef.current = employeeRows;
        itemOptionsRef.current = itemRows;
        setEmployeeOptions(employeeRows);
        const orgDepartments = ((orgData?.departments ?? []) as { code: string; name: string; is_active: boolean }[])
          .filter((dept) => dept.is_active)
          .map((dept) => ({ code: dept.code, name: dept.name }));
        const deptMap = new Map<string, string>();
        for (const dept of orgDepartments) {
          deptMap.set(dept.code, dept.name);
        }
        for (const emp of employeeRows) {
          if (emp.departmentCode && !deptMap.has(emp.departmentCode)) {
            deptMap.set(emp.departmentCode, emp.departmentName || emp.departmentCode);
          }
        }
        setDepartmentOptions(Array.from(deptMap.entries()).map(([code, name]) => ({ code, name })));
        setItemOptions(itemRows);
        dataSnapshotAccountIdRef.current = accountId;
        setDataSnapshotAccountId(accountId);
        if (!sameAccountSnapshot && previousSnapshotAccountId !== null) {
          operationRef.current = null;
          cancelKeyRef.current = null;
          setRequestEntryState({ kind: "new" });
          setSubmissionRecovery(null);
          setCancelReason("");
          setRequestNote("");
        }
        setLines((current) => sameAccountSnapshot ? preserveHrRequestDraftLines(current, null) : []);
        setIncreases((current) => sameAccountSnapshot
          ? preserveHrRequestIncreaseDraft(current, itemRows.map((item) => item.itemId))
          : Object.fromEntries(itemRows.map((item) => [item.itemId, 0])));
        setDataMessage(`已載入 ${employeeRows.length} 位可申請員工、${itemRows.length} 個啟用品號（機構與部門均須啟用）`);
        setDataReady(true);
      } else {
        employeeOptionsRef.current = [];
        itemOptionsRef.current = [];
        setEmployeeOptions([]);
        setDepartmentOptions([]);
        setItemOptions([]);
        setLines([]);
        setIncreases({});
        dataSnapshotAccountIdRef.current = null;
        setDataSnapshotAccountId(null);
        setDataMessage("正式主檔沒有同時符合「在職員工、啟用機構、啟用部門」的員工或沒有啟用品號。");
        setDataReady(false);
      }
      setLoadingData(false);
    }
    void loadOperationalData();
    return () => { active = false; };
  }, [accountId, client, dataReloadToken, hasSession, identityError, identityLoading, panelActive]);

  const result = useMemo(() => {
    try {
      if (dataReadBlocked) {
        throw new HrRequestValidationError("員工與制服品號選項尚未載入，請稍候或重新整理資料");
      }
      const issueLines: IssueLineDraft[] = visibleLines.map((line) => ({
        ...line,
        employee: visibleEmployeeOptions.find((employee) => employee.employeeId === line.employeeId)!,
        item: visibleItemOptions.find((item) => item.itemId === line.itemId)!,
      }));
      if (issueLines.some((line) => !line.employee || !line.item)) {
        throw new HrRequestValidationError("員工或制服品號已不在目前可用清單，請重新載入後再送出");
      }
      const increaseLines = visibleItemOptions.map((item) => ({
        item,
        quantity: increases[item.itemId] ?? 0,
      }));
      return {
        summary: summarizeHrRequest(issueLines, increaseLines),
        error: "",
      };
    } catch (error) {
      return {
        summary: null,
        error:
          error instanceof HrRequestValidationError ? error.message : "需求單資料無法檢查",
      };
    }
  }, [dataReadBlocked, increases, visibleEmployeeOptions, visibleItemOptions, visibleLines]);

  function updateLine(lineId: string, field: "employeeId" | "itemId" | "quantity" | "departmentCode", value: string) {
    markDraftChanged();
    setLines((current) =>
      current.map((line) => {
        if (line.lineId !== lineId) return line;
        if (field === "quantity") {
          return { ...line, quantity: Number(value) || 0 };
        }
        if (field === "departmentCode") {
          const selectedEmployee = visibleEmployeeOptions.find((e) => e.employeeId === line.employeeId);
          const employeeStillValid = selectedEmployee && (!value || selectedEmployee.departmentCode === value);
          return {
            ...line,
            departmentCode: value,
            employeeId: employeeStillValid ? line.employeeId : "",
          };
        }
        if (field === "employeeId") {
          const selectedEmployee = visibleEmployeeOptions.find((e) => e.employeeId === value);
          return {
            ...line,
            employeeId: value,
            departmentCode: selectedEmployee?.departmentCode ?? line.departmentCode ?? "",
          };
        }
        return { ...line, [field]: value };
      }),
    );
  }

  function addLine() {
    const nextId = `line-${crypto.randomUUID()}`;
    if (dataReadBlocked || visibleEmployeeOptions.length === 0 || visibleItemOptions.length === 0) return;
    markDraftChanged();
    setLines((current) => [
      ...current,
      { lineId: nextId, employeeId: "", itemId: "", quantity: 1 },
    ]);
  }

  function removeLine(lineId: string) {
    markDraftChanged();
    setLines((current) => current.filter((line) => line.lineId !== lineId));
  }

  async function submitRequest() {
    if (!client) {
      setSubmitMessage("預覽模式：設定 Supabase env 並登入 HR 帳號後才能建立草稿與送出預留。");
      return;
    }
    if (dataReadBlocked && !submissionRecovery) {
      setSubmitMessage(dataMessage || "正式主檔尚未載入，暫時不能建立需求。");
      return;
    }
    if (!distributionDate && !submissionRecovery) {
      setSubmitMessage("請先填寫發放日期。");
      return;
    }
    if ((!result.summary || result.error) && !submissionRecovery) {
      setSubmitMessage("請先修正送出前檢查錯誤。");
      return;
    }
    setSubmitting(true);
    setSubmitMessage("");
    const operation = operationRef.current ?? createHrRequestOperation(() => crypto.randomUUID());
    operationRef.current = operation;
    const submissionRoute = resolveHrRequestSubmissionRoute(operation.draftId, requestEntryState);
    const issuePayload = visibleLines.map((line) => ({ employeeId: line.employeeId, itemId: line.itemId, quantity: line.quantity }));
    const increasePayload = visibleItemOptions
      .map((item) => ({ itemId: item.itemId, quantity: increases[item.itemId] ?? 0 }))
      .filter((line) => line.quantity > 0);
    const normalizedNote = requestNote.trim();
    if (submissionRoute.kind === "invalid") {
      const message = submissionRoute.reason === "missing-operation-id"
        ? "需求單識別資料遺失，請先從需求查詢重新開啟，不會另建一張需求。"
        : submissionRoute.reason === "request-id-mismatch"
          ? "需求單識別資料不一致，請重新載入需求資料後再試。"
          : "需求單狀態與識別資料不一致，請重新載入後再試。";
      setSubmitMessage(message);
      setSubmitting(false);
      return;
    }
    if (submissionRoute.kind === "submitted") {
      const updateResult = await client.rpc("update_hr_request", {
        p_request_id: submissionRoute.requestId,
        p_distribution_date: distributionDate,
        p_note: normalizedNote || null,
        p_issue_lines: issuePayload,
        p_increase_lines: increasePayload,
        p_idempotency_key: `UPDATE-${operation.updateKey}`,
        p_request_fingerprint: JSON.stringify({ requestId: submissionRoute.requestId, issuePayload, increasePayload, distributionDate, requestNote: normalizedNote }),
      });
      const updated = updateResult.data;
      if (!updateResult.error && updated?.id) {
        setRequestEntryState({ kind: "submitted", requestId: updated.id, editing: false });
        setSubmitMessage(`已更新 ${updated.request_no ?? "本張需求"}，庫存預留已重新驗證。`);
        window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
      } else {
        setSubmitMessage(safeSupabaseMutationErrorMessage(updateResult.error, "更新失敗或結果未知；請使用相同資料重試。"));
      }
      setSubmitting(false);
      return;
    }

    const submissionRequestId = submissionRoute.kind === "draft" ? submissionRoute.requestId : null;
    const nextSubmissionInput: HrRequestSubmissionInput = {
      requestId: submissionRequestId,
      requestNo: `HR-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
      distributionDate,
      note: normalizedNote,
      issueLines: issuePayload,
      increaseLines: increasePayload,
      createIdempotencyKey: `CREATE-${operation.createKey}`,
      createRequestFingerprint: JSON.stringify({ issuePayload, increasePayload, distributionDate, requestNote: normalizedNote }),
      updateIdempotencyKey: `UPDATE-${operation.updateKey}`,
      updateRequestFingerprint: JSON.stringify({ requestId: submissionRequestId, issuePayload, increasePayload, distributionDate, requestNote: normalizedNote }),
      submitIdempotencyKey: `SUBMIT-${operation.submitKey}`,
    };
    const submissionInput = submissionRecovery?.input ?? nextSubmissionInput;
    const submission = await submitHrRequestOperation(
      (functionName, args) => client.rpc(functionName, args),
      submissionInput,
      client,
    );
    setSubmissionRecovery(submission.outcomeUnknown ? { input: submissionInput } : null);
    const request = submission.request;
    if (request?.id) {
      operationRef.current = { ...operation, draftId: request.id };
      if (request.status === "DRAFT") {
        setRequestEntryState({ kind: "draft", requestId: request.id });
      } else if (request.status === "SUBMITTED") {
        setRequestEntryState({ kind: "submitted", requestId: request.id, editing: false });
      }
    }
    if (!submission.error && submission.failureStage === null && request?.status === "SUBMITTED") {
      setSubmitMessage(`已送出 ${request.request_no}，庫存預留已由伺服器重算。`);
      window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
    } else {
      const fallbackMessage = submission.failureStage === "create" || submission.failureStage === "update"
        ? "需求草稿建立或更新失敗；請使用相同資料重試。"
        : "送出失敗或結果未知；再次按下會沿用相同冪等鍵查回結果。";
      setSubmitMessage(safeSupabaseMutationErrorMessage(submission.error, fallbackMessage));
    }
    setSubmitting(false);
  }

  async function cancelRequest() {
    if (!client || requestEntryState.kind !== "draft") return;
    const draftId = requestEntryState.requestId;
    if (operationRef.current?.draftId !== draftId) return;
    if (!cancelReason.trim()) {
      setSubmitMessage("取消前請填寫原因。");
      return;
    }
    setSubmitting(true);
    setSubmitMessage("");
    const key = cancelKeyRef.current ?? crypto.randomUUID();
    cancelKeyRef.current = key;
    const { data, error } = await client.rpc("cancel_hr_request", {
      p_request_id: draftId,
      p_reason: cancelReason.trim(),
      p_idempotency_key: `CANCEL-HR-${key}`,
      p_request_fingerprint: JSON.stringify({ requestId: draftId, reason: cancelReason.trim() }),
    });
    if (error || !data?.id) {
      setSubmitMessage(safeSupabaseMutationErrorMessage(error, "取消失敗或結果未知；請使用相同原因重試。"));
    } else {
      cancelKeyRef.current = null;
      resetEntryAfterCancel();
      setSubmitMessage(`已取消 ${data.request_no ?? "本張需求"}，預留數量已釋放。`);
      window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
    }
    setSubmitting(false);
  }

  return (
    <section className="request-workbench" aria-label="人資需求單明細預覽">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">03 / HR REQUEST</p>
            <h2>員工明細與增庫</h2>
          </div>
          <div className="heading-actions">
            {!client ? <span className="status-pill">測試資料預覽</span> : null}
            {client ? <button className="secondary-button" type="button" onClick={reloadOperationalData} disabled={submitting}>{loadingData ? "讀取中…" : "重新載入資料"}</button> : null}
          </div>
        </div>

        <label className="field date-field"><span>發放日期</span><input type="date" value={distributionDate} onChange={(event) => { markDraftChanged(); setDistributionDate(event.target.value); }} disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)} required /></label>
        <label className="field"><span>備註（選填）</span><input value={requestNote} onChange={(event) => { markDraftChanged(); setRequestNote(event.target.value); }} disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)} maxLength={2000} placeholder="例如：新人報到／換季發放" /></label>
        <div className="request-table" role="table" aria-label="發放明細">
          <div className="request-table-row request-table-header" role="row">
            <span>員工／機構</span>
            <span>報局單位</span>
            <span>制服品號</span>
            <span>發放量 F</span>
            <span aria-hidden="true" />
          </div>
          {lines.map((line) => {
            const lineEmployees = line.departmentCode
              ? visibleEmployeeOptions.filter((employee) => employee.departmentCode === line.departmentCode)
              : visibleEmployeeOptions;
            return (
              <div className="request-table-row" role="row" key={line.lineId}>
                <label className="field">
                  <span className="sr-only">員工</span>
                  <select
                    value={line.employeeId}
                    onChange={(event) => updateLine(line.lineId, "employeeId", event.target.value)}
                    disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                  >
                    <option value="">請選擇員工</option>
                    {lineEmployees.map((employee) => (
                      <option key={employee.employeeId} value={employee.employeeId}>
                        {employee.employeeNo}｜{employee.employeeName}（{employee.institutionCode}/
                        {employee.departmentCode}）
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="sr-only">報局單位</span>
                  <select
                    value={line.departmentCode ?? ""}
                    onChange={(event) => updateLine(line.lineId, "departmentCode", event.target.value)}
                    disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                  >
                    <option value="">全部報局單位</option>
                    {visibleDepartmentOptions.map((dept) => (
                      <option key={dept.code} value={dept.code}>
                        {dept.code}｜{dept.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="sr-only">制服品號</span>
                  <select
                    value={line.itemId}
                    onChange={(event) => updateLine(line.lineId, "itemId", event.target.value)}
                    disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                  >
                    <option value="">請選擇制服品號</option>
                    {visibleItemOptions.map((item) => (
                      <option key={item.itemId} value={item.itemId}>
                        {item.itemCode}｜{item.itemName}（{item.size || "不分尺寸"}）
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="sr-only">發放量</span>
                  <input
                    min={1}
                    step={1}
                    type="number"
                    value={line.quantity}
                    onChange={(event) => updateLine(line.lineId, "quantity", event.target.value)}
                    disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                  />
                </label>
                <button className="text-button" type="button" onClick={() => removeLine(line.lineId)} disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}>
                  移除
                </button>
              </div>
            );
          })}
        </div>

        <button className="secondary-button" type="button" onClick={addLine} disabled={submitting || submissionRecovering || dataReadBlocked || (Boolean(submittedRequestId) && !editingSubmitted)}>
          ＋新增員工明細
        </button>
        <WorkflowActionBar
          primary={{
            onClick: () => void submitRequest(),
            busy: submitting,
            busyLabel: "送出中…",
            disabled: submitting || (!submissionRecovering && (dataReadBlocked || Boolean(result.error))) || (Boolean(submittedRequestId) && !editingSubmitted),
            label: submissionRecovering ? "以相同資料查回／重試送出" : submittedRequestId && !editingSubmitted ? "已送出並預留" : editingSubmitted ? "保存修改並重新驗證" : hasDraftOperation ? "重試送出（先保存草稿修改）" : "建立草稿並送出",
          }}
          secondary={submittedRequestId && !editingSubmitted || hasDraftOperation ? <>
            {submittedRequestId && !editingSubmitted ? <button className="secondary-button" type="button" onClick={() => { markDraftChanged(); setRequestEntryState((current) => current.kind === "submitted" ? { ...current, editing: true } : current); setSubmitMessage(""); }} disabled={submitting}>修改本張需求</button> : null}
            {submittedRequestId && !editingSubmitted ? <button className="secondary-button" type="button" onClick={startNextRequest} disabled={submitting}>建立下一筆需求</button> : null}
            {hasDraftOperation ? <div className="workflow-secondary-form">
              <label className="field"><span>取消原因（必填）</span><input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} disabled={submitting || submissionRecovering} maxLength={2000} placeholder="例如：資料重複／需求取消" /></label>
              <button className="secondary-button" type="button" onClick={() => void cancelRequest()} disabled={submitting || submissionRecovering}>取消本張需求</button>
            </div> : null}
          </> : null}
        />
        {dataMessage ? <p className="auth-message" role="status">{dataMessage}</p> : null}
        {submitMessage ? <p className={submitMessage.includes("已送出") || submitMessage.includes("已取消") ? "success-note" : "error-box"} role="status">{submitMessage}</p> : null}
        {submissionRecovering ? <p className="auth-message" role="status">伺服器結果尚未確認；為避免重複建立，欄位暫時鎖定。請按「以相同資料查回／重試送出」。</p> : null}

        <div className="increase-list">
          <div className="subheading">
            <h3>品號彙總增庫量 I</h3>
            <span>尺寸選填；庫存按品號獨立計算</span>
          </div>
            {visibleItemOptions.map((item) => (
            <label className="increase-row" key={item.itemId}>
              <span>
                {item.itemCode}｜{item.itemName}（{item.size || "不分尺寸"}）
                <small>
                  人資倉 {item.hrOnHand} ／總倉 {item.generalOnHand}／有效預留 {item.activeReserved}
                </small>
              </span>
              <input
                min={0}
                step={1}
                type="number"
                value={increases[item.itemId] ?? 0}
                onChange={(event) => {
                  markDraftChanged();
                  setIncreases((current) => ({
                    ...current,
                    [item.itemId]: Number(event.target.value) || 0,
                  }));
                }}
                disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                aria-label={`${item.itemCode} 增庫量`}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="panel result-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">04 / ITEM SUMMARY</p>
            <h2>送出前品號檢查</h2>
          </div>
          <div className="heading-actions">
            <span className={`status-pill ${dataReadBlocked || result.error ? "danger" : "success"}`}>
              {dataReadBlocked ? "等待主檔資料" : result.error ? "不可送出" : "可送出預覽"}
            </span>
            <button className="secondary-button print-button" type="button" onClick={() => window.print()}>
              列印 A4 預覽
            </button>
          </div>
        </div>
        {dataReadBlocked ? (
          <p className="empty-state">主檔資料載入後，這裡會顯示需求量、可用庫存與品號彙總。</p>
        ) : result.error ? (
          <div className="error-box" role="alert">
            <strong>這張需求單需要修正</strong>
            <span>{result.error}</span>
          </div>
        ) : (
          <>
            <div className="metric-grid">
              <Metric label="發放總量 F" value={result.summary?.totalIssueQuantity ?? 0} />
              <Metric label="增庫總量 I" value={result.summary?.totalIncreaseQuantity ?? 0} />
              <Metric
                label="合計調庫需求 R"
                value={result.summary?.totalRequestedTransferQuantity ?? 0}
              />
            </div>
            <div className="summary-list">
              {result.summary?.summaries.map((summary) => (
                <div className="summary-row" key={summary.item.itemId}>
                  <span>
                    <strong>{summary.item.itemCode}</strong>
                    <small>
                      {summary.item.itemName}／{summary.item.size || "不分尺寸"}
                    </small>
                  </span>
                  <span>F {summary.issueQuantity} ＋ I {summary.increaseQuantity}</span>
                  <strong>
                    R {summary.requestedTransferQuantity}／可用 {summary.availableToRequest}
                  </strong>
                </div>
              ))}
            </div>
            <p className="success-note">
              {previewMode
                ? "這是本機測試資料的送出前預覽；設定 Supabase env 並登入後才可建立正式需求。"
                : "正式送單會優先以單次 RPC 完成草稿與送出；資料庫仍會鎖定品號、重算兩倉合計並建立預留。"}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
