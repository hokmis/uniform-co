"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterProcurementReasons,
  sortProcurementReasons,
  type ProcurementReason,
  type ProcurementReasonSortDirection,
  type ProcurementReasonSortKey,
  type ProcurementReasonStatusFilter,
} from "@/src/domain/procurement-reason-management";
import { invalidateMasterDataCache } from "@/src/lib/master-data-cache";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { createReadRequestController, shouldPreserveReadSnapshot, staleReadSnapshotMessage, type ReadRequestController } from "@/src/domain/read-refresh";
import ManagementCatalogTable from "./ManagementCatalogTable";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

export default function ProcurementReasonCodePanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [reasons, setReasons] = useState<ProcurementReason[]>([]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [editorMode, setEditorMode] = useState<"CREATE" | "EDIT">("CREATE");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProcurementReasonStatusFilter>("ALL");
  const [sortKey, setSortKey] = useState<ProcurementReasonSortKey>("code");
  const [sortDirection, setSortDirection] = useState<ProcurementReasonSortDirection>("asc");
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [dataSnapshotAccountId, setDataSnapshotAccountId] = useState<string | null>(null);
  const operationKeyRef = useRef<string | null>(null);
  const reasonsRef = useRef<ProcurementReason[]>([]);
  const dataSnapshotAccountIdRef = useRef<string | null>(null);
  const readControllerRef = useRef<ReadRequestController | null>(null);
  const editorHeadingRef = useRef<HTMLDivElement>(null);

  const hasCurrentDataSnapshot = Boolean(
    identityReady
      && dataSnapshotAccountId
      && dataSnapshotAccountId === accountId,
  );
  const visibleReasons = useMemo(() => hasCurrentDataSnapshot ? reasons : [], [hasCurrentDataSnapshot, reasons]);

  useEffect(() => {
    if (!identityReady || !client) {
      return;
    }
    const supabase = client;
    const readController = readControllerRef.current ?? createReadRequestController();
    readControllerRef.current = readController;
    let active = true;
    const readSequence = readController.begin();
    async function loadReasons() {
      setDataLoading(true);
      try {
        const [result] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("procurement_difference_reasons").select("code,name,is_active").order("code")] as const,
        );
        if (!active || !readController.isCurrent(readSequence)) return;
        if (result.error) {
          const preserveSnapshot = dataSnapshotAccountIdRef.current === accountId
            && shouldPreserveReadSnapshot(reasonsRef.current, [result.error]);
          if (!preserveSnapshot) {
            reasonsRef.current = [];
            setReasons([]);
            dataSnapshotAccountIdRef.current = null;
            setDataSnapshotAccountId(null);
          }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("採購差異原因碼")
            : `${safeSupabaseReadErrorMessage(result.error)} 只有 SYSTEM_ADMIN 可維護。`);
        } else {
          const loaded = (result.data ?? []) as ProcurementReason[];
          reasonsRef.current = loaded;
          setReasons(loaded);
          dataSnapshotAccountIdRef.current = accountId;
          setDataSnapshotAccountId(accountId);
          setMessage(`已載入 ${loaded.length} 筆原因碼；停用只影響後續採購選擇，不改歷史資料。`);
        }
      } finally {
        if (active && readController.isCurrent(readSequence)) setDataLoading(false);
      }
    }
    void loadReasons();
    return () => { active = false; };
  }, [accountId, client, identityError, identityReady, panelActive, reloadToken]);

  const filteredReasons = useMemo(
    () => sortProcurementReasons(filterProcurementReasons(visibleReasons, query, statusFilter), sortKey, sortDirection),
    [query, sortDirection, sortKey, statusFilter, visibleReasons],
  );
  const displayMessage = identityError ?? message;

  function resetEditor() {
    operationKeyRef.current = null;
    setEditorMode("CREATE");
    setCode("");
    setName("");
    setIsActive(true);
    window.requestAnimationFrame(() => editorHeadingRef.current?.focus());
  }

  function editReason(reason: ProcurementReason) {
    operationKeyRef.current = null;
    setEditorMode("EDIT");
    setCode(reason.code);
    setName(reason.name);
    setIsActive(reason.is_active);
    setMessage(`正在編輯原因碼 ${reason.code}；代碼建立後不可改名。`);
    window.requestAnimationFrame(() => editorHeadingRef.current?.focus());
  }

  function toggleSort(nextKey: ProcurementReasonSortKey) {
    if (sortKey === nextKey) setSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else {
      setSortKey(nextKey);
      setSortDirection("asc");
    }
    setPage(1);
  }

  async function save() {
    if (!identityReady || !client || !code.trim() || !name.trim()) { setMessage(identityError ?? "請輸入原因碼與名稱。"); return; }
    setBusy(true); setMessage("");
    readControllerRef.current?.invalidate();
    const key = operationKeyRef.current ?? crypto.randomUUID();
    operationKeyRef.current = key;
    const { data, error } = await client.rpc("maintain_procurement_difference_reason", {
      p_code: code.trim().toUpperCase(), p_name: name.trim(), p_is_active: isActive,
      p_idempotency_key: `PROCUREMENT-REASON-${key}`,
      p_request_fingerprint: JSON.stringify({ code: code.trim().toUpperCase(), name: name.trim(), isActive }),
    });
    if (error) setMessage(safeSupabaseMutationErrorMessage(error, "原因碼維護失敗；請使用相同資料重試。"));
    else {
      const saved = data as ProcurementReason;
      setReasons((rows) => {
        const next = [...rows.filter((row) => row.code !== saved.code), saved].sort((a, b) => a.code.localeCompare(b.code));
        reasonsRef.current = next;
        return next;
      });
      setMessage(`原因碼 ${saved.code} 已${editorMode === "EDIT" ? "更新" : "新增"}，目前為${saved.is_active ? "啟用" : "停用"}。`);
      operationKeyRef.current = null;
      setEditorMode("EDIT");
      setCode(saved.code);
      setName(saved.name);
      setIsActive(saved.is_active);
      invalidateMasterDataCache(client, "procurement");
      if (!hasCurrentDataSnapshot) setReloadToken((value) => value + 1);
    }
    setBusy(false);
  }

  if (!client) return null;
  return <section className="panel import-panel" aria-label="採購差異原因碼維護" aria-busy={dataLoading || busy}>
    <div className="panel-heading"><div><p className="eyebrow">12 / REASON CODES</p><h2>採購差異原因碼</h2></div><div className="product-action-bar"><span className="status-pill">SYSTEM_ADMIN 維護</span><button className="secondary-button" type="button" onClick={() => setReloadToken((value) => value + 1)} disabled={busy}>{dataLoading ? "讀取中…" : "重新整理"}</button><button className="secondary-button" type="button" onClick={resetEditor} disabled={busy}>＋ 新增原因碼</button></div></div>
    <p className="auth-message">原因碼停用不會影響歷史採購決策；採購量與核准量不同時，必須使用啟用中的原因碼。</p>

    <div className="management-catalog-metrics procurement-reason-metrics" aria-label="原因碼摘要">
      <div className="metric"><span>全部原因碼</span><strong>{visibleReasons.length}</strong><small>目前可讀取設定</small></div>
      <div className="metric"><span>啟用中</span><strong>{visibleReasons.filter((reason) => reason.is_active).length}</strong><small>可供採購流程使用</small></div>
      <div className="metric"><span>已停用</span><strong>{visibleReasons.filter((reason) => !reason.is_active).length}</strong><small>僅保留歷史參照</small></div>
      <div className="metric"><span>目前模式</span><strong className="procurement-reason-mode">{editorMode === "EDIT" ? "修改" : "新增"}</strong><small>{editorMode === "EDIT" ? code : "建立新代碼"}</small></div>
    </div>

    <div className="subheading procurement-reason-editor-heading" ref={editorHeadingRef} tabIndex={-1}><h3>{editorMode === "EDIT" ? `修改原因碼 ${code}` : "新增原因碼"}</h3><span>{editorMode === "EDIT" ? "可調整名稱與啟用狀態；代碼不可修改" : "輸入未使用過的代碼與名稱"}</span></div>
    <div className="form-grid">
      <label className="field"><span>原因碼</span><input value={code} onChange={(event) => { operationKeyRef.current = null; setCode(event.target.value.toUpperCase()); }} maxLength={40} disabled={busy || editorMode === "EDIT"} placeholder="例如 MOQ" /></label>
      <label className="field"><span>名稱</span><input value={name} onChange={(event) => { operationKeyRef.current = null; setName(event.target.value); }} maxLength={120} disabled={busy} placeholder="例如 符合最低採購量" /></label>
      <label className="field"><span>狀態</span><select value={isActive ? "ACTIVE" : "INACTIVE"} onChange={(event) => { operationKeyRef.current = null; setIsActive(event.target.value === "ACTIVE"); }} disabled={busy}><option value="ACTIVE">啟用</option><option value="INACTIVE">停用</option></select></label>
    </div>
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void save()} disabled={busy || !identityReady || !code.trim() || !name.trim()}>{busy ? "保存中…" : editorMode === "EDIT" ? "儲存修改" : "新增原因碼"}</button>{editorMode === "EDIT" ? <button className="secondary-button" type="button" onClick={resetEditor} disabled={busy}>取消修改</button> : null}</div>

    <div className="management-catalog-filters procurement-reason-filters">
      <label className="field"><span>搜尋原因碼</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜尋代碼或名稱…" /></label>
      <label className="field"><span>啟用狀態</span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as ProcurementReasonStatusFilter); setPage(1); }}><option value="ALL">全部狀態</option><option value="ACTIVE">啟用</option><option value="INACTIVE">停用</option></select></label>
    </div>
    <div className="management-catalog-result"><p className="muted">符合條件 {filteredReasons.length} 筆</p>{query || statusFilter !== "ALL" ? <button className="text-button" type="button" onClick={() => { setQuery(""); setStatusFilter("ALL"); setPage(1); }}>清除篩選</button> : null}</div>
    <ManagementCatalogTable<ProcurementReason, ProcurementReasonSortKey>
      ariaLabel="採購差異原因碼"
      rows={filteredReasons}
      rowKey={(reason) => reason.code}
      page={page}
      onPageChange={setPage}
      sortKey={sortKey}
      sortDirection={sortDirection}
      onSort={toggleSort}
      loading={dataLoading && visibleReasons.length === 0}
      defaultPageSize={10}
      pageSizeOptions={[10, 25, 50]}
      emptyState={<p className="empty-state">尚無符合條件的原因碼。請調整篩選，或使用上方新增原因碼。</p>}
      columns={[
        { id: "code", label: "原因碼", sortKey: "code", locked: true, render: (reason) => <strong>{reason.code}</strong> },
        { id: "name", label: "名稱", sortKey: "name", render: (reason) => reason.name },
        { id: "status", label: "狀態", sortKey: "status", render: (reason) => <span className={`status-pill ${reason.is_active ? "success" : "danger"}`}>{reason.is_active ? "啟用" : "停用"}</span> },
        { id: "actions", label: "功能", locked: true, render: (reason) => <button className="management-row-action" type="button" onClick={() => editReason(reason)}>{editorMode === "EDIT" && code === reason.code ? "編輯中" : "編輯"}</button> },
      ]}
    />
    {displayMessage ? <p className={displayMessage.includes("已") ? "success-note" : "auth-message"} role="status">{displayMessage}</p> : null}
  </section>;
}
