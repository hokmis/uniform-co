"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CorrectionHistoryTable from "@/src/app/CorrectionHistoryTable";
import { completeCorrectionOperation, correctionCompletionPlan, correctionPostRequestFingerprint } from "@/src/domain/correction-completion";
import { validateHrIssueCorrectionInput } from "@/src/domain/hr-issue-correction";
import type { CorrectionHistoryRow } from "@/src/domain/correction-history";
import type { AccountScopedReadOutcome } from "@/src/domain/account-scoped-read";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { loadCorrectionHistory } from "@/src/lib/correction-history-read";
import { useWorkspaceSession } from "./workspace-session";
import { useAccountScopedReadSnapshot } from "./use-account-scoped-read-snapshot";
import { workflowStatusLabel, workflowStatusTone } from "@/src/domain/workflow-status";
import { usePanelActivity } from "./RetainedPanelSet";
import { DEPARTMENT_BUTTON_ROWS } from "./HrRequestWorkbench";
import { resolveInstitutionInfo, ORDERED_INSTITUTION_NAMES, INSTITUTION_CODE_MAP } from "@/src/domain/hr-request-pivot-export";
import WorkflowActionBar from "./WorkflowActionBar";

type IssueLine = { id: string; request_id: string; request_no: string; line_no: number; employee_no_snapshot: string | null; employee_name_snapshot: string | null; item_code_snapshot: string | null; item_name_snapshot: string | null; quantity: number; department_code_snapshot?: string | null };
type Correction = { id: string; correction_no: string; status: "DRAFT" | "POSTED"; original_hr_request_id: string };
type History = { id: string; correction_no: string; status: string; reason: string; issue_quantity_delta: number; posted_at: string | null };

const STORAGE_PREFIX = "uniform:hr-issue-correction";
const EMPTY_ISSUE_LINES: IssueLine[] = [];

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

function parseUnitMap(reqId?: string, reqNo?: string): Record<string, string> {
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

type UnitBreakdownItem = {
  deptCode: string;
  itemId?: string;
  quantity: number;
  employeeId?: string;
};

function getLineDepartmentDisplay(line: IssueLine): string {
  // 1. 若為拆解明細（ID 帶有 __deptCode），優先取其專屬單位
  if (line.id.includes("__")) {
    const virtualDept = line.id.split("__")[1];
    const display = formatDepartmentDisplay(virtualDept) || formatDepartmentDisplay(line.department_code_snapshot);
    if (display) return display;
  }

  // 2. 若明細上有 department_code_snapshot
  if (line.department_code_snapshot) {
    const display = formatDepartmentDisplay(line.department_code_snapshot);
    if (display) return display;
  }

  // 3. 嘗試從 unitMap 讀取
  const unitMap = parseUnitMap(line.request_id, line.request_no);
  const rawDept = unitMap[String(line.line_no)] || unitMap["1"];
  if (rawDept) {
    const firstCode = rawDept.split(",")[0].trim();
    const display = formatDepartmentDisplay(firstCode);
    if (display) return display;
  }

  // 4. 從快照字串尋找單位線索
  const candidates = [
    line.employee_name_snapshot,
    line.employee_no_snapshot,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.toUpperCase().startsWith("AD2") || candidate.toUpperCase() === "AD2") continue;
    const formatted = formatDepartmentDisplay(candidate);
    if (formatted) return formatted;
  }

  return "福";
}

