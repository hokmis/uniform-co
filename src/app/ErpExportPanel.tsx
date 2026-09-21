"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadActiveInstitutionOptions, type ActiveInstitutionOption } from "@/src/lib/master-data-cache";
import type { AccountScopedReadOutcome } from "@/src/domain/account-scoped-read";
import { isArtifactTerminalStatus, workflowStatusLabel, workflowStatusTone } from "@/src/domain/workflow-status";
import { workflowRecoveryCandidates } from "@/src/domain/workflow-recovery";
import { createReadRequestController } from "@/src/domain/read-refresh";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { useAccountScopedReadSnapshot } from "./use-account-scoped-read-snapshot";
import { useWorkflowStatusPoll } from "./use-workflow-status-poll";
import WorkflowActionBar from "./WorkflowActionBar";
import { useWorkspaceSession } from "./workspace-session";

type Institution = ActiveInstitutionOption;
type Batch = { id: string; batch_no: string; distribution_date: string; institution_code_snapshot: string; institution_name_snapshot: string; status: string; source_snapshot_version: number; source_snapshot_hash: string; current_artifact_id: string | null };
type Artifact = { id: string; revision: number; status: string; format_version: string; storage_object_key: string | null; payload_sha256?: string | null };
const EMPTY_INSTITUTIONS: Institution[] = [];

