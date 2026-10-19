"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { completeReturnOperation, type ReturnRpcCall } from "@/src/domain/return-completion";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { workflowStatusLabel, workflowStatusTone } from "@/src/domain/workflow-status";
import { hasCurrentReadSnapshot, shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";
import { DEPARTMENT_BUTTON_ROWS } from "./HrRequestWorkbench";
import { resolveInstitutionInfo, ORDERED_INSTITUTION_NAMES, INSTITUTION_CODE_MAP } from "@/src/domain/hr-request-pivot-export";
import WorkflowActionBar from "./WorkflowActionBar";

type RequestRow = { id: string; request_no: string; distribution_date: string; note?: string | null };
type IssueLine = {
  id: string;
  item_id: string;
  employee_no_snapshot: string;
  employee_name_snapshot: string;
  item_code_snapshot: string;
  item_name_snapshot: string;
  size_snapshot: string | null;
  unit_snapshot: string;
  quantity: number;
  line_no?: number;
  department_code_snapshot?: string | null;
  department_name_snapshot?: string | null;
  institution_code_snapshot?: string | null;
  institution_name_snapshot?: string | null;
};
type ReturnNote = { id: string; return_no: string; status: "DRAFT" | "POSTED"; original_hr_request_id: string; return_date?: string; reason_code?: string };
type ReturnReasonCode = { code: string; label: string };

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

type UnitBreakdownItem = {
  deptCode: string;
  itemId: string;
  quantity: number;
  employeeId?: string;
};

function parseUnitMap(note?: string | null, reqId?: string, reqNo?: string): Record<string, string> {
  if (note) {
    const match = note.match(/<!--unit_map:([\s\S]*?)-->/);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {}
    }
  }
  if (typeof window !== "undefined") {
    try {
      if (reqId) {
        const cached = localStorage.getItem(`hr_request_units_${reqId}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && typeof parsed === "object") return parsed;
        }
      }
      if (reqNo) {
        const cached = localStorage.getItem(`hr_request_units_${reqNo}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && typeof parsed === "object") return parsed;
        }
      }
    } catch {}
  }
  return {};
}

function parseUnitBreakdown(note?: string | null, reqId?: string, reqNo?: string): UnitBreakdownItem[] {
  if (note) {
    const match = note.match(/<!--unit_breakdown:([\s\S]*?)-->/);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {}
    }
  }
  if (typeof window !== "undefined") {
    try {
      if (reqId) {
        const cached = localStorage.getItem(`hr_request_breakdown_${reqId}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      }
      if (reqNo) {
        const cached = localStorage.getItem(`hr_request_breakdown_${reqNo}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      }
    } catch {}
  }
  return [];
}

function formatDepartmentDisplay(codeOrName?: string | null): string | null {
  if (!codeOrName) return null;
  const trimmed = codeOrName.trim();
  if (!trimmed) return null;

  for (const row of DEPARTMENT_BUTTON_ROWS) {
    for (const btn of row) {
      if (btn.code.toUpperCase() === trimmed.toUpperCase() || btn.name === trimmed || btn.display === trimmed) {
        return btn.display;
      }
    }
  }

  const upper = trimmed.toUpperCase();
  if (INSTITUTION_CODE_MAP[upper]) {
    const sName = INSTITUTION_CODE_MAP[upper].shortName;
    return sName === "幼" ? "幼兒園" : sName;
  }

  const info = resolveInstitutionInfo(trimmed);
  if (info.shortName && info.shortName !== "其他" && info.shortName !== trimmed) {
    return info.shortName === "幼" ? "幼兒園" : info.shortName;
  }

  if (ORDERED_INSTITUTION_NAMES.includes(info.shortName as any)) {
    return info.shortName === "幼" ? "幼兒園" : info.shortName;
  }

  return null;
}

function getLineDepartmentDisplay(line: IssueLine, lineIndex: number, unitMap: Record<string, string>): string {
  // 1. 若為拆解明細（ID 帶有 __deptCode），優先取其專屬單位
  if (line.id.includes("__")) {
    const virtualDept = line.id.split("__")[1];
    const display = formatDepartmentDisplay(virtualDept) || formatDepartmentDisplay(line.department_code_snapshot);
    if (display) return display;
  }

  // 2. 從需求單的單位對照表（unitMap）獲取建立時選擇的報局單位
  const lineNoKey = String(line.line_no ?? (lineIndex + 1));
  const rawUnitMapDept = unitMap[lineNoKey]
    || (line.line_no ? unitMap[String(line.line_no)] : undefined)
    || unitMap[String(lineIndex + 1)];

  if (rawUnitMapDept) {
    const firstCode = rawUnitMapDept.split(",")[0].trim();
    const display = formatDepartmentDisplay(firstCode);
    if (display) return display;
  }

  // 3. 從明細的快照中依序尋找有效單位（過濾如 AD2 等非報局單位）
  const candidates = [
    line.institution_name_snapshot,
    line.institution_code_snapshot,
    line.department_name_snapshot,
    line.department_code_snapshot,
  ];
  for (const candidate of candidates) {
    const display = formatDepartmentDisplay(candidate);
    if (display) return display;
  }

  return "未指定單位";
}

function formatReturnErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;
  const msg = typeof error === "string" ? error : String((error as { message?: string })?.message || "");
  if (msg.includes("return_notes_return_no_key") || msg.includes("duplicate key")) {
    return "退回單號已存在；請修改退回單號（例如在單號後方加上序號 -2）後重試。";
  }
  if (msg.includes("Return quantity exceeds remaining issued quantity") || msg.includes("exceeds remaining")) {
    return "退回失敗：退回數量已超過該明細剩餘可退數量（該品項已全數退回）。若需調整退回量請至「退回更正」。";
  }
  if (msg.includes("Returns require a SHIPPED HR request")) {
    return "退回失敗：僅有「已發貨（SHIPPED）」狀態的需求單可進行退回。";
  }
  return safeSupabaseMutationErrorMessage(error as Parameters<typeof safeSupabaseMutationErrorMessage>[0], fallback);
}

export default function ReturnPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [issueLines, setIssueLines] = useState<IssueLine[]>([]);
  const [returnedQuantities, setReturnedQuantities] = useState<Record<string, number>>({});
  const [requestId, setRequestId] = useState("");
  const [selectedLineId, setSelectedLineId] = useState("");
  const [returnNo, setReturnNo] = useState("");
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [reasonCodes, setReasonCodes] = useState<ReturnReasonCode[]>([]);
  const [reasonCodesSnapshotAccountId, setReasonCodesSnapshotAccountId] = useState<string | null>(null);
  const [returnDate, setReturnDate] = useState(taipeiToday());
  const [note, setNote] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [returnNote, setReturnNote] = useState<ReturnNote | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [reasonCodesLoading, setReasonCodesLoading] = useState(false);
  const [linesLoading, setLinesLoading] = useState(false);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const postFingerprintRef = useRef<string | null>(null);
  const [dataSnapshotAccountId, setDataSnapshotAccountId] = useState<string | null>(null);
  const dataSnapshotAccountIdRef = useRef<string | null>(null);
  const requestsRef = useRef<RequestRow[]>([]);
  const issueLinesRef = useRef<IssueLine[]>([]);
  const reasonCodesRef = useRef<ReturnReasonCode[]>([]);
  const reasonCodesSnapshotAccountIdRef = useRef<string | null>(null);
  const requestIdRef = useRef("");

  const hasCurrentDataSnapshot = Boolean(
    identityReady
      && dataSnapshotAccountId
      && dataSnapshotAccountId === accountId,
  );
  const dataReadBlocked = !hasCurrentDataSnapshot;
  const visibleRequests = useMemo(() => hasCurrentDataSnapshot ? requests : [], [hasCurrentDataSnapshot, requests]);
  const hasCurrentReasonCodeSnapshot = hasCurrentReadSnapshot(identityReady, reasonCodesSnapshotAccountId, accountId);
  const visibleReasonCodes = hasCurrentReasonCodeSnapshot ? reasonCodes : [];
  const selectedRequest = visibleRequests.find((request) => request.id === requestId);
  const unitMap = useMemo(
    () => parseUnitMap(selectedRequest?.note, selectedRequest?.id, selectedRequest?.request_no),
    [selectedRequest?.id, selectedRequest?.note, selectedRequest?.request_no],
  );
  const unitBreakdown = useMemo(
    () => parseUnitBreakdown(selectedRequest?.note, selectedRequest?.id, selectedRequest?.request_no),
    [selectedRequest?.id, selectedRequest?.note, selectedRequest?.request_no],
  );
  const visibleIssueLines = useMemo(() => {
    if (!selectedRequest || issueLines.length === 0) return [];

    // 收集 unitMap 中所有的有效報局單位代碼
    const allUnitMapDepts = Array.from(
      new Set(
        Object.values(unitMap)
          .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
          .map((s) => s.trim())
          .filter((s) => Boolean(formatDepartmentDisplay(s))),
      ),
    );

    const result: IssueLine[] = [];
    for (let i = 0; i < issueLines.length; i++) {
      const dbLine = issueLines[i];
      const lineNoKey = String(dbLine.line_no ?? (i + 1));
      const rawDept = unitMap[lineNoKey]
        || (dbLine.line_no ? unitMap[String(dbLine.line_no)] : undefined)
        || unitMap[String(i + 1)];

      // 情況 A：存在具體 unitBreakdown（精確品號配對）
      const breakdownMatches = unitBreakdown.filter((b) => b.itemId === dbLine.item_id);
      if (breakdownMatches.length > 1) {
        for (const m of breakdownMatches) {
          result.push({
            ...dbLine,
            id: `${dbLine.id}__${m.deptCode}`,
            quantity: m.quantity,
            department_code_snapshot: m.deptCode,
          });
        }
        continue;
      } else if (breakdownMatches.length === 1) {
        const m = breakdownMatches[0];
        result.push({
          ...dbLine,
          quantity: m.quantity || dbLine.quantity,
          department_code_snapshot: m.deptCode || dbLine.department_code_snapshot,
        });
        continue;
      }

      // 情況 B1：本行的 unitMap 記錄了多個單位（以逗號分隔，例如 "C8,C7" 或 "福,氣"）
      let deptsForLine: string[] = [];
      if (rawDept && rawDept.includes(",")) {
        deptsForLine = rawDept.split(",").map((s) => s.trim()).filter((s) => Boolean(formatDepartmentDisplay(s)));
      } else if ((!rawDept || !formatDepartmentDisplay(rawDept)) && issueLines.length === 1 && allUnitMapDepts.length > 1) {
        // 情況 B2：整張需求單僅 1 筆彙總發放明細，但 unitMap 包含了多個報局單位（例如 {"1":"C8","2":"C7"}）
        deptsForLine = allUnitMapDepts;
      }

      if (deptsForLine.length > 1) {
        const baseQty = Math.floor(dbLine.quantity / deptsForLine.length);
        const remainder = dbLine.quantity % deptsForLine.length;
        for (let dIdx = 0; dIdx < deptsForLine.length; dIdx++) {
          const dept = deptsForLine[dIdx];
          const itemQty = baseQty + (dIdx < remainder ? 1 : 0);
          result.push({
            ...dbLine,
            id: `${dbLine.id}__${dept}`,
            quantity: itemQty,
            department_code_snapshot: dept,
          });
        }
        continue;
      }

      // 情況 C：單一單位
      const singleDept = rawDept ? rawDept.split(",")[0].trim() : (allUnitMapDepts[0] || "");
      result.push({
        ...dbLine,
        department_code_snapshot: singleDept || dbLine.department_code_snapshot,
      });
    }
    return result;
  }, [selectedRequest, issueLines, unitBreakdown, unitMap]);
  const selectedLine = visibleIssueLines.find((line) => line.id === selectedLineId);
  const selectedRealLineId = selectedLine ? selectedLine.id.split("__")[0] : "";
  const selectedReturned = selectedRealLineId ? (returnedQuantities[selectedRealLineId] ?? 0) : 0;
  const maxQuantity = selectedLine ? Math.max(0, selectedLine.quantity - selectedReturned) : 0;
  const dataLoading = requestsLoading || reasonCodesLoading || linesLoading;
  const transactionLoading = requestsLoading || linesLoading;
  const actionLoading = transactionLoading || (reasonCodesLoading && !hasCurrentReasonCodeSnapshot);
  const selectedReasonCodeIsCurrent = Boolean(
    hasCurrentReasonCodeSnapshot
      && reasonCode
      && visibleReasonCodes.some((code) => code.code === reasonCode),
  );
  const activeReturnNote = hasCurrentDataSnapshot ? returnNote : null;

  useEffect(() => {
    if (!identityReady || !client) return;
    const supabase = client;
    let active = true;
    async function load() {
      setRequestsLoading(true);
      try {
        const [result] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("hr_requests")
            .select("id,request_no,distribution_date,note")
            .eq("status", "SHIPPED")
            .order("distribution_date", { ascending: false })] as const,
        );
        if (!active) return;
        if (result.error) {
          const preserveSnapshot = dataSnapshotAccountIdRef.current === accountId
            && shouldPreserveReadSnapshot(requestsRef.current, [result.error]);
          if (!preserveSnapshot) {
            requestsRef.current = [];
            issueLinesRef.current = [];
            setRequests([]);
            setIssueLines([]);
            setLinesLoading(false);
            setRequestId("");
            requestIdRef.current = "";
            setSelectedLineId("");
            dataSnapshotAccountIdRef.current = null;
            setDataSnapshotAccountId(null);
          }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("已發貨需求")
            : `已發貨需求載入失敗：${safeSupabaseReadErrorMessage(result.error)}`);
          return;
        }
        const loaded = (result.data ?? []) as RequestRow[];
        const previousSnapshotAccountId = dataSnapshotAccountIdRef.current;
        const sameAccountSnapshot = previousSnapshotAccountId === accountId;
        if (!sameAccountSnapshot) {
          createKeyRef.current = null;
          postKeyRef.current = null;
          setReturnNote(null);
          setIssueLines([]);
          setLinesLoading(false);
          setSelectedLineId("");
          setReturnNo("");
          setReason("");
          setReasonCode("");
          setNote("");
          setQuantity(1);
        }
        requestsRef.current = loaded;
        setRequests(loaded);
        dataSnapshotAccountIdRef.current = accountId;
        setDataSnapshotAccountId(accountId);
        const nextRequestId = sameAccountSnapshot && loaded.some((request) => request.id === requestIdRef.current) ? requestIdRef.current : "";
        requestIdRef.current = nextRequestId;
        setRequestId(nextRequestId);
        if (nextRequestId) {
          const matched = loaded.find((r) => r.id === nextRequestId);
          if (matched) setReturnNo((prev) => prev || `RET-${matched.request_no}`);
        }
        if (!nextRequestId || loaded.length === 0) { issueLinesRef.current = []; setIssueLines([]); setLinesLoading(false); setSelectedLineId(""); }
      } finally {
        if (active) setRequestsLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accountId, client, identityReady, reloadToken]);

  useEffect(() => {
    if (!identityReady || !client || !accountId) return;
    const supabase = client;
    const activeAccountId = accountId;
    let active = true;
    async function loadReasonCodes() {
      if (reasonCodesSnapshotAccountIdRef.current !== activeAccountId) {
        reasonCodesRef.current = [];
        setReasonCodes([]);
        reasonCodesSnapshotAccountIdRef.current = null;
        setReasonCodesSnapshotAccountId(null);
        setReasonCode("");
      }
      setReasonCodesLoading(true);
      try {
        const [result] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("return_reason_codes").select("code,label").eq("is_active", true).order("sort_order")] as const,
        );
        if (!active) return;
        if (result.error) {
          const preserveSnapshot = reasonCodesSnapshotAccountIdRef.current === activeAccountId
            && shouldPreserveReadSnapshot(reasonCodesRef.current, [result.error]);
          if (!preserveSnapshot) {
            reasonCodesRef.current = [];
            setReasonCodes([]);
            reasonCodesSnapshotAccountIdRef.current = null;
            setReasonCodesSnapshotAccountId(null);
            setReasonCode("");
          }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("退回原因碼")
            : `退回原因碼載入失敗：${safeSupabaseReadErrorMessage(result.error)}`);
          return;
        }
        const loaded = (result.data ?? []) as ReturnReasonCode[];
        reasonCodesRef.current = loaded;
        setReasonCodes(loaded);
        reasonCodesSnapshotAccountIdRef.current = activeAccountId;
        setReasonCodesSnapshotAccountId(activeAccountId);
        setReasonCode((current) => loaded.some((code) => code.code === current) ? current : "");
      } finally {
        if (active) setReasonCodesLoading(false);
      }
    }
    void loadReasonCodes();
    return () => { active = false; };
  }, [accountId, client, identityReady]);

  useEffect(() => {
    if (!identityReady || !client || !requestId || !visibleRequests.some((request) => request.id === requestId) || returnNote) return;
    const supabase = client;
    let active = true;
    async function loadLines() {
      setLinesLoading(true);
        const [result, returnResult] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [
            await supabase.from("hr_issue_lines")
              .select("id,item_id,employee_no_snapshot,employee_name_snapshot,item_code_snapshot,item_name_snapshot,size_snapshot,unit_snapshot,quantity,line_no,department_code_snapshot,department_name_snapshot,institution_code_snapshot,institution_name_snapshot")
              .eq("request_id", requestId).order("line_no"),
            await supabase.from("v_return_correction_sources")
              .select("return_no,original_issue_line_id,quantity")
              .eq("original_hr_request_id", requestId),
          ] as const,
        );
        if (!active) return;
        if (result.error) {
          const preserveSnapshot = dataSnapshotAccountIdRef.current === accountId
            && shouldPreserveReadSnapshot(issueLinesRef.current, [result.error]);
          if (!preserveSnapshot) { issueLinesRef.current = []; setIssueLines([]); setSelectedLineId(""); }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("發放明細")
            : `發放明細載入失敗：${safeSupabaseReadErrorMessage(result.error)}`);
          return;
        }
        const loaded = (result.data ?? []) as IssueLine[];
        issueLinesRef.current = loaded;
        setIssueLines(loaded);
        setSelectedLineId((current) => loaded.some((line) => line.id === current) ? current : "");
        setQuantity(1);

        const returnMap: Record<string, number> = {};
        const existingNos = new Set<string>();
        for (const row of ((returnResult?.data ?? []) as Array<{ return_no: string; original_issue_line_id: string; quantity: number }>)) {
          if (row.original_issue_line_id) {
            returnMap[row.original_issue_line_id] = (returnMap[row.original_issue_line_id] ?? 0) + (row.quantity ?? 0);
          }
          if (row.return_no) {
            existingNos.add(row.return_no.trim().toUpperCase());
          }
        }
        setReturnedQuantities(returnMap);

        const currentReq = visibleRequests.find((r) => r.id === requestId);
        if (currentReq) {
          const baseNo = `RET-${currentReq.request_no}`;
          let cand = baseNo;
          let seq = 2;
          while (existingNos.has(cand.toUpperCase())) {
            cand = `${baseNo}-${seq}`;
            seq++;
          }
          setReturnNo(cand);
        }
      } finally {
        if (active) setLinesLoading(false);
      }
    }
    void loadLines();
    return () => { active = false; };
  }, [accountId, client, identityReady, requestId, returnNote, visibleRequests]);

  function resetKeys() { createKeyRef.current = null; postKeyRef.current = null; postFingerprintRef.current = null; }
  function chooseRequest(nextId: string) {
    if (returnNote) return;
    resetKeys();
    const req = visibleRequests.find((request) => request.id === nextId);
    requestIdRef.current = nextId; setRequestId(nextId); setLinesLoading(false);
    setReturnDate(taipeiToday());
    setReturnNo(req ? `RET-${req.request_no}` : "");
    issueLinesRef.current = [];
    setIssueLines([]);
    setReturnedQuantities({});
    setSelectedLineId("");
    setQuantity(1);
  }
  function chooseLine(nextId: string) {
    if (returnNote) return;
    resetKeys();
    setSelectedLineId(nextId);
    const line = visibleIssueLines.find((l) => l.id === nextId);
    const realLineId = line ? line.id.split("__")[0] : "";
    const returned = realLineId ? (returnedQuantities[realLineId] ?? 0) : 0;
    const rem = line ? Math.max(0, line.quantity - returned) : 0;
    setQuantity(rem > 0 ? 1 : 0);
  }

  function startNextReturn() {
    resetKeys();
    setReturnNote(null);
    requestIdRef.current = "";
    setRequestId("");
    issueLinesRef.current = [];
    setIssueLines([]); setLinesLoading(false);
    setSelectedLineId("");
    setReturnNo("");
    setReason("");
    setReasonCode("");
    setReturnDate(taipeiToday());
    setNote("");
    setQuantity(1);
    setReloadToken((value) => value + 1);
    setMessage("本筆退回已完成，可以選擇下一筆已發貨需求。");
  }

  const fingerprint = useMemo(() => JSON.stringify({ requestId, returnDate, reasonCode, returnNo: returnNo.trim(), reason: reason.trim(), note: note.trim(), lineId: selectedLineId, quantity }), [requestId, returnDate, reasonCode, returnNo, reason, note, selectedLineId, quantity]);

  async function createDraft(keepBusy = false): Promise<ReturnNote | null> {
    if (!identityReady || dataReadBlocked || !client || !requestId || !selectedLine || !returnNo.trim() || !reason.trim() || !selectedReasonCodeIsCurrent || !returnDate || maxQuantity === 0 || quantity < 1 || quantity > maxQuantity) {
      if (maxQuantity === 0) {
        setMessage("該明細已全數退回，無剩餘可退數量。若需調整退回量請至「人資發放、退回更正」➔「退回更正」。");
      } else {
        setMessage("請選擇已發貨需求與發放明細，填寫日期、退回原因碼、退回單號與理由，且退回量不得超過原發放量。");
      }
      return null;
    }
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = key;
    const { data, error } = await client.rpc("create_return_note_draft", {
      p_return_no: returnNo.trim(), p_original_hr_request_id: requestId,
      p_return_date: returnDate, p_reason_code: reasonCode,
      p_reason: reason.trim(), p_note: note.trim() || null,
      p_lines: [{ originalIssueLineId: selectedLine.id.split("__")[0], quantity }],
      p_idempotency_key: `CREATE-RETURN-V2-${key}`, p_request_fingerprint: fingerprint,
    });
    if (error || !data?.id) {
      setMessage(formatReturnErrorMessage(error, "退回草稿建立失敗；請使用相同資料重試。"));
      if (!keepBusy) setBusy(false);
      return null;
    }
    const createdReturnNote = data as ReturnNote;
    setReturnNote(createdReturnNote);
    createKeyRef.current = null;
    setMessage(`已建立退回草稿 ${createdReturnNote.return_no}；確認數量與原因後送出。`);
    if (!keepBusy) setBusy(false);
    return createdReturnNote;
  }

  async function postReturn(returnNoteToPost: ReturnNote | null = returnNote): Promise<boolean> {
    if (!identityReady || dataReadBlocked || !client || !returnNoteToPost) return false;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID();
    postKeyRef.current = key;
    const requestFingerprint = postFingerprintRef.current
      ?? JSON.stringify({ returnNoteId: returnNoteToPost.id, returnNo: returnNoteToPost.return_no });
    postFingerprintRef.current = requestFingerprint;
    const { data, error } = await client.rpc("post_return_note", {
      p_return_note_id: returnNoteToPost.id,
      p_idempotency_key: `POST-RETURN-${key}`,
      p_request_fingerprint: requestFingerprint,
    });
    if (error) {
      setMessage(formatReturnErrorMessage(error, "退回送出失敗；請使用相同草稿重試。"));
      setBusy(false);
      return false;
    }
    setReturnNote(data as ReturnNote);
    postKeyRef.current = null;
    postFingerprintRef.current = null;
    notifyInventoryDataChanged();
    setMessage("退回已完成；人資倉已增加退回數量，原發放單與退回紀錄均已鎖定。");
    setBusy(false);
    return true;
  }

  async function completeReturn() {
    if (returnNote) {
      await postReturn(returnNote);
      return;
    }
    if (!identityReady || dataReadBlocked || !client || !requestId || !selectedLine || !returnNo.trim()
      || !reason.trim() || !selectedReasonCodeIsCurrent || !returnDate || maxQuantity === 0 || quantity < 1 || quantity > maxQuantity) {
      if (maxQuantity === 0) {
        setMessage("該明細已全數退回，無剩餘可退數量。若需調整退回量請至「人資發放、退回更正」➔「退回更正」。");
      } else {
        setMessage("請選擇已發貨需求與發放明細，填寫日期、退回原因碼、退回單號與理由，且退回量不得超過原發放量。");
      }
      return;
    }

    setBusy(true);
    setMessage("");
    const createKey = createKeyRef.current ?? crypto.randomUUID();
    const postKey = postKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = createKey;
    postKeyRef.current = postKey;
    const createIdempotencyKey = `CREATE-RETURN-V2-${createKey}`;
    const postIdempotencyKey = `POST-RETURN-${postKey}`;
    const postRequestFingerprint = postFingerprintRef.current
      ?? JSON.stringify({ operationCode: "POST_RETURN_NOTE", createIdempotencyKey });
    postFingerprintRef.current = postRequestFingerprint;
    const rpc = (client as unknown as { rpc: ReturnRpcCall }).rpc.bind(client);
    const result = await completeReturnOperation(rpc, client, {
      returnNo: returnNo.trim(),
      originalHrRequestId: requestId,
      returnDate,
      reasonCode,
      reason: reason.trim(),
      note: note.trim() || null,
      lines: [{ originalIssueLineId: selectedLine.id.split("__")[0], quantity }],
      createIdempotencyKey,
      createRequestFingerprint: fingerprint,
      postIdempotencyKey,
      postRequestFingerprint,
    });

    if (result.returnNote?.status === "DRAFT") {
      setReturnNote(result.returnNote);
      createKeyRef.current = null;
      setMessage(result.error
        ? formatReturnErrorMessage(result.error, "退回草稿已保存，但送出尚未完成；請使用同一草稿重試。")
        : "退回草稿已保存，但完成狀態尚未確認；請保留同一草稿並重試。",
      );
      setBusy(false);
      return;
    }

    if (result.error || result.failureStage || !result.returnNote || result.returnNote.status !== "POSTED") {
      setMessage(result.error
        ? formatReturnErrorMessage(result.error, "退回完成狀態尚未確認；請保留目前資料並用相同內容重試。")
        : "退回完成狀態尚未確認；請保留目前資料並用相同內容重試。",
      );
      setBusy(false);
      return;
    }

    if (result.returnNote && selectedLine) {
      const deptDisplay = getLineDepartmentDisplay(selectedLine, visibleIssueLines.indexOf(selectedLine), unitMap);
      if (deptDisplay && typeof window !== "undefined") {
        try {
          localStorage.setItem(`return_unit_${result.returnNote.return_no}`, deptDisplay);
          localStorage.setItem(`return_unit_${result.returnNote.id}`, deptDisplay);
          localStorage.setItem(`return_line_dept_${result.returnNote.return_no}_${selectedLine.id.split("__")[0]}`, deptDisplay);
        } catch {}
      }
    }

    setReturnNote(result.returnNote);
    resetKeys();
    notifyInventoryDataChanged();
    setMessage("退回已完成；人資倉已增加退回數量，原發放單與退回紀錄均已鎖定。");
    setBusy(false);
  }

  async function updateDraft() {
    if (!identityReady || dataReadBlocked || !client || !returnNote || returnNote.status !== "DRAFT" || !selectedLine) return;
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = key;
    const { data, error } = await client.rpc("update_return_note_draft", {
      p_return_note_id: returnNote.id, p_reason: reason.trim(), p_note: note.trim() || null,
      p_lines: [{ originalIssueLineId: selectedLine.id.split("__")[0], quantity }],
      p_idempotency_key: `UPDATE-RETURN-${key}`,
      p_request_fingerprint: JSON.stringify({ returnNoteId: returnNote.id, lineId: selectedLine.id.split("__")[0], quantity, reason: reason.trim(), note: note.trim() }),
    });
    if (error || !data?.id) setMessage(safeSupabaseMutationErrorMessage(error, "退回草稿結果尚未確認；請使用相同操作重試。"));
    else { setReturnNote(data as ReturnNote); createKeyRef.current = null; setMessage("退回草稿已更新；確認後送出。"); }
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="員工制服退回"><div className="panel-heading"><div><p className="eyebrow">09 / RETURN</p><h2>員工制服退回</h2><p style={{ margin: "4px 0 0", fontSize: "14px", color: "var(--muted, #64748b)" }}>處理離職繳回與瑕疵換退</p></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 HR 帳號後，選擇已發貨需求與原發放明細，建立退回草稿並送回人資倉。</p></section>;
  return <section className="panel import-panel" aria-label="員工制服退回" aria-busy={dataLoading}>
    <div className="panel-heading"><div><p className="eyebrow">09 / RETURN</p><h2>員工制服退回</h2><p style={{ margin: "4px 0 0", fontSize: "14px", color: "var(--muted, #64748b)" }}>處理離職繳回與瑕疵換退</p></div><span className={`status-pill ${workflowStatusTone(activeReturnNote?.status)}`}>{workflowStatusLabel(activeReturnNote?.status, "建立退回")}</span></div>
    <p className="auth-message">退回只接受已發貨需求；送出時系統會檢查可退數量、鎖定品號並增加人資倉，原發放單不會被改寫。</p>
    {dataLoading ? <p className="auth-message" role="status" aria-live="polite">正在載入可退回需求、原因碼或發放明細；日期、單號與理由仍可先填寫。</p> : null}
    <div className="form-grid">
      <label className="field"><span>已發貨需求</span><select value={dataReadBlocked ? "" : requestId} onChange={(event) => chooseRequest(event.target.value)} disabled={busy || dataReadBlocked || Boolean(activeReturnNote)}><option value="">{requestsLoading && dataReadBlocked ? "載入需求中…" : "請選擇"}</option>{visibleRequests.map((request) => <option key={request.id} value={request.id}>{request.request_no}｜{request.distribution_date}</option>)}</select></label>
      <label className="field"><span>原發放明細</span><select value={dataReadBlocked ? "" : selectedLineId} onChange={(event) => chooseLine(event.target.value)} disabled={busy || dataReadBlocked || linesLoading || Boolean(activeReturnNote) || !selectedRequest}><option value="">{linesLoading ? "載入明細中…" : "請選擇"}</option>{visibleIssueLines.map((line, index) => {
        const deptDisplay = getLineDepartmentDisplay(line, index, unitMap);
        const sizeStr = line.size_snapshot ? ` (${line.size_snapshot})` : "";
        const realLineId = line.id.split("__")[0];
        const lineReturned = returnedQuantities[realLineId] ?? 0;
        const lineRemaining = Math.max(0, line.quantity - lineReturned);
        const statusLabel = lineRemaining === 0 ? "（已全數退回）" : lineReturned > 0 ? `（可退 ${lineRemaining}／已退 ${lineReturned}）` : `（可退 ${lineRemaining}）`;
        return (
          <option key={line.id} value={line.id}>
            {deptDisplay}｜{line.item_code_snapshot} {line.item_name_snapshot}{sizeStr}｜原發 {line.quantity} {statusLabel}
          </option>
        );
      })}</select></label>
      <label className="field"><span>退回日期</span><input type="date" value={returnDate} readOnly disabled={true} style={{ backgroundColor: "var(--surface-muted, #f1f5f9)", cursor: "not-allowed", color: "var(--ink-muted, #64748b)" }} title="退回日期固定為今日，不可修改" /></label>
      <label className="field"><span>退回單號</span><input value={returnNo} onChange={(event) => { resetKeys(); setReturnNo(event.target.value); }} disabled={busy || Boolean(activeReturnNote)} maxLength={80} placeholder="選擇需求單後自動帶入（如 RET-REQ-xxx）" /></label>
      <label className="field"><span>退回原因碼</span><select value={reasonCode} onChange={(event) => { resetKeys(); setReasonCode(event.target.value); }} disabled={busy || !hasCurrentReasonCodeSnapshot || visibleReasonCodes.length === 0 || Boolean(activeReturnNote)}><option value="">{reasonCodesLoading && !hasCurrentReasonCodeSnapshot ? "載入原因碼中…" : visibleReasonCodes.length ? "請選擇" : "目前沒有可用原因碼"}</option>{visibleReasonCodes.map((code) => <option key={code.code} value={code.code}>{code.code}｜{code.label}</option>)}</select></label>
      <label className="field"><span>退回數量{maxQuantity === 0 ? "（已全數退回）" : `（上限 ${maxQuantity}）`}</span><input type="number" min={maxQuantity === 0 ? 0 : 1} max={maxQuantity} value={maxQuantity === 0 ? 0 : quantity} onChange={(event) => { resetKeys(); setQuantity(Math.min(maxQuantity || 1, Math.max(1, Number(event.target.value) || 1))); }} disabled={busy || maxQuantity === 0 || activeReturnNote?.status === "POSTED"} /></label>
    </div>
    <label className="field reason-field"><span>退回原因</span><input value={reason} onChange={(event) => { resetKeys(); setReason(event.target.value); }} disabled={busy || activeReturnNote?.status === "POSTED"} maxLength={1000} placeholder="例如：離職／尺寸不合／制服汰換" /></label>
    <label className="field reason-field"><span>備註（選填）</span><input value={note} onChange={(event) => { resetKeys(); setNote(event.target.value); }} disabled={busy || activeReturnNote?.status === "POSTED"} maxLength={2000} /></label>
    {selectedLine ? (
      maxQuantity === 0 ? (
        <p className="auth-message" style={{ margin: "12px 0 0" }}>
          ⚠️ <strong>此明細已全數退回</strong>：{selectedRequest?.request_no}／單位：{getLineDepartmentDisplay(selectedLine, visibleIssueLines.indexOf(selectedLine), unitMap)}／{selectedLine.item_code_snapshot} {selectedLine.item_name_snapshot}{selectedLine.size_snapshot ? `（${selectedLine.size_snapshot}）` : ""}，原發放 {selectedLine.quantity} 件，累計已退回 {selectedReturned} 件，剩餘可退 0 件。若需調整或抽回退回數量，請至「<strong>人資發放、退回更正</strong>」➔「<strong>退回更正</strong>」處理。
        </p>
      ) : (
        <p className="success-note">
          {selectedRequest?.request_no}／單位：{getLineDepartmentDisplay(selectedLine, visibleIssueLines.indexOf(selectedLine), unitMap)}／{selectedLine.item_code_snapshot} {selectedLine.item_name_snapshot}{selectedLine.size_snapshot ? `（${selectedLine.size_snapshot}）` : ""}，原發放 {selectedLine.quantity} {selectedLine.unit_snapshot}（已退 {selectedReturned} 件，剩餘可退 {maxQuantity} 件）。
        </p>
      )
    ) : null}
    <WorkflowActionBar
      primary={{
        onClick: () => void completeReturn(),
        busy,
        busyLabel: "處理中…",
        disabled: busy || dataReadBlocked || actionLoading || !selectedLine || !returnNo.trim() || !reason.trim() || !selectedReasonCodeIsCurrent || !returnDate || quantity < 1 || quantity > maxQuantity || maxQuantity === 0 || activeReturnNote?.status === "POSTED",
        label: activeReturnNote?.status === "DRAFT" ? "確認並完成退回" : activeReturnNote?.status === "POSTED" ? "已完成" : "確認並完成退回",
      }}
      secondary={!activeReturnNote
        ? <button className="secondary-button" type="button" onClick={() => void createDraft()} disabled={busy || dataReadBlocked || actionLoading || !selectedLine || !selectedReasonCodeIsCurrent}>{busy ? "建立中…" : actionLoading ? "載入必要資料中…" : "先保存退回草稿"}</button>
        : activeReturnNote.status === "DRAFT"
          ? <button className="secondary-button" type="button" onClick={() => void updateDraft()} disabled={busy || !selectedLine}>{busy ? "保存中…" : "保存退回草稿"}</button>
          : <button className="secondary-button" type="button" onClick={startNextReturn} disabled={busy}>處理下一筆</button>}
    />
    {activeReturnNote?.status === "POSTED" ? <p className="success-note">退回單 {activeReturnNote.return_no} 已完成，原單維持不變且本次退回不可再修改。</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