function parseItemNameAndSize(itemCode: string | null, itemName: string | null): { chineseName: string; size: string } {
  const code = itemCode ?? "";
  const name = itemName ?? "";

  const bracketMatch = name.match(/^(.*?)\s*[\(（]([A-Za-z0-9]+)[\)）]\s*$/);
  if (bracketMatch) {
    return {
      chineseName: bracketMatch[1].replace(/[-_][A-Za-z0-9]+$/, "").trim() || name,
      size: bracketMatch[2].toUpperCase(),
    };
  }

  const dashMatch = name.match(/^(.*?)[-_](XS|S|M|L|XL|2XL|3XL|4XL|5XL|6XL|F)$/i);
  if (dashMatch) {
    return {
      chineseName: dashMatch[1].trim() || name,
      size: dashMatch[2].toUpperCase(),
    };
  }

  const codeMatch = code.match(/(2XL|3XL|4XL|5XL|6XL|XS|XL|S|M|L|F)$/i);
  const size = codeMatch ? codeMatch[1].toUpperCase() : (name ? "常規" : "—");
  const chineseName = name.replace(/[-_\s]*(?:2XL|3XL|4XL|5XL|6XL|XS|XL|S|M|L|F)$/i, "").trim() || (name || code);

  return { chineseName, size };
}

