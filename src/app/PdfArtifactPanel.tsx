"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

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
  const client = getSupabaseBrowserClient();
  const [documentType, setDocumentType] = useState<DocumentType>("HR_REQUEST");
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [artifactKind, setArtifactKind] = useState<ArtifactKind>("FORMAL");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);
  const [recoveryArtifactId, setRecoveryArtifactId] = useState<string | null>(() => typeof window === "undefined" ? null : window.localStorage.getItem("uniform:pdf-artifact-id"));
  const [recoveryRequestKey, setRecoveryRequestKey] = useState<string | null>(() => typeof window === "undefined" ? null : window.localStorage.getItem("uniform:pdf-request-key"));

  useEffect(() => {
    if (!client || !recoveryArtifactId || artifact) return;
    void client.rpc("get_document_status", { p_artifact_id: recoveryArtifactId, p_idempotency_key: null }).then((result) => {
      if (!result.error && result.data) setArtifact(result.data as Artifact);
    });
  }, [client, recoveryArtifactId, artifact]);

  useEffect(() => {
    if (!client || artifact || !recoveryRequestKey) return;
    void client.rpc("get_document_status", { p_artifact_id: null, p_idempotency_key: `REQUEST-PDF-${recoveryRequestKey}` }).then((result) => {
      if (!result.error && result.data) {
        setArtifact(result.data as Artifact);
        const recovered = result.data as Artifact;
        setRecoveryArtifactId(recovered.id);
        window.localStorage.setItem("uniform:pdf-artifact-id", recovered.id);
      }
    });
  }, [client, recoveryRequestKey, artifact]);

  useEffect(() => {
    if (typeof window !== "undefined") keyRef.current = window.localStorage.getItem("uniform:pdf-request-key");
  }, []);

  const selected = useMemo(() => documents.find((row) => row.id === documentId), [documents, documentId]);

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      const config = sourceConfig[documentType];
      const result = await supabase.from(config.table).select(config.select).order("id", { ascending: false }).limit(100);
      if (!active) return;
      if (result.error) { setMessage("單據載入失敗，請確認角色與 RLS 權限。"); return; }
      const rows = (result.data ?? []).map((row) => {
        const record = row as unknown as Record<string, unknown>;
        const id = String(record.id);
        const label = String(record[config.numberField] ?? id);
        const version = Number(record.row_version ?? 1) || 1;
        return { id, label: `${label}｜${String(record.status ?? "")}`, version, hash: JSON.stringify(record) };
      });
      setDocuments(rows); setDocumentId((current) => current || rows[0]?.id || "");
    }
    void load();
    return () => { active = false; };
  }, [client, documentType]);

  async function requestPdf() {
    if (!client || !selected) { setMessage("請先選擇要產生的單據。"); return; }
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
    if (error || !data?.id) setMessage(`PDF 請求結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else { setArtifact(data as Artifact); window.localStorage.setItem("uniform:pdf-artifact-id", String((data as Artifact).id)); keyRef.current = null; setRecoveryRequestKey(null); window.localStorage.removeItem("uniform:pdf-request-key"); setMessage("已建立不可變 PDF revision；背景 renderer 完成前狀態會維持 PREPARING，可關閉頁面後恢復查詢。"); }
    setBusy(false);
  }

  async function refreshArtifact() {
    if (!client || !artifact) return;
    const result = await client.rpc("get_document_status", { p_artifact_id: artifact.id, p_idempotency_key: null });
    if (result.error) setMessage(`PDF 狀態查詢失敗：${result.error.message}`); else if (result.data) setArtifact(result.data as Artifact);
  }

  async function downloadArtifact() {
    if (!client || !artifact || artifact.status !== "READY") return;
    setBusy(true);
    const result = await client.rpc("download_document", { p_artifact_id: artifact.id });
    if (result.error) setMessage(`PDF 下載結果尚未確認：${result.error.message}`);
    else {
      const payload = result.data as { bucket?: string; object_key?: string };
      if (!payload.bucket || !payload.object_key) setMessage("PDF 已就緒，但下載位置尚未回傳。");
      else {
        const signed = await client.storage.from(payload.bucket).createSignedUrl(payload.object_key, 120);
        if (signed.error || !signed.data?.signedUrl) setMessage(`PDF 簽名下載連結建立失敗：${signed.error?.message ?? "未知錯誤"}`);
        else window.open(signed.data.signedUrl, "_blank", "noopener,noreferrer");
      }
    }
    setBusy(false);
  }

  function startAnother() {
    setArtifact(null); setRecoveryArtifactId(null); setRecoveryRequestKey(null); keyRef.current = null; window.localStorage.removeItem("uniform:pdf-artifact-id"); window.localStorage.removeItem("uniform:pdf-request-key"); setMessage("");
  }

  if (!client) return <section className="panel import-panel" aria-label="正式單據 PDF"><div className="panel-heading"><div><p className="eyebrow">10 / PDF</p><h2>正式單據 PDF</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">設定 Supabase 並登入授權角色後，可從已建立單據請求 A4 PDF artifact；瀏覽器列印預覽仍可立即使用。</p></section>;
  return <section className="panel import-panel" aria-label="正式單據 PDF">
    <div className="panel-heading"><div><p className="eyebrow">10 / PDF</p><h2>正式單據 PDF</h2></div><span className={`status-pill ${artifact?.status === "READY" ? "success" : ""}`}>{artifact?.status ?? "待請求"}</span></div>
    <p className="auth-message">每次請求都固定來源 snapshot、template version 與 revision；READY 成品不可覆寫。若尚未部署背景 renderer，請保留 PREPARING 並稍後重新整理狀態。</p>
    <div className="form-grid"><label className="field"><span>單據類型</span><select value={documentType} onChange={(event) => setDocumentType(event.target.value as DocumentType)} disabled={busy || Boolean(artifact)}>{(Object.keys(labels) as DocumentType[]).map((type) => <option key={type} value={type}>{labels[type]}</option>)}</select></label><label className="field"><span>單據</span><select value={documentId} onChange={(event) => { keyRef.current = null; setDocumentId(event.target.value); }} disabled={busy || Boolean(artifact)}><option value="">請選擇</option>{documents.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label><label className="field"><span>成品類型</span><select value={artifactKind} onChange={(event) => { keyRef.current = null; setArtifactKind(event.target.value as ArtifactKind); }} disabled={busy || Boolean(artifact)}><option value="FORMAL">正式 PDF</option><option value="DRAFT_WATERMARK">草稿（浮水印）</option></select></label></div>
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void requestPdf()} disabled={busy || Boolean(artifact) || !selected}>{busy ? "請求中…" : "請求 A4 PDF"}</button>{artifact ? <button className="secondary-button" type="button" onClick={() => void refreshArtifact()} disabled={busy}>{busy ? "查詢中…" : "重新查詢狀態"}</button> : null}{artifact?.status === "READY" ? <button className="secondary-button" type="button" onClick={() => void downloadArtifact()} disabled={busy}>{busy ? "處理中…" : "下載 PDF"}</button> : null}{artifact ? <button className="secondary-button" type="button" onClick={startAnother} disabled={busy}>建立另一份</button> : null}</div>
    {artifact ? <p className={artifact.status === "READY" ? "success-note" : "auth-message"}>revision {artifact.revision}／{artifactKind}／{artifact.status}。{artifact.status === "READY" && artifact.storage_object_key ? `成品位置：${artifact.storage_object_key}` : artifact.status === "FAILED" ? artifact.error_message ?? "renderer 失敗" : "背景 renderer 尚未完成；不會在前端偽造正式成品。"}</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
