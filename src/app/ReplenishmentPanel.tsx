"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

type ItemOption = { id: string; item_code: string; item_name: string; unit: string; size: string | null };
type RequestLine = { itemId: string; quantity: number };

const previewItems: ItemOption[] = [
  { id: "item-m", item_code: "U-M", item_name: "測試上衣", unit: "件", size: "M" },
  { id: "item-l", item_code: "U-L", item_name: "測試長褲", unit: "件", size: "L" },
];

function requestNo() {
  return `REP-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export default function ReplenishmentPanel() {
  const client = getSupabaseBrowserClient();
  const [items, setItems] = useState<ItemOption[]>(previewItems);
  const [lines, setLines] = useState<RequestLine[]>([{ itemId: previewItems[0].id, quantity: 1 }]);
  const [note, setNote] = useState("");
  const [dataReady, setDataReady] = useState(!client);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const operationRef = useRef<{ createKey: string; submitKey: string; draftId?: string } | null>(null);

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function loadItems() {
      const { data, error } = await supabase
        .from("uniform_items")
        .select("id,item_code,item_name,unit,size")
        .eq("is_active", true)
        .order("item_code");
      if (!active) return;
      if (error || !data || data.length === 0) {
        setDataReady(false);
        setMessage("正式制服品號載入失敗或沒有可用品號，請確認 HR 角色與 RLS 權限。");
        return;
      }
      const loaded = data as ItemOption[];
      setItems(loaded);
      setLines([{ itemId: loaded[0].id, quantity: 1 }]);
      setDataReady(true);
    }
    void loadItems();
    return () => { active = false; };
  }, [client]);

  function updateLine(index: number, field: keyof RequestLine, value: string) {
    operationRef.current = null;
    setLines((current) => current.map((line, lineIndex) => lineIndex === index
      ? { ...line, [field]: field === "quantity" ? Math.max(0, Number(value) || 0) : value }
      : line));
  }

  function addLine() {
    const available = items.find((item) => !lines.some((line) => line.itemId === item.id));
    if (available) {
      operationRef.current = null;
      setLines((current) => [...current, { itemId: available.id, quantity: 1 }]);
    }
  }

  function removeLine(index: number) {
    operationRef.current = null;
    setLines((current) => current.length === 1 ? current : current.filter((_, lineIndex) => lineIndex !== index));
  }

  async function submit() {
    if (!client) {
      setMessage("預覽模式：設定 Supabase env 並登入 HR 帳號後才能建立補庫單。");
      return;
    }
    if (!dataReady || submitted || lines.some((line) => !line.itemId || line.quantity < 1)) {
      setMessage("請確認每個補庫品項都有正整數數量。");
      return;
    }
    if (new Set(lines.map((line) => line.itemId)).size !== lines.length) {
      setMessage("同一補庫單不可重複相同品號。");
      return;
    }
    setBusy(true);
    setMessage("");
    const operation = operationRef.current ?? { createKey: crypto.randomUUID(), submitKey: crypto.randomUUID() };
    operationRef.current = operation;
    const payload = lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity }));
    let draftId = operation.draftId;
    if (!draftId) {
      const { data, error } = await client.rpc("create_replenishment_draft", {
        p_request_no: requestNo(),
        p_note: note.trim() || null,
        p_lines: payload,
        p_idempotency_key: `CREATE-REPLENISHMENT-${operation.createKey}`,
        p_request_fingerprint: JSON.stringify({ payload, note: note.trim() }),
      });
      if (error || !data?.id) {
        setMessage(error?.message ?? "補庫草稿建立失敗；再次確認會沿用相同冪等鍵。");
        setBusy(false);
        return;
      }
      draftId = data.id as string;
      operation.draftId = draftId;
    }
    const { data, error } = await client.rpc("submit_replenishment_request", {
      p_request_id: draftId,
      p_idempotency_key: `SUBMIT-REPLENISHMENT-${operation.submitKey}`,
      p_request_fingerprint: JSON.stringify({ requestId: draftId, payload }),
    });
    if (error) {
      setMessage(`送出結果未知或失敗：${error.message}；再次確認會沿用相同冪等鍵。`);
    } else {
      setSubmitted(true);
      setMessage(`補庫單 ${data?.request_no ?? ""} 已送出，倉庫可依現有總倉庫存 POST 調庫。`);
    }
    setBusy(false);
  }

  if (!client) {
    return <section className="panel import-panel" aria-label="額外補庫申請"><div className="panel-heading"><div><p className="eyebrow">06 / REPLENISHMENT</p><h2>額外補庫申請</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">設定 Supabase env 並登入 HR 帳號後，可建立不預留庫存的補庫單；倉庫 POST 時才依總倉現有庫存調庫。</p></section>;
  }

  return (
    <section className="panel import-panel" aria-label="額外補庫申請">
      <div className="panel-heading"><div><p className="eyebrow">06 / REPLENISHMENT</p><h2>額外補庫申請</h2></div><span className={`status-pill ${submitted ? "success" : ""}`}>{submitted ? "已送出" : "草稿"}</span></div>
      <p className="auth-message">補庫單不預留庫存；倉庫收到後以總倉當下可用量 POST，短發項目另填原因。</p>
      <label className="field"><span>備註（選填）</span><input value={note} onChange={(event) => { operationRef.current = null; setNote(event.target.value); }} disabled={busy || submitted} maxLength={2000} placeholder="例如：換季前補足人資倉常用尺寸" /></label>
      <div className="summary-list">
        {lines.map((line, index) => {
          const item = items.find((option) => option.id === line.itemId);
          return <div className="summary-row" key={`${line.itemId}-${index}`}>
            <label className="field"><span>制服品號</span><select value={line.itemId} onChange={(event) => updateLine(index, "itemId", event.target.value)} disabled={busy || submitted}>{items.map((option) => <option key={option.id} value={option.id}>{option.item_code}｜{option.item_name}{option.size ? `｜${option.size}` : ""}</option>)}</select><small>{item?.unit ?? ""}</small></label>
            <label className="field"><span>申請數量</span><input type="number" min={1} max={999999999} value={line.quantity} onChange={(event) => updateLine(index, "quantity", event.target.value)} disabled={busy || submitted} /></label>
            <button className="text-button" type="button" onClick={() => removeLine(index)} disabled={busy || submitted || lines.length === 1}>移除</button>
          </div>;
        })}
      </div>
      <div className="button-row"><button className="secondary-button" type="button" onClick={addLine} disabled={busy || submitted || lines.length >= items.length}>新增品號</button><button className="primary-button" type="button" onClick={() => void submit()} disabled={busy || submitted || !dataReady}>{busy ? "送出中…" : submitted ? "已送出" : "建立並送出補庫單"}</button></div>
      {message ? <p className={message.startsWith("補庫單") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
    </section>
  );
}