export default function HrIssueCorrectionPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [filterText, setFilterText] = useState("");
  const [lineId, setLineId] = useState("");
  const [correctionNo, setCorrectionNo] = useState("");
  const [reason, setReason] = useState("");
  const [delta, setDelta] = useState(0);
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [busy, setBusy] = useState(false);
  const [completionUnresolved, setCompletionUnresolved] = useState(true);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const recoveredLineIdRef = useRef<string | null>(null);
  const readIssueLines = useCallback(async (): Promise<AccountScopedReadOutcome<IssueLine[]>> => {
    if (!client) return { status: "failure", errors: [], message: "已發放明細尚未連線。請登入後重試。" };
    const [sourceResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("v_hr_issue_correction_sources")
        .select("line_id,request_id,request_no,line_no,employee_no_snapshot,employee_name_snapshot,item_code,item_name,quantity")
        .order("distribution_date", { ascending: false })
        .order("request_no", { ascending: true })
        .order("line_no", { ascending: true })] as const,
    );
    if (sourceResult.error) {
      return { status: "failure", errors: [sourceResult.error], message: "已發放明細載入失敗，請確認 HR 角色與資料權限。" };
    }
    const sourceRows = (sourceResult.data ?? []) as Array<{
      line_id: string;
      request_id: string;
      request_no: string;
      line_no: number;
      employee_no_snapshot: string | null;
      employee_name_snapshot: string | null;
      item_code: string | null;
      item_name: string | null;
      quantity: number;
    }>;
    return {
      status: "success",
      data: sourceRows.map((row) => ({
        id: row.line_id,
        request_id: row.request_id,
        request_no: row.request_no,
        line_no: row.line_no,
        employee_no_snapshot: row.employee_no_snapshot,
        employee_name_snapshot: row.employee_name_snapshot,
        item_code_snapshot: row.item_code,
        item_name_snapshot: row.item_name,
        quantity: row.quantity,
      })),
      message: `已載入 ${sourceRows.length} 筆可更正的人資發放明細。`,
    };
  }, [client]);
  const {
    data: lines,
    hasCurrentSnapshot: sourceSnapshotReady,
    loading: dataLoading,
    message,
    setMessage,
  } = useAccountScopedReadSnapshot({
    accountId: accountId ?? null,
    enabled: identityReady,
    refreshKey: 0,
    emptyData: EMPTY_ISSUE_LINES,
    resourceLabel: "已發放明細",
    initialMessage: client ? "正在確認身份並載入可更正的人資發放明細…" : "設定 Supabase 並登入後，才能讀取可更正的人資發放明細。",
    read: readIssueLines,
  });
  const expandedLines: IssueLine[] = useMemo(() => {
    if (!lines || lines.length === 0) return [];

    const requestGroups = new Map<string, IssueLine[]>();
    for (const line of lines) {
      const groupKey = line.request_id || line.request_no;
      const group = requestGroups.get(groupKey) || [];
      group.push(line);
      requestGroups.set(groupKey, group);
    }

    const result: IssueLine[] = [];

    for (const [, reqLines] of requestGroups.entries()) {
      if (reqLines.length === 0) continue;
      const sample = reqLines[0];
      const unitMap = parseUnitMap(sample.request_id, sample.request_no);
      const unitBreakdown = parseUnitBreakdown(null, sample.request_id, sample.request_no);

      const allUnitMapDepts = Array.from(
        new Set(
          Object.values(unitMap)
            .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
            .map((s) => s.trim())
            .filter((s) => Boolean(formatDepartmentDisplay(s))),
        ),
      );

      for (let i = 0; i < reqLines.length; i++) {
        const dbLine = reqLines[i];
        const lineNoKey = String(dbLine.line_no ?? (i + 1));
        const rawDept = unitMap[lineNoKey]
          || (dbLine.line_no ? unitMap[String(dbLine.line_no)] : undefined)
          || unitMap[String(i + 1)];

        // 情況 A：存在具體 unitBreakdown
        if (unitBreakdown.length > 0) {
          if (reqLines.length === 1 && unitBreakdown.length > 1) {
            for (const m of unitBreakdown) {
              result.push({
                ...dbLine,
                id: `${dbLine.id}__${m.deptCode}`,
                quantity: m.quantity,
                department_code_snapshot: m.deptCode,
              });
            }
            continue;
          } else if (reqLines.length === 1 && unitBreakdown.length === 1) {
            const m = unitBreakdown[0];
            result.push({
              ...dbLine,
              quantity: m.quantity || dbLine.quantity,
              department_code_snapshot: m.deptCode || dbLine.department_code_snapshot,
            });
            continue;
          }
        }

        // 情況 B1：本行的 unitMap 記錄了多個單位（以逗號分隔，例如 "C8,C7" 或 "福,氣"）
        let deptsForLine: string[] = [];
        if (rawDept && rawDept.includes(",")) {
          deptsForLine = rawDept.split(",").map((s) => s.trim()).filter((s) => Boolean(formatDepartmentDisplay(s)));
        } else if ((!rawDept || !formatDepartmentDisplay(rawDept)) && reqLines.length === 1 && allUnitMapDepts.length > 1) {
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
    }

    return result;
  }, [lines]);

  const selectedLine = useMemo(() => expandedLines.find((line) => line.id === lineId), [expandedLines, lineId]);
  const validationError = validateHrIssueCorrectionInput({ issueQuantityDelta: delta, reason });
  const historyRows: CorrectionHistoryRow[] = useMemo(() => history.map((item) => ({
    id: item.id,
    correctionNo: item.correction_no,
    status: item.status,
    reason: item.reason,
    deltaText: String(item.issue_quantity_delta),
    postedAt: item.posted_at,
  })), [history]);

  useEffect(() => {
    if (!sourceSnapshotReady) return;
    const recoveredLineId = recoveredLineIdRef.current;
    setLineId((current) => {
      const nextId = (recoveredLineId && expandedLines.some((line) => line.id.split("__")[0] === recoveredLineId))
        ? (expandedLines.find((line) => line.id.split("__")[0] === recoveredLineId)?.id || recoveredLineId)
        : (expandedLines.some((line) => line.id === current) ? current : "");
      if (nextId && !correction) {
        const targetLine = expandedLines.find((line) => line.id === nextId);
        if (targetLine) {
          setCorrectionNo((prev) => prev || targetLine.request_no);
        }
      }
      return nextId;
    });
  }, [correction, expandedLines, sourceSnapshotReady]);

  useEffect(() => {
    if (!panelActive || !client || !hasSession || identityLoading || identityError || !accountId) return;
    const supabase = client;
    const savedCreateKey = window.localStorage.getItem(`${STORAGE_PREFIX}:create-key`);
    const savedPostKey = window.localStorage.getItem(`${STORAGE_PREFIX}:post-key`);
    const savedCorrectionId = window.localStorage.getItem(`${STORAGE_PREFIX}:id`);
    if (savedCreateKey) createKeyRef.current = savedCreateKey;
    if (savedPostKey) postKeyRef.current = savedPostKey;
    let active = true;
    async function recover() {
      if (!savedCorrectionId && !savedCreateKey && !savedPostKey) { setCompletionUnresolved(false); return; }
      const [statusResult] = await retrySupabaseQueriesAfterSessionRefresh(
        supabase,
        async () => [await supabase.rpc("get_hr_issue_correction_status", {
          p_correction_note_id: savedCorrectionId,
          p_create_idempotency_key: savedCreateKey ? `HR-ISSUE-CORRECTION-DRAFT-${savedCreateKey}` : null,
          p_post_idempotency_key: savedPostKey ? `POST-HR-ISSUE-CORRECTION-${savedPostKey}` : null,
        })] as const,
      );
      const { data, error } = statusResult;
      if (!active) return;
      if (error) { setMessage("更正結果尚未確認；欄位已暫時鎖定，請以相同操作重試。"); setCompletionUnresolved(true); return; }
      if (data?.id) {
        const recovered = data as Correction;
        setCorrection(recovered);
        setCorrectionNo(recovered.correction_no);
        setCompletionUnresolved(false);
        window.localStorage.setItem(`${STORAGE_PREFIX}:id`, recovered.id);
        const [lineResult] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("issue_correction_lines")
            .select("original_issue_line_id").eq("correction_note_id", recovered.id).maybeSingle()] as const,
        );
        const { data: line } = lineResult;
        if (line?.original_issue_line_id) {
          recoveredLineIdRef.current = line.original_issue_line_id as string;
          if (active) setLineId(line.original_issue_line_id as string);
        }
        setMessage("已恢復上一筆人資發放更正；請確認狀態後繼續。");
      } else {
        createKeyRef.current = null; postKeyRef.current = null;
        window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`);
        window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`);
        window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
        window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
        setCompletionUnresolved(false);
        setMessage("查無尚未完成的人資發放更正；已解除暫鎖，請重新選擇來源並填寫資料。");
      }
    }
    void recover();
    return () => { active = false; };
  }, [accountId, client, hasSession, identityError, identityLoading, panelActive, setMessage]);

  useEffect(() => {
    if (!panelActive || !client || !hasSession || identityLoading || identityError || !accountId || !selectedLine) return;
    const supabase = client;
    const sourceLine = selectedLine;
    const realLineId = sourceLine.id.split("__")[0];
    let active = true;
    async function loadHistory() {
      const result = await loadCorrectionHistory(supabase, { kind: "HR_ISSUE", parentId: sourceLine.request_id, lineId: realLineId });
      if (!active) return;
      if (result.error) { setMessage("人資發放更正歷史載入失敗，請重新整理後再試。"); return; }
      setHistory(result.data.map((row) => ({ id: row.id, correction_no: row.correction_no, status: row.status, reason: row.reason, issue_quantity_delta: row.delta, posted_at: row.posted_at })));
    }
    void loadHistory();
    return () => { active = false; };
  }, [accountId, client, hasSession, identityError, identityLoading, panelActive, selectedLine, setMessage]);

  function resetKeys() {
    setCompletionUnresolved(false);
    createKeyRef.current = null; postKeyRef.current = null;
    window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`);
    window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`);
    window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
  }
  function chooseLine(nextId: string) {
    recoveredLineIdRef.current = null;
    resetKeys(); window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
    setLineId(nextId); setCorrection(null);
    const targetLine = expandedLines.find((line) => line.id === nextId);
    setCorrectionNo(targetLine?.request_no ?? "");
    setReason(""); setDelta(0);
  }
  const filteredLines = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return expandedLines;
    return expandedLines.filter((line) => {
      const matchNo = line.request_no && line.request_no.toLowerCase().includes(query);
      const matchCode = line.item_code_snapshot && line.item_code_snapshot.toLowerCase().includes(query);
      const matchName = line.item_name_snapshot && line.item_name_snapshot.toLowerCase().includes(query);
      const dept = getLineDepartmentDisplay(line);
      const matchDept = dept && dept.toLowerCase().includes(query);
      return matchNo || matchCode || matchName || matchDept;
    });
  }, [expandedLines, filterText]);

  const effectiveCorrectionNo = (correctionNo.trim() || selectedLine?.request_no || "").trim();

  async function createDraft(keepBusy = false): Promise<Correction | null> {
    if (!client || !selectedLine) { setMessage("請先選擇已 SHIPPED 的人資發放明細。"); return null; }
    if (validationError || !effectiveCorrectionNo) { setMessage(validationError ?? "查無需求單號，無法建立更正單。"); return null; }
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID(); createKeyRef.current = key;
    window.localStorage.setItem(`${STORAGE_PREFIX}:create-key`, key);
    const realLineId = selectedLine.id.split("__")[0];
    const fingerprint = JSON.stringify({ lineId: realLineId, correctionNo: effectiveCorrectionNo, delta, reason: reason.trim() });
    const { data, error } = await client.rpc("create_hr_issue_correction_draft", {
      p_correction_no: effectiveCorrectionNo, p_original_issue_line_id: realLineId,
      p_issue_quantity_delta: delta, p_reason: reason.trim(), p_note: null,
      p_idempotency_key: `HR-ISSUE-CORRECTION-DRAFT-${key}`, p_request_fingerprint: fingerprint,
    });
    if (error || !data?.id) {
      setMessage(safeSupabaseMutationErrorMessage(error, "人資發放更正結果尚未確認；請使用相同操作重試。"));
      if (!keepBusy) setBusy(false);
      return null;
    }
    const created = data as Correction;
    setCorrection(created);
    window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); createKeyRef.current = null;
    window.localStorage.setItem(`${STORAGE_PREFIX}:id`, created.id); setMessage("人資發放更正草稿已建立；確認後送出。");
    if (!keepBusy) setBusy(false);
    return created;
  }
  async function postDraft(correctionToPost: Correction | null = correction): Promise<boolean> {
    if (!client || !correctionToPost || correctionToPost.status !== "DRAFT") return false;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID(); postKeyRef.current = key;
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-key`, key);
    const idempotencyKey = `POST-HR-ISSUE-CORRECTION-${key}`;
    const requestFingerprint = window.localStorage.getItem(`${STORAGE_PREFIX}:post-fingerprint`)
      ?? JSON.stringify({ correctionId: correctionToPost.id, correctionNo: correctionToPost.correction_no });
    const { data, error } = await client.rpc("post_hr_issue_correction", {
      p_correction_note_id: correctionToPost.id, p_idempotency_key: idempotencyKey,
      p_request_fingerprint: requestFingerprint,
    });
    if (error || !data?.id) {
      setMessage(safeSupabaseMutationErrorMessage(error, "人資發放更正結果尚未確認；請使用相同操作重試。"));
      setBusy(false);
      return false;
    }
    setCorrection(data as Correction); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`); postKeyRef.current = null;
    window.localStorage.setItem(`${STORAGE_PREFIX}:id`, correctionToPost.id); notifyInventoryDataChanged(); setMessage("人資發放更正已完成；有效發放量、退回上限與人資倉餘額已在同一交易重算。");
    setBusy(false);
    return true;
  }
  async function completeCorrection() {
    if (correction) {
      await postDraft(correction);
      return;
    }
    if (!client || !selectedLine || !effectiveCorrectionNo || validationError) return;
    setBusy(true); setMessage("");
    const createKey = createKeyRef.current ?? crypto.randomUUID();
    const postKey = postKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = createKey; postKeyRef.current = postKey;
    window.localStorage.setItem(`${STORAGE_PREFIX}:create-key`, createKey);
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-key`, postKey);
    const realLineId = selectedLine.id.split("__")[0];
    const payload = { lineId: realLineId, correctionNo: effectiveCorrectionNo, delta, reason: reason.trim() };
    const createIdempotencyKey = `HR-ISSUE-CORRECTION-DRAFT-${createKey}`;
    const createRequestFingerprint = JSON.stringify(payload);
    const postIdempotencyKey = `POST-HR-ISSUE-CORRECTION-${postKey}`;
    const postRequestFingerprint = correctionPostRequestFingerprint("POST_HR_ISSUE_CORRECTION", postIdempotencyKey);
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-fingerprint`, postRequestFingerprint);
    const createArgs = {
      p_correction_no: effectiveCorrectionNo, p_original_issue_line_id: realLineId,
      p_issue_quantity_delta: delta, p_reason: reason.trim(), p_note: null,
      p_idempotency_key: createIdempotencyKey, p_request_fingerprint: createRequestFingerprint,
    };
    const completionPlan = correctionCompletionPlan({
      atomicFunctionName: "complete_hr_issue_correction",
      createFunctionName: "create_hr_issue_correction_draft",
      createArgs,
      postFunctionName: "post_hr_issue_correction",
      postIdempotencyKey,
      postRequestFingerprint,
      postArgs: (correctionId) => ({
        p_correction_note_id: correctionId, p_idempotency_key: postIdempotencyKey,
        p_request_fingerprint: postRequestFingerprint,
      }),
    });
    const result = await completeCorrectionOperation((functionName, args) => client.rpc(functionName, args), client, completionPlan);
    if (result.correction?.status === "POSTED") {
      setCorrection(result.correction as Correction); createKeyRef.current = null; postKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
      window.localStorage.setItem(`${STORAGE_PREFIX}:id`, result.correction.id);
      setCompletionUnresolved(false); notifyInventoryDataChanged();
      setMessage("人資發放更正已完成；有效發放量、退回上限與人資倉餘額已在同一交易重算。");
    } else if (result.correction?.status === "DRAFT") {
      setCorrection(result.correction as Correction); createKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); window.localStorage.setItem(`${STORAGE_PREFIX}:id`, result.correction.id);
      setCompletionUnresolved(false);
      setMessage(result.error
        ? safeSupabaseMutationErrorMessage(result.error, "人資發放更正草稿已建立，完成結果尚未確認；請重試同一筆。")
        : "人資發放更正草稿已建立，完成結果尚未確認；請重試同一筆。");
    } else if (result.outcomeUnknown) {
      setCompletionUnresolved(true);
      setMessage("人資發放更正結果尚未確認；欄位已暫時鎖定，請按「重試同一筆」查回。");
    } else {
      createKeyRef.current = null; postKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
      setCompletionUnresolved(false);
      setMessage(safeSupabaseMutationErrorMessage(result.error, "人資發放更正建立或完成失敗；請檢查資料後重試。"));
    }
    setBusy(false);
  }
  function startAnother() {
    recoveredLineIdRef.current = null;
    resetKeys(); window.localStorage.removeItem(`${STORAGE_PREFIX}:id`); setLineId(""); setCorrection(null); setCorrectionNo(""); setReason(""); setDelta(0); setMessage("可建立下一筆人資發放更正。");
  }

  if (!client) return <section className="panel import-panel" aria-label="人資發放更正"><div className="panel-heading"><div><p className="eyebrow">16 / HR ISSUE CORRECTION</p><h2>人資發放更正</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 HR 帳號後，可選擇已發放明細建立具理由的更正單。</p></section>;
  const postedDelta = history.filter((item) => item.status === "POSTED").reduce((sum, item) => sum + item.issue_quantity_delta, 0);
  const sourceReadBlocked = dataLoading && !sourceSnapshotReady;

  const selectedDept = selectedLine ? getLineDepartmentDisplay(selectedLine) : "";
  const { chineseName, size: itemSize } = selectedLine
    ? parseItemNameAndSize(selectedLine.item_code_snapshot, selectedLine.item_name_snapshot)
    : { chineseName: "", size: "" };
  const cardContent = selectedLine
    ? `${selectedDept}, ${selectedLine.item_code_snapshot}, ${chineseName}、${itemSize}`
    : "請先選擇明細";

  return <section className="panel import-panel" aria-label="人資發放更正" aria-busy={busy || dataLoading}>
    <div className="panel-heading"><div><p className="eyebrow">16 / HR ISSUE CORRECTION</p><h2>人資發放更正</h2></div><span className={`status-pill ${workflowStatusTone(correction?.status)}`}>{completionUnresolved ? "結果待確認" : workflowStatusLabel(correction?.status)}</span></div>
    <p className="auth-message">更正只可指向已完成發放的明細；正數代表補登、負數代表沖回。送出時系統會鎖定品號、需求與原明細，重新計算可用數量與人資倉餘額。</p>
    <div className="form-grid">
      <div className="field">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <span>原始發放明細</span>
          {filterText ? (
            <span style={{ fontSize: "12px", color: "var(--text-muted, #888)" }}>
              已篩選 {filteredLines.length} / {expandedLines.length} 筆
            </span>
          ) : null}
        </div>
        <input
          type="text"
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          placeholder="輸入關鍵字篩選目前有的需求單號…"
          disabled={busy || completionUnresolved || sourceReadBlocked || Boolean(correction)}
          style={{ marginBottom: "6px" }}
        />
        <select
          value={lineId}
          onChange={(event) => chooseLine(event.target.value)}
          disabled={busy || completionUnresolved || sourceReadBlocked || Boolean(correction)}
        >
          <option value="">{sourceReadBlocked ? "載入發放明細中…" : filteredLines.length === 0 ? "無符合條件的發放明細" : "請選擇"}</option>
          {filteredLines.map((line) => {
            const deptDisplay = getLineDepartmentDisplay(line);
            return (
              <option key={line.id} value={line.id}>
                {line.request_no} ｜ {line.item_code_snapshot} ｜ {deptDisplay} ｜ 原發放 {line.quantity}。
              </option>
            );
          })}
        </select>
      </div>
      <div className="metric">
        <span>原始品號／人員</span>
        <strong>{cardContent}</strong>
      </div>
      <label className="field">
        <span>發放量差額</span>
        <input
          type="number"
          step={1}
          value={delta}
          onChange={(event) => { resetKeys(); setDelta(Number(event.target.value) || 0); }}
          disabled={busy || completionUnresolved || Boolean(correction)}
        />
      </label>
    </div>
    {selectedLine ? <div className="metric"><span>目前有效發放量（原始＋已完成更正）</span><strong>{selectedLine.quantity + postedDelta}</strong><small>{history.filter((item) => item.status === "POSTED").length > 0 ? `已有 ${history.filter((item) => item.status === "POSTED").length} 筆完成更正` : "尚無完成更正"}</small></div> : null}
    <CorrectionHistoryTable ariaLabel="人資發放更正歷史" rows={historyRows} deltaLabel="發放差額" />
    <label className="field reason-field"><span>更正原因</span><input value={reason} onChange={(event) => { resetKeys(); setReason(event.target.value); }} maxLength={500} disabled={busy || completionUnresolved || Boolean(correction)} placeholder="例如：補發一件制服" /></label>
    {dataLoading ? <p className="sr-only" role="status" aria-live="polite">正在讀取可更正的人資發放明細…</p> : null}
    {validationError ? <p className="auth-message">{validationError}</p> : null}
    <WorkflowActionBar
      primary={{
        onClick: () => void completeCorrection(),
        busy,
        busyLabel: "處理中…",
        disabled: busy || sourceReadBlocked || !selectedLine || !effectiveCorrectionNo || Boolean(validationError) || correction?.status === "POSTED",
        label: correction?.status === "POSTED" ? "已完成" : completionUnresolved ? "重試同一筆（結果待確認）" : "確認並完成更正",
      }}
      secondary={!correction
        ? <button className="secondary-button" type="button" onClick={() => void createDraft()} disabled={busy || completionUnresolved || sourceReadBlocked || !selectedLine}>{busy ? "建立中…" : sourceReadBlocked ? "載入來源中…" : "先建立更正草稿"}</button>
        : <button className="secondary-button" type="button" onClick={startAnother} disabled={busy}>建立另一筆更正</button>}
    />
    {correction ? <p className="success-note">更正單 {correction.correction_no}／{workflowStatusLabel(correction.status)}。{correction.status === "DRAFT" ? "確認差額與理由後即可送出。" : "更正已鎖定，不能再次修改。"}</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
