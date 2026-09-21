"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "@/src/app/ManagementCatalogTable";
import { filterSeasonalApprovalQueue, sortSeasonalApprovalQueue, type SeasonalApprovalQueueRow, type SeasonalApprovalSortDirection, type SeasonalApprovalSortKey } from "@/src/domain/seasonal-approval";
import { createReadRequestController, shouldPreserveReadSnapshot, staleReadSnapshotMessage, type ReadRequestController } from "@/src/domain/read-refresh";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

type Submission = { id: string; campaign_id: string; revision: number; demand_snapshot_hash: string; submitted_at: string; campaign_no: string; campaign_name: string };
type SubmissionLine = { item_id: string; item_code_snapshot: string; item_name_snapshot: string; size_snapshot: string | null; unit_snapshot: string; demand_quantity_snapshot: number };

export default function SeasonalApprovalPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [submissionId, setSubmissionId] = useState("");
  const [decision, setDecision] = useState<"APPROVE" | "RETURN">("APPROVE");
  const [reason, setReason] = useState("");
  const [queueQuery, setQueueQuery] = useState("");
  const [queuePage, setQueuePage] = useState(1);
  const [queueSortKey, setQueueSortKey] = useState<SeasonalApprovalSortKey>("submitted_at");
  const [queueSortDirection, setQueueSortDirection] = useState<SeasonalApprovalSortDirection>("desc");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [lines, setLines] = useState<SubmissionLine[]>([]);
  const submissionsRef = useRef<Submission[]>([]);
  const reviewKeyRef = useRef<string | null>(null);
  const submissionIdRef = useRef("");
  const [dataSnapshotAccountId, setDataSnapshotAccountId] = useState<string | null>(null);
  const dataSnapshotAccountIdRef = useRef<string | null>(null);
  const queueReadControllerRef = useRef<ReadRequestController | null>(null);
  const detailReadControllerRef = useRef<ReadRequestController | null>(null);
  const hasCurrentDataSnapshot = Boolean(
    identityReady
      && dataSnapshotAccountId
      && dataSnapshotAccountId === accountId,
  );
  const visibleSubmissions = useMemo(() => hasCurrentDataSnapshot ? submissions : [], [hasCurrentDataSnapshot, submissions]);
  const queueRows: SeasonalApprovalQueueRow[] = useMemo(() => visibleSubmissions.map((submission) => {
    return {
      id: submission.id,
      campaignNo: submission.campaign_no,
      campaignName: submission.campaign_name,
      revision: submission.revision,
      demandSnapshotHash: submission.demand_snapshot_hash,
      submittedAt: submission.submitted_at,
    };
  }), [visibleSubmissions]);
  const filteredQueueRows = useMemo(() => filterSeasonalApprovalQueue(queueRows, queueQuery), [queueQuery, queueRows]);
  const sortedQueueRows = useMemo(() => sortSeasonalApprovalQueue(filteredQueueRows, queueSortKey, queueSortDirection), [filteredQueueRows, queueSortDirection, queueSortKey]);
  const displayMessage = identityError ?? message;

  useEffect(() => {
    submissionIdRef.current = submissionId;
  }, [submissionId]);

  useEffect(() => {
    if (!identityReady || !client) {
      return;
    }
    const supabase = client;
    let active = true;
    const readController = queueReadControllerRef.current ?? createReadRequestController();
    queueReadControllerRef.current = readController;
    const readSequence = readController.begin();
    async function load() {
      setDataLoading(true);
      try {
        setMessage("正在讀取待核版本…");
        const [submissionResult] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("v_seasonal_approval_queue").select("submission_id,campaign_id,revision,demand_snapshot_hash,submitted_at,campaign_no,campaign_name").order("submitted_at", { ascending: false })] as const,
        );
        if (!active || !readController.isCurrent(readSequence)) return;
        if (submissionResult.error) {
          const preserveSnapshot = dataSnapshotAccountIdRef.current === accountId
            && shouldPreserveReadSnapshot(submissionsRef.current, [submissionResult.error]);
          if (!preserveSnapshot) {
            submissionsRef.current = [];
            setSubmissions([]);
            setSubmissionId("");
            setLines([]);
            dataSnapshotAccountIdRef.current = null;
            setDataSnapshotAccountId(null);
          }
          setMessage(preserveSnapshot ? staleReadSnapshotMessage("待核版本") : "待核資料載入失敗，請確認 CEO 角色與資料權限。");
          return;
        }
        const loaded = ((submissionResult.data ?? []) as Array<{
          submission_id: string;
          campaign_id: string;
          revision: number;
          demand_snapshot_hash: string;
          submitted_at: string;
          campaign_no: string;
          campaign_name: string;
        }>).map((row) => ({
          id: row.submission_id,
          campaign_id: row.campaign_id,
          revision: row.revision,
          demand_snapshot_hash: row.demand_snapshot_hash,
          submitted_at: row.submitted_at,
          campaign_no: row.campaign_no,
          campaign_name: row.campaign_name,
        }));
        const selectedSubmissionStillExists = loaded.some((submission) => submission.id === submissionIdRef.current);
        submissionsRef.current = loaded;
        setSubmissions(loaded);
        dataSnapshotAccountIdRef.current = accountId;
        setDataSnapshotAccountId(accountId);
        if (!selectedSubmissionStillExists) {
          setSubmissionId("");
          setLines([]);
        }
        setMessage(`已載入 ${loaded.length} 件待核版本`);
      } finally {
        if (active && readController.isCurrent(readSequence)) setDataLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accountId, client, identityError, identityReady, panelActive, reloadToken]);

  useEffect(() => {
    if (!identityReady || !client || !submissionId || !hasCurrentDataSnapshot) return;
    let active = true;
    const readController = detailReadControllerRef.current ?? createReadRequestController();
    detailReadControllerRef.current = readController;
    const readSequence = readController.begin();
    void retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("seasonal_approval_submission_lines").select("item_id,item_code_snapshot,item_name_snapshot,size_snapshot,unit_snapshot,demand_quantity_snapshot").eq("submission_id", submissionId).order("item_code_snapshot")] as const,
    ).then(([result]) => {
      if (!active || !readController.isCurrent(readSequence)) return;
      setLines(result.error ? [] : (result.data ?? []) as SubmissionLine[]);
      if (result.error) setMessage("送核明細載入失敗，為避免盲核請重新載入資料。");
    });
    return () => { active = false; };
  }, [accountId, client, hasCurrentDataSnapshot, identityReady, panelActive, reloadToken, submissionId]);

  function reloadApprovalData() {
    queueReadControllerRef.current?.invalidate();
    detailReadControllerRef.current?.invalidate();
    setMessage("正在重新載入待核資料…");
    setReloadToken((current) => current + 1);
  }

  async function review() {
    if (!identityReady || !client || !hasCurrentDataSnapshot) { setMessage(identityError ?? "待核資料尚未完成載入，請稍候再審核。"); return; }
    const submission = visibleSubmissions.find((row) => row.id === submissionId);
    if (!submission || (decision === "RETURN" && !reason.trim())) { setMessage("退回時必須填寫理由。"); return; }
    setBusy(true); setMessage("");
    const reviewKey = reviewKeyRef.current ?? crypto.randomUUID();
    reviewKeyRef.current = reviewKey;
    const { error } = await client.rpc("review_seasonal_submission", {
      p_submission_id: submission.id, p_submission_revision: submission.revision,
      p_demand_snapshot_hash: submission.demand_snapshot_hash, p_decision: decision,
      p_reason: reason.trim() || null, p_idempotency_key: `REVIEW-SEASONAL-${reviewKey}`,
      p_request_fingerprint: JSON.stringify({ id: submission.id, revision: submission.revision, hash: submission.demand_snapshot_hash, decision, reason: reason.trim() }),
    });
    if (error) setMessage(safeSupabaseMutationErrorMessage(error, "審核失敗；請重新確認目前版本後重試。"));
    else {
      const nextSubmission = visibleSubmissions.find((row) => row.id !== submission.id);
      setMessage(decision === "APPROVE" ? "已核准，採購可依核准量進行 MOQ 判斷。" : "已退回 HR 修正，退回理由已保留。");
      const remainingSubmissions = visibleSubmissions.filter((row) => row.id !== submission.id);
      submissionsRef.current = remainingSubmissions;
      setSubmissions(remainingSubmissions);
      setSubmissionId(nextSubmission?.id ?? "");
      setLines([]);
      setReason("");
      reviewKeyRef.current = null;
    }
    setBusy(false);
  }

  function selectSubmission(id: string) {
    reviewKeyRef.current = null;
    detailReadControllerRef.current?.invalidate();
    setSubmissionId(id);
    setLines([]);
    setQueuePage(1);
  }

  function sortQueue(nextKey: SeasonalApprovalSortKey) {
    if (queueSortKey === nextKey) setQueueSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setQueueSortKey(nextKey); setQueueSortDirection("asc"); }
    setQueuePage(1);
  }

  if (!client) return <section className="panel import-panel" aria-label="CEO 換季審核"><div className="panel-heading"><div><p className="eyebrow">10 / CEO REVIEW</p><h2>CEO 換季審核</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 CEO 帳號後可載入待核 revision/hash，核准或退回需求。</p></section>;
  const selected = visibleSubmissions.find((row) => row.id === submissionId);
  return <section className="panel import-panel" aria-label="CEO 換季審核">
    <div className="panel-heading"><div><p className="eyebrow">10 / CEO REVIEW</p><h2>CEO 換季審核</h2></div><div className="heading-actions"><span className="status-pill">待核 {visibleSubmissions.length} 件</span><button className="secondary-button" type="button" onClick={reloadApprovalData} disabled={busy}>重新載入資料</button></div></div>
    <p className="auth-message">系統會重驗畫面所見的 revision 與需求雜湊；資料被 HR 修改或版本已變更時，審核會拒絕並要求重新載入。</p>
    <div className="seasonal-approval-workspace">
      <div className="seasonal-approval-queue">
        <div className="subheading"><h3>待核版本清單</h3><span>僅顯示 PENDING；按「選取」載入右側審核明細</span></div>
      <div className="management-catalog-filters seasonal-approval-filters"><label className="field"><span>搜尋活動／版本／Hash</span><input value={queueQuery} onChange={(event) => { setQueueQuery(event.target.value); setQueuePage(1); }} placeholder="活動編號、活動名稱、revision 或 hash" /></label></div>
      <div className="management-catalog-result"><p className="muted" aria-live="polite">符合條件 {sortedQueueRows.length} 筆</p>{queueQuery ? <button className="text-button" type="button" onClick={() => { setQueueQuery(""); setQueuePage(1); }}>清除搜尋</button> : null}</div>
        <ManagementCatalogTable
          ariaLabel="CEO 待核版本"
          rows={sortedQueueRows}
          rowKey={(row) => row.id}
          columns={[
            { id: "campaign", label: "活動", sortKey: "campaign_no", locked: true, render: (row) => <strong>{row.campaignNo}｜{row.campaignName}</strong> },
            { id: "revision", label: "Revision", sortKey: "revision", render: (row) => row.revision },
            { id: "submitted", label: "送核時間", sortKey: "submitted_at", render: (row) => new Date(row.submittedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }) },
            { id: "hash", label: "Snapshot Hash", defaultVisible: false, render: (row) => row.demandSnapshotHash },
            { id: "action", label: "功能", locked: true, render: (row) => <button className="management-row-action" type="button" onClick={() => selectSubmission(row.id)} disabled={busy}>{row.id === submissionId ? "目前已選取" : "選取"}</button> },
          ] satisfies readonly ManagementCatalogColumn<SeasonalApprovalQueueRow, SeasonalApprovalSortKey>[]}
          page={queuePage}
          onPageChange={setQueuePage}
          sortKey={queueSortKey}
          sortDirection={queueSortDirection}
          onSort={sortQueue}
          loading={dataLoading && visibleSubmissions.length === 0}
          defaultPageSize={10}
          pageSizeOptions={[5, 10, 25, 50]}
          emptyState={<p className="empty-state">{queueRows.length === 0 ? "目前沒有待核版本。" : "沒有符合搜尋的待核版本。"}</p>}
          tableClassName="seasonal-approval-table"
        />
      </div>
      <div className="seasonal-approval-review">
        <div className="subheading"><h3>審核工作區</h3><span>核准前會重新驗證 revision 與 Hash</span></div>
        <div className="form-grid">
          <label className="field"><span>目前審核版本</span><select value={submissionId} onChange={(event) => selectSubmission(event.target.value)} disabled={busy || !hasCurrentDataSnapshot}><option value="">請選擇</option>{visibleSubmissions.map((row) => <option key={row.id} value={row.id}>{row.campaign_no}｜rev {row.revision}｜{new Date(row.submitted_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}</option>)}</select></label>
          <label className="field"><span>決定</span><select value={decision} onChange={(event) => { reviewKeyRef.current = null; setDecision(event.target.value as "APPROVE" | "RETURN"); }} disabled={busy}><option value="APPROVE">核准</option><option value="RETURN">退回 HR</option></select></label>
        </div>
        {selected ? <p className="muted">{selected.campaign_name}／rev {selected.revision}／snapshot {selected.demand_snapshot_hash}</p> : null}
        {selected && lines.length === 0 ? <p className="auth-message">送核明細尚未載入，暫停核准以避免盲核。</p> : null}
        {lines.length > 0 ? <div className="summary-list">{lines.map((line) => <div className="summary-row" key={line.item_id}><span><strong>{line.item_code_snapshot}｜{line.item_name_snapshot}</strong><small>{line.size_snapshot ? `尺寸 ${line.size_snapshot}｜` : ""}{line.unit_snapshot}</small></span><strong>{line.demand_quantity_snapshot}</strong></div>)}</div> : null}
        <label className="field"><span>退回理由（核准可留白）</span><input value={reason} onChange={(event) => { reviewKeyRef.current = null; setReason(event.target.value); }} maxLength={500} disabled={busy} placeholder="例如：請確認某機構需求數量" /></label>
        <div className="button-row"><button className="primary-button" type="button" onClick={() => void review()} disabled={busy || !identityReady || !selected || lines.length === 0}>{busy ? "送出中…" : decision === "APPROVE" ? "核准此版本" : "退回 HR"}</button></div>
        {displayMessage ? <p className={displayMessage.startsWith("已") ? "success-note" : "auth-message"} role="status">{displayMessage}</p> : null}
      </div>
    </div>
  </section>;
}
