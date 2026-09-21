"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { isArtifactTerminalStatus, workflowStatusLabel, workflowStatusTone } from "@/src/domain/workflow-status";
import { workflowRecoveryCandidates } from "@/src/domain/workflow-recovery";
import { createReadRequestController } from "@/src/domain/read-refresh";
import { retrySupabaseQueriesAfterSessionRefresh } from "@/src/lib/supabase-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkflowStatusPoll } from "./use-workflow-status-poll";
import WorkflowActionBar from "./WorkflowActionBar";
import { useWorkspaceSession } from "./workspace-session";

type DocumentType = "HR_REQUEST" | "WAREHOUSE_SHIPMENT" | "REPLENISHMENT" | "STOCKTAKE" | "RETURN_NOTE" | "SEASONAL_APPROVAL" | "PURCHASE_ORDER" | "PURCHASE_RECEIPT";
type DocumentRow = { id: string; label: string; version: number; hash: string };
type Artifact = { id: string; status: "PREPARING" | "READY" | "FAILED"; revision: number; template_version: string; storage_object_key: string | null; payload_sha256?: string | null; payload_size_bytes?: number | null; error_message: string | null };
type ArtifactKind = "FORMAL" | "DRAFT_WATERMARK";

const labels: Record<DocumentType, string> = {
  HR_REQUEST: "人資需求單",
  WAREHOUSE_SHIPMENT: "倉庫發貨單",
  REPLENISHMENT: "補庫單",
  STOCKTAKE: "盤點單",
  RETURN_NOTE: "退回單",
  SEASONAL_APPROVAL: "換季核准單",
  PURCHASE_ORDER: "採購單",
  PURCHASE_RECEIPT: "採購入庫單",
};

const sourceConfig: Record<DocumentType, { table: string; select: string; numberField: string }> = {
  HR_REQUEST: { table: "hr_requests", select: "id,request_no,status,row_version", numberField: "request_no" },
  WAREHOUSE_SHIPMENT: { table: "warehouse_shipments", select: "id,shipment_no,status", numberField: "shipment_no" },
  REPLENISHMENT: { table: "replenishment_requests", select: "id,request_no,status,row_version", numberField: "request_no" },
  STOCKTAKE: { table: "stocktakes", select: "id,stocktake_no,status", numberField: "stocktake_no" },
  RETURN_NOTE: { table: "return_notes", select: "id,return_no,status", numberField: "return_no" },
  SEASONAL_APPROVAL: { table: "seasonal_approvals", select: "id,approval_no,status", numberField: "approval_no" },
  PURCHASE_ORDER: { table: "purchase_orders", select: "id,po_no,status", numberField: "po_no" },
  PURCHASE_RECEIPT: { table: "purchase_receipts", select: "id,receipt_no,status", numberField: "receipt_no" },
};

