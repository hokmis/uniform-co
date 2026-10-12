"use client";
import { useEffect, useRef, useState } from "react";
import { parsePendingHrRequestReturn, hrReturnFailureMessage, type PendingHrRequestReturn } from "@/src/domain/hr-request-return";
import { readBrowserStorageEntries, writeBrowserStorageEntries, removeBrowserStorageEntries, getBrowserSessionOperationStorage } from "@/src/lib/browser-operation-storage";
import { retrySupabaseRpcAfterSessionRefresh } from "@/src/lib/supabase-session";
import { useWorkspaceSession } from "./workspace-session";
import { usePanelActivity } from "./RetainedPanelSet";

type Props = { request: { id: string; requestNo: string; version: number } | null; disabled: boolean; onPendingChange: (pending: boolean) => void; onReturned: () => void };
export default function HrRequestReturnAction({ request, disabled, onPendingChange, onReturned }: Props) {
  const { client, accountId, authUserId, isAuthenticated, identityLoading, identityError } = useWorkspaceSession();
  const active = usePanelActivity();
  const owner = `${authUserId}:${accountId}`;
  const ownerRef = useRef(owner);
  useEffect(() => { ownerRef.current=owner; },[owner]);
  const storageKey = `hr-request-return:${owner}`;
  const ready = Boolean(client && accountId && isAuthenticated && !identityLoading && !identityError && active);
  const [state, setState] = useState<{ owner: string; pending: PendingHrRequestReturn | null; blocked: boolean }>({ owner: "", pending: null, blocked: true });
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const pending = state.owner === owner ? state.pending : null;
  const blocked = !ready || state.owner !== owner || state.blocked;
  useEffect(() => {
    if (!ready) return;
    let alive=true;
    queueMicrotask(() => {
      if (!alive) return;
      const saved=readBrowserStorageEntries([storageKey],getBrowserSessionOperationStorage());
      let recovered: PendingHrRequestReturn | null=null;
      let invalid=!saved.available;
      if(saved.values[storageKey]) {
        try { recovered=parsePendingHrRequestReturn(JSON.parse(saved.values[storageKey]!)); invalid ||= !recovered; }
        catch { invalid=true; }
      }
      setState({ owner,pending:recovered,blocked:invalid });
      onPendingChange(Boolean(recovered) || invalid);
      if(invalid) setMessage("無法核對安全重試資訊，請先核對需求狀態，勿重複退回。");
    });
    return () => { alive=false; };
  },[owner,ready,storageKey,onPendingChange]);
  async function returnRequest() {
    if(!client || blocked || flight.current || (!pending && (disabled || !request))) return;
    let operation=pending;
    if(!operation) {
      if(!reason.trim()) { setMessage("請填寫退回原因。"); return; }
      if(!window.confirm("退回人資修改？已扣的人資倉發放量會沖回，尚未過帳的發貨草稿將清除。")) return;
      operation={ requestId:request!.id,requestNo:request!.requestNo,version:request!.version,reason:reason.trim(),key:`HR-RETURN-${crypto.randomUUID()}` };
      if(!writeBrowserStorageEntries([[storageKey,JSON.stringify(operation)]],getBrowserSessionOperationStorage())) { setMessage("未送出退回：無法保存安全重試資訊。"); return; }
      setState({ owner,pending:operation,blocked:false }); onPendingChange(true);
    }
    const submittedOwner=owner;
    flight.current=true; setBusy(true);
    try {
      const result=await retrySupabaseRpcAfterSessionRefresh(client,async()=>await client.rpc("return_hr_request_to_hr",{
        p_request_id:operation!.requestId,p_expected_row_version:operation!.version,p_reason:operation!.reason,p_idempotency_key:operation!.key,
      }));
      if(ownerRef.current!==submittedOwner) return;
      if(result.error) {
        const safe=hrReturnFailureMessage(result.error);
        if(safe) { removeBrowserStorageEntries([storageKey],getBrowserSessionOperationStorage()); setState({ owner,pending:null,blocked:false }); onPendingChange(false); setMessage(safe); }
        else setMessage("退回結果未知，請保留原原因並重試同次退回；暫勿確認發貨。");
        return;
      }
      const data=Array.isArray(result.data)?result.data[0]:result.data;
      if(data?.id!==operation.requestId || !data.returned_at) { setMessage("回應尚無法核對，請重試目前退回。"); return; }
      removeBrowserStorageEntries([storageKey],getBrowserSessionOperationStorage()); setState({ owner,pending:null,blocked:false }); onPendingChange(false);
      setReason(""); setMessage(`已退回 ${operation.requestNo}，人資可載入同張需求修改後重新送出。`); onReturned();
    } catch { if(ownerRef.current===submittedOwner) setMessage("連線結果未知，請重試同次退回，勿另建操作。"); }
    finally { flight.current=false; setBusy(false); }
  }
  if(!request && !pending && !state.blocked) return null;
  return <div className="panel">
    <h3>退回人資修改</h3>
    {pending ? <p role="status">待核對退回：{pending.requestNo}。只能沿用原資料重試，不能同時發貨。</p> : <p>僅能退回尚未完成發貨的人資需求；沖回已扣量並保留原因與原單號。</p>}
    <label className="field"><span>退回原因（必填）</span><textarea maxLength={2000} value={pending?.reason ?? reason} onChange={(event)=>setReason(event.target.value)} disabled={busy || blocked || Boolean(pending) || disabled} /></label>
    <button type="button" className="secondary-button" onClick={()=>void returnRequest()} disabled={busy || blocked || (!pending && (disabled || !request))}>{busy?"退回中…":pending?"重試目前退回":"退回人資修改"}</button>
    <p role="status" aria-live="polite">{message}</p>
  </div>;
}
