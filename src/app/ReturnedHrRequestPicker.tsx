"use client";
import { useEffect, useRef, useState } from "react";
import { useWorkspaceSession } from "./workspace-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { retrySupabaseQueriesAfterSessionRefresh } from "@/src/lib/supabase-session";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";

type ReturnedHeader = { id:string;request_no:string;distribution_date:string;note:string|null;return_reason:string|null;row_version:number };
export type ReturnedHrDraft = ReturnedHeader & { issueLines:Array<{ employee_id:string;item_id:string;quantity:number }>; increases:Array<{ item_id:string;increase_quantity:number }> };
type Props = { disabled:boolean;onLoad:(draft:ReturnedHrDraft)=>void;onLoadingChange:(loading:boolean)=>void };
export default function ReturnedHrRequestPicker({ disabled,onLoad,onLoadingChange }:Props) {
  const { client,accountId,isAuthenticated,identityLoading,identityError }=useWorkspaceSession();
  const active=usePanelActivity();
  const ready=Boolean(client && active && accountId && isAuthenticated && !identityLoading && !identityError);
  const [snapshot,setSnapshot]=useState<{ owner:string|null;rows:ReturnedHeader[] }>({ owner:null,rows:[] });
  const [selected,setSelected]=useState("");
  const [message,setMessage]=useState("");
  const [reload,setReload]=useState(0);
  const sequence=useRef(0);
  const ownerRef=useRef(accountId);
  useEffect(()=>{ ownerRef.current=accountId; sequence.current++; queueMicrotask(()=>onLoadingChange(false)); },[accountId,active,onLoadingChange]);
  useEffect(()=>{
    if(!ready || !client) return;
    let alive=true;
    async function read() {
      const [result]=await retrySupabaseQueriesAfterSessionRefresh(client!,async()=>[await client!.from("hr_requests")
        .select("id,request_no,distribution_date,note,return_reason,row_version").eq("created_by",accountId!).eq("status","DRAFT")
        .not("returned_at","is",null).order("returned_at",{ascending:false}).limit(100)] as const);
      if(!alive) return;
      if(result.error) { setSnapshot({owner:null,rows:[]});setMessage("退回需求讀取失敗，請重新整理。");return; }
      setSnapshot({owner:accountId,rows:result.data ?? []});setMessage("");
    }
    void read();
    const refresh=()=>setReload(value=>value+1);
    window.addEventListener(hrRequestWorkflowChangedEvent,refresh);
    return()=>{ alive=false;window.removeEventListener(hrRequestWorkflowChangedEvent,refresh); };
  },[ready,client,accountId,reload]);
  const rows=snapshot.owner===accountId && ready?snapshot.rows:[];
  async function loadSelected() {
    if(!client || !ready || disabled || !selected) return;
    if(!window.confirm("載入退回單據會替換目前表單，是否繼續？")) return;
    const request=rows.find(row=>row.id===selected);
    if(!request) return;
    const token=++sequence.current,owner=accountId;
    onLoadingChange(true);
    try {
      const [header,issues,items]=await retrySupabaseQueriesAfterSessionRefresh(client,async()=>await Promise.all([
        client.from("hr_requests").select("id,request_no,distribution_date,note,return_reason,row_version").eq("id",request.id).eq("created_by",owner!).eq("status","DRAFT").not("returned_at","is",null).maybeSingle(),
        client.from("hr_issue_lines").select("employee_id,item_id,quantity").eq("request_id",request.id).order("line_no"),
        client.from("hr_request_items").select("item_id,increase_quantity").eq("request_id",request.id),
      ] as const));
      if(token!==sequence.current || ownerRef.current!==owner) return;
      if(header.error || issues.error || items.error || !header.data) { setMessage("退回單據已變更或無法讀取，未覆蓋表單。");return; }
      onLoad({ ...header.data,issueLines:issues.data ?? [],increases:items.data ?? [] });
      setMessage(`已載入 ${header.data.request_no}。退回原因：${header.data.return_reason ?? "請查看單據"}。修改後重新送出同張單據。`);
    } catch { if(token===sequence.current) setMessage("讀取失敗，未覆蓋目前表單。"); }
    finally { if(token===sequence.current) onLoadingChange(false); }
  }
  return (
    <div className="returned-request-section" style={{ marginTop: "24px", paddingTop: "16px", borderTop: "1px dashed var(--line, #e5e9ef)" }}>
      <label className="field">
        <span style={{ fontWeight: 600 }}>退回待修改需求（保留原單號）</span>
        <select value={rows.some(row=>row.id===selected)?selected:""} disabled={disabled || !ready} onChange={event=>{sequence.current++;onLoadingChange(false);setSelected(event.target.value);}}>
          <option value="">{rows.length > 0 ? "請選擇退回需求" : "目前無退回待修改的需求單"}</option>
          {rows.map(row=><option key={row.id} value={row.id}>{row.request_no}｜{row.return_reason}</option>)}
        </select>
      </label>
      <div className="button-row" style={{ marginTop: "8px" }}>
        <button type="button" className="secondary-button" disabled={disabled || !selected || !ready} onClick={()=>void loadSelected()}>載入退回需求修改</button>
        <button type="button" className="secondary-button" disabled={disabled || !ready} onClick={()=>setReload(value=>value+1)}>重新整理退回需求</button>
      </div>
      {message ? <p role="status" aria-live="polite" className="auth-message" style={{ marginTop: "8px" }}>{message}</p> : null}
    </div>
  );
}