export default function ErpExportPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [institutionSelection, setInstitutionSelection] = useState<{ accountId: string; institutionId: string } | null>(null);
  const [distributionDate, setDistributionDate] = useState(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date()));
  const [batch, setBatch] = useState<Batch | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const currentArtifactIdRef = useRef<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const artifactStatusReadControllerRef = useRef(createReadRequestController());
  const [batchKey, setBatchKey] = useState<string | null>(() => typeof window === "undefined" ? null : window.localStorage.getItem("uniform:erp-batch-key"));
  const [artifactKey, setArtifactKey] = useState<string | null>(() => typeof window === "undefined" ? null : window.localStorage.getItem("uniform:erp-artifact-key"));
  const [recoveryBatchId, setRecoveryBatchId] = useState<string | null>(() => typeof window === "undefined" ? null : window.localStorage.getItem("uniform:erp-batch-id"));
  const [recoveryArtifactId, setRecoveryArtifactId] = useState<string | null>(() => typeof window === "undefined" ? null : window.localStorage.getItem("uniform:erp-artifact-id"));
  const readInstitutions = useCallback(async (): Promise<AccountScopedReadOutcome<Institution[]>> => {
    if (!client) {
      return { status: "failure", errors: [], message: "機構清單尚未連線，請登入後重試。" };
    }
    const result = await loadActiveInstitutionOptions(client);
    if (result.errors.length > 0) {
      return {
        status: "failure",
        errors: result.errors,
        message: `機構載入失敗：${safeSupabaseReadErrorMessage(result.errors[0])}`,
      };
    }
    return { status: "success", data: result.institutions, message: "機構清單已就緒。" };
  }, [client]);
  const {
    data: institutions,
    hasCurrentSnapshot: hasCurrentInstitutionSnapshot,
    loading: institutionLoading,
    message: institutionMessage,
  } = useAccountScopedReadSnapshot({
    accountId: accountId ?? null,
    enabled: identityReady,
    refreshKey: 0,
    emptyData: EMPTY_INSTITUTIONS,
    resourceLabel: "機構清單",
    initialMessage: "機構清單尚未載入。",
    read: readInstitutions,
  });
  const selectedInstitutionId = institutionSelection?.accountId === accountId ? institutionSelection.institutionId : "";
  const institutionId = hasCurrentInstitutionSnapshot
    && institutions.some((institution) => institution.id === selectedInstitutionId)
    ? selectedInstitutionId
    : "";
  const institutionSelectionReady = hasCurrentInstitutionSnapshot && Boolean(institutionId);
  const displayMessage = identityError ?? (message || (identityReady && !institutionLoading ? institutionMessage : ""));

  const { refresh: refreshArtifactStatus } = useWorkflowStatusPoll<Artifact>({
    active: identityReady,
    token: artifact?.id ?? null,
    poll: async () => {
      if (!identityReady || !client || !artifact) return null;
      const [result] = await retrySupabaseQueriesAfterSessionRefresh(
        client,
        async () => [await client.rpc("get_erp_artifact_status", { p_artifact_id: artifact.id, p_idempotency_key: null })] as const,
      );
      return result.error || !result.data ? null : result.data as Artifact;
    },
    isTerminal: (value) => isArtifactTerminalStatus(value.status),
    onValue: (value) => {
      if (currentArtifactIdRef.current === value.id) setArtifact(value);
    },
  });

  useEffect(() => {
    if (!identityReady || !client || batch) return;
    const supabase = client;
    let active = true;
    async function recover() {
      for (const candidate of workflowRecoveryCandidates(recoveryBatchId, batchKey)) {
        const [result] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [candidate.kind === "id"
            ? await supabase.from("erp_export_batches").select("id,batch_no,distribution_date,institution_code_snapshot,institution_name_snapshot,status,source_snapshot_version,source_snapshot_hash,current_artifact_id").eq("id", candidate.value).maybeSingle()
            : await supabase.rpc("get_erp_batch_status", { p_batch_id: null, p_idempotency_key: `CREATE-ERP-${candidate.value}` })] as const,
        );
        if (!active || result.error || !result.data) continue;
        const recovered = result.data as Batch;
        setBatch(recovered);
        setRecoveryBatchId(recovered.id);
        window.localStorage.setItem("uniform:erp-batch-id", recovered.id);
        return;
      }
    }
    void recover();
    return () => { active = false; };
  }, [client, batch, batchKey, identityReady, panelActive, recoveryBatchId]);

  useEffect(() => {
    if (!identityReady || !client || artifact) return;
    const supabase = client;
    let active = true;
    async function recover() {
      for (const candidate of workflowRecoveryCandidates(recoveryArtifactId, artifactKey)) {
        const result = await supabase.rpc("get_erp_artifact_status", candidate.kind === "id"
          ? { p_artifact_id: candidate.value, p_idempotency_key: null }
          : { p_artifact_id: null, p_idempotency_key: `REQUEST-ERP-ARTIFACT-${candidate.value}` });
        if (!active || result.error || !result.data) continue;
        const recovered = result.data as Artifact;
        currentArtifactIdRef.current = recovered.id;
        setArtifact(recovered);
        setRecoveryArtifactId(recovered.id);
        window.localStorage.setItem("uniform:erp-artifact-id", recovered.id);
        return;
      }
    }
    void recover();
    return () => { active = false; };
  }, [artifact, artifactKey, client, identityReady, panelActive, recoveryArtifactId]);

  async function createBatch() {
    if (!identityReady || !client || !hasCurrentInstitutionSnapshot || !institutionSelectionReady || !distributionDate || batch) return;
    setBusy(true); setMessage("");
    const key = batchKey ?? crypto.randomUUID(); setBatchKey(key); window.localStorage.setItem("uniform:erp-batch-key", key);
    const { data, error } = await client.rpc("create_erp_export_batch", {
      p_distribution_date: distributionDate, p_institution_id: institutionId,
      p_idempotency_key: `CREATE-ERP-${key}`,
      p_request_fingerprint: JSON.stringify({ distributionDate, institutionId }),
    });
    if (error || !data?.id) setMessage("匯出批次結果尚未確認，請使用相同操作重試；不會重複建立批次。");
    else { setBatch(data as Batch); window.localStorage.setItem("uniform:erp-batch-id", String((data as Batch).id)); setBatchKey(null); window.localStorage.removeItem("uniform:erp-batch-key"); setMessage("已建立匯出批次；尚未產生鼎新檔案，可稍後繼續。"); }
    setBusy(false);
  }

  async function requestArtifact() {
    if (!identityReady || !client || !batch) return;
    setBusy(true); setMessage("");
    const key = artifactKey ?? crypto.randomUUID(); setArtifactKey(key); window.localStorage.setItem("uniform:erp-artifact-key", key);
    const { data, error } = await client.rpc("request_erp_artifact", {
      p_batch_id: batch.id, p_format_version: "UNIFORM-ERP-SALES-v0",
      p_idempotency_key: `REQUEST-ERP-ARTIFACT-${key}`,
      p_request_fingerprint: JSON.stringify({ batchId: batch.id, formatVersion: "UNIFORM-ERP-SALES-v0", sourceSnapshotVersion: batch.source_snapshot_version, sourceSnapshotHash: batch.source_snapshot_hash }),
    });
    if (error || !data?.id) setMessage("匯出檔案結果尚未確認，請使用相同操作重試；不會重複建立檔案。");
    else { const created = data as Artifact; currentArtifactIdRef.current = created.id; setArtifact(created); window.localStorage.setItem("uniform:erp-artifact-id", created.id); setArtifactKey(null); window.localStorage.removeItem("uniform:erp-artifact-key"); setMessage("已建立匯出檔案版本；正式鼎新欄位仍需以成功匯入樣本完成驗證。"); }
    setBusy(false);
  }

  async function refreshArtifact() {
    if (!identityReady || !client || !artifact) return;
    const sequence = artifactStatusReadControllerRef.current.begin();
    setArtifactLoading(true);
    try {
      const result = await refreshArtifactStatus();
      if (!artifactStatusReadControllerRef.current.isCurrent(sequence) || currentArtifactIdRef.current !== artifact.id) return;
      if (result) setArtifact((current) => current?.id === artifact.id ? result : current);
      else setMessage("匯出檔案狀態查詢失敗，請稍後再試。相同操作不會重複建立檔案。");
    } finally {
      if (artifactStatusReadControllerRef.current.isCurrent(sequence)) setArtifactLoading(false);
    }
  }

  async function downloadArtifact() {
    if (!client || !artifact || !batch || artifact.status !== "READY") return;
    setBusy(true);
    const result = await client.rpc("download_erp_artifact", { p_batch_id: batch.id, p_artifact_id: artifact.id });
    if (result.error) setMessage("匯出檔案下載結果尚未確認，請稍後再試。");
    else {
      const payload = result.data as { bucket?: string; object_key?: string };
      if (!payload.bucket || !payload.object_key) setMessage("ERP 已就緒，但下載位置尚未回傳。");
      else {
        const signed = await client.storage.from(payload.bucket).createSignedUrl(payload.object_key, 120);
        if (signed.error || !signed.data?.signedUrl) setMessage("匯出檔案下載連結建立失敗，請稍後再試。");
        else window.open(signed.data.signedUrl, "_blank", "noopener,noreferrer");
      }
    }
    setBusy(false);
  }

  function startAnother() {
    artifactStatusReadControllerRef.current.invalidate();
    setArtifactLoading(false);
    currentArtifactIdRef.current = null;
    setBatch(null); setArtifact(null); setRecoveryBatchId(null); setRecoveryArtifactId(null); setBatchKey(null); setArtifactKey(null); window.localStorage.removeItem("uniform:erp-batch-id"); window.localStorage.removeItem("uniform:erp-artifact-id"); window.localStorage.removeItem("uniform:erp-batch-key"); window.localStorage.removeItem("uniform:erp-artifact-key"); setMessage("");
  }

  function retrySameBatch() {
    if (!batch || artifact?.status !== "FAILED") return;
    artifactStatusReadControllerRef.current.invalidate();
    setArtifactLoading(false);
    currentArtifactIdRef.current = null;
    setArtifact(null); setRecoveryArtifactId(null); setArtifactKey(null);
    window.localStorage.removeItem("uniform:erp-artifact-id"); window.localStorage.removeItem("uniform:erp-artifact-key");
    setMessage("已保留同一匯出批次，可重新產生檔案。");
  }

  if (!client) return <section className="panel import-panel" aria-label="鼎新 ERP 匯出"><div className="panel-heading"><div><p className="eyebrow">11 / ERP</p><h2>鼎新 ERP 銷貨匯出</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 HR 帳號並提供鼎新成功匯入樣本後，才能建立匯出批次與檔案。</p></section>;
  const currentStatus = artifact?.status ?? batch?.status;
  const primaryAction = !batch
    ? { onClick: () => void createBatch(), busy, disabled: busy || !identityReady || !institutionSelectionReady, label: "建立匯出批次" }
    : !artifact
      ? { onClick: () => void requestArtifact(), busy, busyLabel: "產生中…", disabled: busy || !identityReady, label: "產生匯出檔案" }
      : artifact.status === "READY"
        ? { onClick: () => void downloadArtifact(), busy, busyLabel: "下載中…", disabled: busy || !identityReady, label: "下載檔案" }
        : artifact.status === "FAILED"
          ? { onClick: retrySameBatch, busy: false, disabled: busy || !identityReady, label: "同批次重試" }
          : { onClick: () => undefined, busy: false, disabled: true, label: "檔案處理中…" };
  const secondaryActions = batch ? <>
    {artifact ? <button className="secondary-button" type="button" onClick={() => void refreshArtifact()} disabled={busy || !identityReady}>{artifactLoading ? "查詢中…" : "重新查詢狀態"}</button> : null}
    <button className="secondary-button" type="button" onClick={startAnother} disabled={busy || !identityReady || (artifact !== null && !isArtifactTerminalStatus(artifact.status))}>建立另一批次</button>
  </> : null;
  return (
    <section className="panel import-panel" aria-label="鼎新 ERP 匯出" aria-busy={busy || institutionLoading || artifactLoading}>
      <div className="panel-heading">
        <div><p className="eyebrow">11 / ERP</p><h2>鼎新 ERP 銷貨匯出</h2></div>
        <span className={`status-pill ${workflowStatusTone(currentStatus)}`}>{workflowStatusLabel(currentStatus)}</span>
      </div>
      <p className="auth-message">系統只把已發貨且尚未匯出的來源凍結成日期＋機構批次；沒有成功匯入樣本前，不宣稱目前格式就是正式鼎新格式。</p>
      <div className="form-grid">
        <label className="field">
          <span>發放日期</span>
          <input type="date" value={distributionDate} onChange={(event) => { setBatchKey(null); setDistributionDate(event.target.value); }} disabled={busy || Boolean(batch)} />
        </label>
        <label className="field">
          <span>機構</span>
          <select value={institutionId} onChange={(event) => { if (!accountId) return; setBatchKey(null); setInstitutionSelection({ accountId, institutionId: event.target.value }); }} disabled={busy || !identityReady || !hasCurrentInstitutionSnapshot || Boolean(batch)}>
            <option value="">{institutionLoading ? "載入機構中…" : "請選擇"}</option>
            {institutions.map((institution) => <option key={institution.id} value={institution.id}>{institution.code}｜{institution.name}</option>)}
          </select>
        </label>
      </div>
      {institutionLoading || artifactLoading ? <p className="sr-only" role="status" aria-live="polite">{institutionLoading ? "正在讀取機構…" : "正在讀取匯出檔案狀態…"}</p> : null}
      <WorkflowActionBar primary={primaryAction} secondary={secondaryActions} />
      {batch ? <p className="success-note">{batch.batch_no}／{batch.institution_code_snapshot}／{batch.distribution_date}。{artifact ? `第 ${artifact.revision} 版檔案：${workflowStatusLabel(artifact.status)}。` : "可產生匯出檔案。"}</p> : null}
      {displayMessage ? <p className={displayMessage.includes("已") ? "success-note" : "auth-message"} role="status">{displayMessage}</p> : null}
    </section>
  );
}