export default function PdfArtifactPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [documentType, setDocumentType] = useState<DocumentType>("HR_REQUEST");
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const currentArtifactIdRef = useRef<string | null>(null);
  const [artifactKind, setArtifactKind] = useState<ArtifactKind>("FORMAL");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const artifactStatusReadControllerRef = useRef(createReadRequestController());
  const [recoveryArtifactId, setRecoveryArtifactId] = useState<string | null>(() => typeof window === "undefined" ? null : window.localStorage.getItem("uniform:pdf-artifact-id"));
  const [recoveryRequestKey, setRecoveryRequestKey] = useState<string | null>(() => typeof window === "undefined" ? null : window.localStorage.getItem("uniform:pdf-request-key"));
  const keyRef = useRef<string | null>(recoveryRequestKey);
  const displayMessage = identityError ?? message;

  useEffect(() => {
    if (!identityReady || !client || artifact) return;
    const supabase = client;
    let active = true;
    async function recover() {
      for (const candidate of workflowRecoveryCandidates(recoveryArtifactId, recoveryRequestKey)) {
        const [result] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.rpc("get_document_status", candidate.kind === "id"
            ? { p_artifact_id: candidate.value, p_idempotency_key: null }
            : { p_artifact_id: null, p_idempotency_key: `REQUEST-PDF-${candidate.value}` })] as const,
        );
        if (!active || result.error || !result.data) continue;
        const recovered = result.data as Artifact;
        currentArtifactIdRef.current = recovered.id;
        setArtifact(recovered);
        setRecoveryArtifactId(recovered.id);
        window.localStorage.setItem("uniform:pdf-artifact-id", recovered.id);
        return;
      }
    }
    void recover();
    return () => { active = false; };
  }, [artifact, client, identityReady, panelActive, recoveryArtifactId, recoveryRequestKey]);

  const selected = useMemo(() => documents.find((row) => row.id === documentId), [documents, documentId]);

  const { refresh: refreshArtifactStatus } = useWorkflowStatusPoll<Artifact>({
    active: identityReady,
    token: artifact?.id ?? null,
    poll: async () => {
      if (!identityReady || !client || !artifact) return null;
      const [result] = await retrySupabaseQueriesAfterSessionRefresh(
        client,
        async () => [await client.rpc("get_document_status", { p_artifact_id: artifact.id, p_idempotency_key: null })] as const,
      );
      return result.error || !result.data ? null : result.data as Artifact;
    },
    isTerminal: (value) => isArtifactTerminalStatus(value.status),
    onValue: (value) => {
      if (currentArtifactIdRef.current === value.id) setArtifact(value);
    },
  });

  useEffect(() => {
    if (!identityReady || !client) return;
    const supabase = client;
    let active = true;
    async function load() {
      const config = sourceConfig[documentType];
      setDocumentLoading(true);
      try {
        const [result] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from(config.table).select(config.select).order("id", { ascending: false }).limit(100)] as const,
        );
        if (!active) return;
        if (result.error) { setMessage("單據載入失敗，請確認角色與資料權限。"); return; }
        const rows = (result.data ?? []).map((row) => {
          const record = row as unknown as Record<string, unknown>;
          const id = String(record.id);
          const label = String(record[config.numberField] ?? id);
          const version = Number(record.row_version ?? 1) || 1;
          return { id, label: `${label}｜${workflowStatusLabel(String(record.status ?? ""))}`, version, hash: JSON.stringify(record) };
        });
        setDocuments(rows);
        setDocumentId((current) => rows.some((row) => row.id === current) ? current : "");
      } finally {
        if (active) setDocumentLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [client, documentType, identityReady, panelActive]);

  async function requestPdf() {
    if (!identityReady || !client || !selected || documentLoading) { setMessage(identityError ?? "請先選擇要產生的單據。"); return; }
    setBusy(true); setMessage("");
    const key = keyRef.current ?? crypto.randomUUID();
    keyRef.current = key;
    window.localStorage.setItem("uniform:pdf-request-key", key);
    const { data, error } = await client.rpc("request_document_pdf", {
      p_document_type: documentType, p_document_id: selected.id, p_template_version: "A4-v1",
      p_source_snapshot_version: selected.version, p_source_snapshot_hash: selected.hash,
      p_idempotency_key: `REQUEST-PDF-${key}`,
      p_request_fingerprint: JSON.stringify({ documentType, documentId: selected.id, artifactKind, version: selected.version, hash: selected.hash }),
      p_artifact_kind: artifactKind,
    });
    if (error || !data?.id) setMessage("PDF 請求結果尚未確認，請使用相同操作重試。相同操作不會重複建立檔案。");
    else { const created = data as Artifact; currentArtifactIdRef.current = created.id; setArtifact(created); window.localStorage.setItem("uniform:pdf-artifact-id", created.id); keyRef.current = null; setRecoveryRequestKey(null); window.localStorage.removeItem("uniform:pdf-request-key"); setMessage("已建立不可變 PDF 版本；檔案準備完成前可關閉頁面，之後再回來查詢。"); }
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
      else setMessage("PDF 狀態查詢失敗，請稍後再試。相同操作不會重複建立檔案。");
    } finally {
      if (artifactStatusReadControllerRef.current.isCurrent(sequence)) setArtifactLoading(false);
    }
  }

  async function downloadArtifact() {
    if (!identityReady || !client || !artifact || artifact.status !== "READY") return;
    setBusy(true);
    const result = await client.rpc("download_document", { p_artifact_id: artifact.id });
    if (result.error) setMessage("PDF 下載結果尚未確認，請稍後再試。");
    else {
      const payload = result.data as { bucket?: string; object_key?: string };
      if (!payload.bucket || !payload.object_key) setMessage("PDF 已就緒，但下載位置尚未回傳。");
      else {
        const signed = await client.storage.from(payload.bucket).createSignedUrl(payload.object_key, 120);
        if (signed.error || !signed.data?.signedUrl) setMessage("PDF 下載連結建立失敗，請稍後再試。");
        else window.open(signed.data.signedUrl, "_blank", "noopener,noreferrer");
      }
    }
    setBusy(false);
  }

  function startAnother() {
    artifactStatusReadControllerRef.current.invalidate();
    setArtifactLoading(false);
    currentArtifactIdRef.current = null;
    setArtifact(null); setRecoveryArtifactId(null); setRecoveryRequestKey(null); keyRef.current = null; window.localStorage.removeItem("uniform:pdf-artifact-id"); window.localStorage.removeItem("uniform:pdf-request-key"); setMessage("");
  }

  if (!client) return <section className="panel import-panel" aria-label="正式單據 PDF"><div className="panel-heading"><div><p className="eyebrow">10 / PDF</p><h2>正式單據 PDF</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">設定 Supabase 並登入授權角色後，可從已建立單據請求 A4 PDF；瀏覽器列印預覽仍可立即使用。</p></section>;
  const primaryAction = !artifact
    ? { onClick: () => void requestPdf(), busy, disabled: busy || documentLoading || !identityReady || !selected, label: "請求 A4 PDF" }
    : artifact.status === "READY"
      ? { onClick: () => void downloadArtifact(), busy, busyLabel: "下載中…", disabled: busy || !identityReady, label: "下載 PDF" }
      : { onClick: () => undefined, busy: false, disabled: true, label: artifact.status === "FAILED" ? "檔案需要重試" : "檔案準備中…" };
  const secondaryActions = artifact ? <>
    <button className="secondary-button" type="button" onClick={() => void refreshArtifact()} disabled={busy || !identityReady}>{artifactLoading ? "查詢中…" : "重新查詢狀態"}</button>
    <button className="secondary-button" type="button" onClick={startAnother} disabled={busy || !identityReady || !isArtifactTerminalStatus(artifact.status)}>建立另一份</button>
  </> : null;
  return <section className="panel import-panel" aria-label="正式單據 PDF" aria-busy={busy || documentLoading || artifactLoading}>
    <div className="panel-heading"><div><p className="eyebrow">10 / PDF</p><h2>正式單據 PDF</h2></div><span className={`status-pill ${workflowStatusTone(artifact?.status)}`}>{workflowStatusLabel(artifact?.status, "待請求")}</span></div>
    <p className="auth-message">每次請求都固定單據版本；已完成的 PDF 不會被覆寫。檔案準備中時系統會自動更新，也可以手動重新查詢，不需要重新建立單據。</p>
    <div className="form-grid"><label className="field"><span>單據類型</span><select value={documentType} onChange={(event) => setDocumentType(event.target.value as DocumentType)} disabled={busy || documentLoading || Boolean(artifact)}>{(Object.keys(labels) as DocumentType[]).map((type) => <option key={type} value={type}>{labels[type]}</option>)}</select></label><label className="field"><span>單據</span><select value={documentId} onChange={(event) => { keyRef.current = null; setDocumentId(event.target.value); }} disabled={busy || documentLoading || Boolean(artifact)}><option value="">{documentLoading ? "載入單據中…" : "請選擇"}</option>{documents.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label><label className="field"><span>成品類型</span><select value={artifactKind} onChange={(event) => { keyRef.current = null; setArtifactKind(event.target.value as ArtifactKind); }} disabled={busy || Boolean(artifact)}><option value="FORMAL">正式 PDF</option><option value="DRAFT_WATERMARK">草稿（浮水印）</option></select></label></div>
    {documentLoading || artifactLoading ? <p className="sr-only" role="status" aria-live="polite">{documentLoading ? "正在讀取 PDF 單據…" : "正在讀取 PDF 狀態…"}</p> : null}
    <WorkflowActionBar primary={primaryAction} secondary={secondaryActions} />
    {artifact ? <p className={artifact.status === "READY" ? "success-note" : artifact.status === "FAILED" ? "auth-message" : "auth-message"}>第 {artifact.revision} 版／{artifactKind === "FORMAL" ? "正式 PDF" : "草稿 PDF"}／{workflowStatusLabel(artifact.status)}。{artifact.status === "READY" ? "可以下載。" : artifact.status === "FAILED" ? "請重新查詢；若仍失敗，使用相同單據重新請求。" : "檔案仍在準備中，系統會自動更新。"}</p> : null}
    {displayMessage ? <p className={displayMessage.includes("已") ? "success-note" : "auth-message"} role="status">{displayMessage}</p> : null}
  </section>;
}
