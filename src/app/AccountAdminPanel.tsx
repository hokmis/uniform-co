"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildAccountDirectoryRows,
  filterAccountDirectory,
  sortAccountDirectory,
  type AccountDirectoryRecord,
  type AccountDirectorySortDirection,
  type AccountDirectorySortKey,
  type AccountDirectoryStatusFilter,
} from "@/src/domain/account-directory";
import { accountHasEffectiveRole, effectiveAccountRoles } from "@/src/domain/account-roles";
import { applyAccountAdminLocalResult, type AccountAdminLocalAccount, type AccountAdminLocalRoleRow, type AccountAdminLocalScopeRow } from "@/src/domain/account-admin-local-state";
import { loadAccountDirectory } from "@/src/lib/account-directory-read";
import { loadOrganizationMasterData } from "@/src/lib/master-data-cache";
import { retrySupabaseQueriesAfterSessionRefresh } from "@/src/lib/supabase-session";
import { validateAccountCreation } from "@/src/lib/account-admin-form";
import ManagementCatalogTable from "./ManagementCatalogTable";
import { ModuleWorkbenchNavigation } from "./ModuleWorkbench";
import RetainedPanelSet, { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceAccessToken, useWorkspaceSession } from "./workspace-session";

type Account = AccountAdminLocalAccount;
type Role = "SYSTEM_ADMIN" | "HR" | "WAREHOUSE" | "PROCUREMENT" | "CEO" | "DEMAND_COORDINATOR";
type RoleRow = AccountAdminLocalRoleRow;
type Institution = { id: string; code: string; name: string };
type Department = { id: string; institution_id: string; code: string; name: string };
type ScopeRow = AccountAdminLocalScopeRow;
type OperationPayload = Record<string, unknown>;
type OperationResult = { ok: boolean; account?: Account; warning?: string; error?: string };
type AccountAdminTab = "directory" | "create" | "manage";

const roles: Role[] = ["SYSTEM_ADMIN", "HR", "WAREHOUSE", "PROCUREMENT", "CEO", "DEMAND_COORDINATOR"];

type Props = { headingId?: string };

export default function AccountAdminPanel({ headingId }: Props) {
  const panelActive = usePanelActivity();
  const { client, isAuthenticated, accountId: workspaceAccountId, identityError, identityLoading } = useWorkspaceSession();
  const accessToken = useWorkspaceAccessToken();
  const identityReady = Boolean(client && panelActive && isAuthenticated && workspaceAccountId && !identityLoading && !identityError);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [roleRows, setRoleRows] = useState<RoleRow[]>([]);
  const [scopeRows, setScopeRows] = useState<ScopeRow[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loginName, setLoginName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [createRoleCodes, setCreateRoleCodes] = useState<Role[]>(["HR"]);
  const [editLoginName, setEditLoginName] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [editRoleCodes, setEditRoleCodes] = useState<Role[]>([]);
  const [institutionId, setInstitutionId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [scopeEnabled, setScopeEnabled] = useState(true);
  const [newAuthUserId, setNewAuthUserId] = useState("");
  const [unbindAuth, setUnbindAuth] = useState(false);
  const [recoveryTicket, setRecoveryTicket] = useState("");
  const [reason, setReason] = useState("初始帳號與權限設定");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const [busy, setBusy] = useState(false);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [scopeDataLoading, setScopeDataLoading] = useState(false);
  const [organizationOptionsLoading, setOrganizationOptionsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<AccountAdminTab>("directory");
  const [accountQuery, setAccountQuery] = useState("");
  const [accountStatus, setAccountStatus] = useState<AccountDirectoryStatusFilter>("ALL");
  const [accountSortKey, setAccountSortKey] = useState<AccountDirectorySortKey>("display_name");
  const [accountSortDirection, setAccountSortDirection] = useState<AccountDirectorySortDirection>("asc");
  const [accountPage, setAccountPage] = useState(1);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const operationRefs = useRef<Record<string, string>>({});
  const manageLoadSequence = useRef(0);
  const directoryLoadSequence = useRef(0);
  const [directorySnapshotAccountId, setDirectorySnapshotAccountId] = useState<string | null>(null);
  const directorySnapshotAccountIdRef = useRef<string | null>(null);

  const hasCurrentDirectorySnapshot = Boolean(
    identityReady
      && directorySnapshotAccountId
      && directorySnapshotAccountId === workspaceAccountId,
  );
  const visibleAccounts = useMemo(() => hasCurrentDirectorySnapshot ? accounts : [], [accounts, hasCurrentDirectorySnapshot]);
  const visibleRoleRows = useMemo(() => hasCurrentDirectorySnapshot ? roleRows : [], [hasCurrentDirectorySnapshot, roleRows]);

  const selected = visibleAccounts.find((account) => account.id === selectedId) ?? null;
  const selectedRoles = useMemo(
    () => effectiveAccountRoles(visibleRoleRows.filter((row) => row.account_id === selectedId).map((row) => row.role_code)),
    [selectedId, visibleRoleRows],
  );
  const selectedScopes = useMemo(() => scopeRows.filter((row) => row.account_id === selectedId), [scopeRows, selectedId]);
  const manageOptionsReady = institutions.length > 0 || departments.length > 0;
  const scopeActionLabel = busy
    ? "保存中…"
    : scopeDataLoading
      ? "讀取範圍中…"
      : !manageOptionsReady
        ? organizationOptionsLoading ? "載入機構／部門中…" : "目前沒有可用機構／部門"
        : scopeEnabled ? "授權窗口範圍" : "撤銷窗口範圍";
  const filteredDepartments = departments.filter((department) => department.institution_id === institutionId);
  const accountDirectoryRows = useMemo<AccountDirectoryRecord[]>(
    () => buildAccountDirectoryRows(visibleAccounts, visibleRoleRows),
    [visibleAccounts, visibleRoleRows],
  );
  const filteredAccounts = useMemo(
    () => sortAccountDirectory(filterAccountDirectory(accountDirectoryRows, accountQuery, accountStatus), accountSortKey, accountSortDirection),
    [accountDirectoryRows, accountQuery, accountSortDirection, accountSortKey, accountStatus],
  );
  const displayMessage = identityError ?? message;

  const fetchDirectoryData = useCallback(async () => {
    if (!identityReady || !client) return null;
    const directoryResult = await loadAccountDirectory(client);
    if (directoryResult.error) {
      throw new Error("帳號資料載入失敗；請確認目前登入帳號具有 SYSTEM_ADMIN 角色。");
    }
    return {
      accounts: directoryResult.accounts,
      roleRows: directoryResult.roleRows,
    };
  }, [client, identityReady]);

  const fetchScopeRows = useCallback(async (accountId: string) => {
    if (!identityReady || !client || !accountId) return null;
    const [scopeResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("coordinator_scopes").select("account_id,institution_id,department_id").eq("account_id", accountId)] as const,
    );
    if (scopeResult.error) {
      throw new Error("需求窗口範圍載入失敗；請確認目前登入帳號具有 SYSTEM_ADMIN 角色。");
    }
    return (scopeResult.data ?? []) as ScopeRow[];
  }, [client, identityReady]);

  const fetchManageOptions = useCallback(async () => {
    if (!identityReady || !client) return null;
    const organizationResult = await loadOrganizationMasterData(client);
    if (organizationResult.errors.length > 0) {
      throw new Error("機構／部門選項載入失敗；請確認目前登入帳號具有 SYSTEM_ADMIN 角色。");
    }
    return {
      institutions: organizationResult.institutions.filter((row) => row.is_active) as Institution[],
      departments: organizationResult.departments.filter((row) => row.is_active) as Department[],
    };
  }, [client, identityReady]);

  const applyDirectoryData = useCallback((data: NonNullable<Awaited<ReturnType<typeof fetchDirectoryData>>>) => {
    setAccounts(data.accounts);
    setRoleRows(data.roleRows);
    directorySnapshotAccountIdRef.current = workspaceAccountId;
    setDirectorySnapshotAccountId(workspaceAccountId);
  }, [workspaceAccountId]);

  const clearDirectorySnapshot = useCallback(() => {
    setAccounts([]);
    setRoleRows([]);
    directorySnapshotAccountIdRef.current = null;
    setDirectorySnapshotAccountId(null);
  }, []);

  const applyManageData = useCallback((data: NonNullable<Awaited<ReturnType<typeof fetchScopeRows>>> | null) => {
    if (data) setScopeRows(data);
  }, []);

  const applyManageOptions = useCallback((data: NonNullable<Awaited<ReturnType<typeof fetchManageOptions>>> | null) => {
    if (!data) return;
    setInstitutions(data.institutions);
    setDepartments(data.departments);
  }, []);

  const loadDirectory = useCallback(async () => {
    const sequence = directoryLoadSequence.current + 1;
    directoryLoadSequence.current = sequence;
    setDirectoryLoading(true);
    try {
      const data = await fetchDirectoryData();
      if (sequence !== directoryLoadSequence.current) return null;
      if (data) applyDirectoryData(data);
      return data;
    } catch {
      if (sequence !== directoryLoadSequence.current) return null;
      clearDirectorySnapshot();
      setMessageKind("error");
      setMessage("帳號資料載入失敗；請確認目前登入帳號具有 SYSTEM_ADMIN 角色後重新整理。");
      return null;
    } finally {
      if (sequence === directoryLoadSequence.current) setDirectoryLoading(false);
    }
  }, [applyDirectoryData, clearDirectorySnapshot, fetchDirectoryData]);

  async function loadManageData(accountId: string) {
    if (!client || !accountId) return null;
    const sequence = manageLoadSequence.current + 1;
    manageLoadSequence.current = sequence;
    setScopeDataLoading(true);
    setOrganizationOptionsLoading(true);

    const scopeRead = (async () => {
      try {
        const data = await fetchScopeRows(accountId);
        if (sequence === manageLoadSequence.current) applyManageData(data);
      } catch {
        if (sequence === manageLoadSequence.current) {
          setMessageKind("error");
          setMessage("需求窗口範圍載入失敗；請確認目前登入帳號具有 SYSTEM_ADMIN 角色後重試。");
        }
      } finally {
        if (sequence === manageLoadSequence.current) setScopeDataLoading(false);
      }
    })();

    const optionsRead = (async () => {
      try {
        const data = await fetchManageOptions();
        if (sequence === manageLoadSequence.current) applyManageOptions(data);
      } catch {
        if (sequence === manageLoadSequence.current) {
          setMessageKind("error");
          setMessage("機構／部門選項載入失敗；請確認目前登入帳號具有 SYSTEM_ADMIN 角色後重試。");
        }
      } finally {
        if (sequence === manageLoadSequence.current) setOrganizationOptionsLoading(false);
      }
    })();

    await Promise.all([scopeRead, optionsRead]);
    return null;
  }

  async function refreshAccounts() {
    if (busy) return;
    const data = await loadDirectory();
    if (data && activeTab === "manage" && selectedId) await loadManageData(selectedId);
  }

  useEffect(() => {
    if (!identityReady || !client) return;
    let active = true;
    queueMicrotask(() => {
      if (active) void loadDirectory();
    });
    return () => {
      active = false;
      directoryLoadSequence.current += 1;
    };
  }, [client, identityReady, loadDirectory, panelActive]);

  function resetOperation(name: string) { delete operationRefs.current[name]; }
  function operationKey(name: string) { return operationRefs.current[name] ?? (operationRefs.current[name] = crypto.randomUUID()); }

  function selectAccount(account: Account) {
    setSelectedId(account.id);
    setEditLoginName(account.login_name ?? "");
    setEditDisplayName(account.display_name);
    setEditEmail(account.email_snapshot ?? "");
    setEditRoleCodes(visibleRoleRows.filter((row) => row.account_id === account.id).map((row) => row.role_code));
    setInstitutionId("");
    setDepartmentId("");
    setScopeEnabled(true);
    setScopeRows([]);
    setDeleteConfirming(false);
    setActiveTab("manage");
    resetOperation("profile");
    resetOperation("password");
    resetOperation("roles");
    resetOperation("status");
    resetOperation("delete");
    resetOperation("scope");
    resetOperation("rebind");
    void loadManageData(account.id);
  }

  function selectAccountById(accountId: string) {
    const account = visibleAccounts.find((candidate) => candidate.id === accountId);
    if (account) selectAccount(account);
  }

  function handleTabChange(tabId: string) {
    const nextTab = tabId as AccountAdminTab;
    setActiveTab(nextTab);
    if (nextTab === "manage" && selectedId) void loadManageData(selectedId);
  }

  function toggleAccountSort(nextKey: AccountDirectorySortKey) {
    if (accountSortKey === nextKey) setAccountSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else {
      setAccountSortKey(nextKey);
      setAccountSortDirection("asc");
    }
    setAccountPage(1);
  }

  async function runOperation(payload: OperationPayload, operationName: string): Promise<OperationResult | null> {
    if (!identityReady || !client) return null;
    if (!accessToken) {
      throw new Error("登入工作階段不存在或已過期，請重新登入。");
    }
    const response = await fetch("/api/admin/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ...payload, idempotency_key: operationKey(operationName) }),
    });
    const result = await response.json() as OperationResult;
    if (!response.ok || !result.ok) {
      throw new Error("帳號管理操作未完成；請確認權限與操作理由後，使用相同按鈕重試。" );
    }
    resetOperation(operationName);
    setMessageKind(result.warning ? "error" : "success");
    setMessage(result.warning ? "帳號資料已保存，但登入服務同步尚未完成；請重新整理後確認。" : "帳號管理操作已完成。");
    if (result.account) {
      const roleCodes = Array.isArray(payload.role_codes)
        ? payload.role_codes.filter((role): role is Role => roles.includes(role as Role))
        : undefined;
      const roleCode = roles.includes(payload.role_code as Role) ? payload.role_code as Role : undefined;
      const scope = typeof payload.institution_id === "string" && typeof payload.department_id === "string" && typeof payload.is_enabled === "boolean"
        ? { institutionId: payload.institution_id, departmentId: payload.department_id, enabled: payload.is_enabled }
        : undefined;
      const nextState = applyAccountAdminLocalResult(
        { accounts, roleRows, scopeRows },
        { operation: String(payload.operation ?? ""), account: result.account, roleCodes, roleCode, roleEnabled: payload.is_enabled === true, scope },
      );
      setAccounts([...nextState.accounts]);
      setRoleRows([...nextState.roleRows]);
      setScopeRows([...nextState.scopeRows]);
      if (selectedId === result.account.id) {
        setEditLoginName(result.account.login_name ?? "");
        setEditDisplayName(result.account.display_name);
        setEditEmail(result.account.email_snapshot ?? "");
        setEditRoleCodes(nextState.roleRows.filter((row) => row.account_id === result.account?.id).map((row) => row.role_code));
      }
    }
    return result;
  }

  async function createAccount() {
    const validationErrors = validateAccountCreation({
      loginName,
      password,
      roleCount: createRoleCodes.length,
      reason,
    });
    if (validationErrors.length > 0) {
      setMessageKind("error");
      setMessage(validationErrors.join(" "));
      return;
    }
    setBusy(true); setMessage("");
    try {
      const result = await runOperation({
        operation: "create",
        login_name: loginName.trim(),
        display_name: displayName.trim(),
        email: email.trim() || null,
        password,
        role_codes: createRoleCodes,
        reason: reason.trim(),
      }, "create");
      if (result?.account) {
        selectAccount(result.account);
        setEditRoleCodes(createRoleCodes);
      }
      setLoginName(""); setDisplayName(""); setEmail(""); setPassword(""); setCreateRoleCodes(["HR"]);
    } catch (error) {
      setMessageKind("error");
      setMessage("建立帳號失敗；請確認資料、操作理由與權限後使用相同按鈕重試。");
    } finally { setBusy(false); }
  }

  async function setRoleValues() {
    if (!selectedId || editRoleCodes.length === 0 || !reason.trim()) { setMessageKind("error"); setMessage("請選擇帳號、至少一個角色並填寫操作理由。"); return; }
    setBusy(true); setMessage("");
    try { await runOperation({ operation: "set_roles", account_id: selectedId, role_codes: editRoleCodes, reason: reason.trim() }, "roles"); }
    catch { setMessageKind("error"); setMessage("角色權限變更失敗；請確認資料與操作理由後使用相同按鈕重試。"); }
    finally { setBusy(false); }
  }

  async function setStatus() {
    if (!selectedId || !reason.trim()) { setMessageKind("error"); setMessage("請選擇帳號並填寫操作理由。"); return; }
    setBusy(true); setMessage("");
    try { await runOperation({ operation: "set_status", account_id: selectedId, is_active: !selected?.is_active, reason: reason.trim() }, "status"); }
    catch { setMessageKind("error"); setMessage("帳號狀態變更失敗；請確認操作理由後使用相同按鈕重試。"); }
    finally { setBusy(false); }
  }

  async function setScope() {
    if (!selectedId || !institutionId || !departmentId || !reason.trim()) { setMessageKind("error"); setMessage("請選擇需求窗口、機構、部門並填寫理由。"); return; }
    setBusy(true); setMessage("");
    try { await runOperation({ operation: "set_scope", account_id: selectedId, institution_id: institutionId, department_id: departmentId, is_enabled: scopeEnabled, reason: reason.trim() }, "scope"); }
    catch { setMessageKind("error"); setMessage("窗口範圍變更失敗；請確認機構、部門與操作理由後使用相同按鈕重試。"); }
    finally { setBusy(false); }
  }

  async function rebindAuth() {
    if (!selectedId || (!unbindAuth && !newAuthUserId.trim()) || !reason.trim()) { setMessageKind("error"); setMessage("請選擇帳號、填寫新的 Auth user UUID 與理由。"); return; }
    setBusy(true); setMessage("");
    try { await runOperation({ operation: "rebind", account_id: selectedId, new_auth_user_id: unbindAuth ? null : newAuthUserId.trim(), reason: reason.trim(), recovery_ticket: recoveryTicket.trim() || null }, "rebind"); setNewAuthUserId(""); setRecoveryTicket(""); setUnbindAuth(false); }
    catch { setMessageKind("error"); setMessage("Auth 綁定重設失敗；請確認 UUID、復原票據與操作理由後使用相同按鈕重試。"); }
    finally { setBusy(false); }
  }

  async function updateProfile() {
    if (!selectedId || !editLoginName.trim() || !editDisplayName.trim() || !reason.trim()) { setMessageKind("error"); setMessage("請填寫登入帳號、顯示名稱與操作理由。"); return; }
    setBusy(true); setMessage("");
    try { await runOperation({ operation: "update_profile", account_id: selectedId, login_name: editLoginName.trim(), display_name: editDisplayName.trim(), email: editEmail.trim() || null, reason: reason.trim() }, "profile"); }
    catch { setMessageKind("error"); setMessage("帳號資料修改失敗；請確認登入帳號、顯示名稱與操作理由後使用相同按鈕重試。"); }
    finally { setBusy(false); }
  }

  async function updatePassword() {
    if (!selectedId || resetPassword.length < 6 || !reason.trim()) { setMessageKind("error"); setMessage("請輸入至少 6 個字元的新密碼與操作理由。"); return; }
    setBusy(true); setMessage("");
    try { await runOperation({ operation: "set_password", account_id: selectedId, password: resetPassword, reason: reason.trim() }, "password"); setResetPassword(""); }
    catch { setMessageKind("error"); setMessage("密碼修改失敗；請確認密碼格式與操作理由後使用相同按鈕重試。"); }
    finally { setBusy(false); }
  }

  async function deleteAccount() {
    if (!selectedId || !reason.trim()) { setMessageKind("error"); setMessage("請選擇帳號並填寫操作理由。"); return; }
    setBusy(true); setMessage("");
    try {
      await runOperation({ operation: "delete", account_id: selectedId, reason: reason.trim() }, "delete");
      setDeleteConfirming(false);
    }
    catch { setMessageKind("error"); setMessage("帳號刪除失敗；請確認帳號狀態、業務歷史與操作理由後使用相同按鈕重試。"); }
    finally { setBusy(false); }
  }

  function toggleRole(roleCode: Role, enabled: boolean, target: "create" | "edit") {
    resetOperation(target === "create" ? "create" : "roles");
    const update = (current: Role[]) => enabled
      ? [...new Set([...current, roleCode])]
      : current.filter((value) => value !== roleCode);
    if (target === "create") setCreateRoleCodes(update);
    else setEditRoleCodes(update);
  }

  if (!client) return null;
  return <div className="workspace-sections account-admin-workbench">
    <section className="panel module-workbench-header" aria-label="帳號管理工具列">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ACCOUNT ADMINISTRATION</p>
          <h2 id={headingId}>帳號與權限管理</h2>
          <p className="auth-message">先從帳號清單選擇管理對象，或切換到新增帳號；基本資料、密碼、角色、Auth 綁定與窗口範圍集中在帳號設定。</p>
        </div>
        <div className="module-workbench-actions">
          <button className="primary-button" type="button" onClick={() => setActiveTab("create")}>＋ 新增帳號</button>
          <button className="secondary-button" type="button" onClick={() => void refreshAccounts()} disabled={busy}>{directoryLoading ? "讀取中…" : "重新整理"}</button>
        </div>
      </div>
      <ModuleWorkbenchNavigation
        idPrefix="account-admin"
        ariaLabel="帳號管理功能"
        activeTabId={activeTab}
        onTabChange={handleTabChange}
        tabs={[
          { id: "directory", label: "帳號清單", badge: String(visibleAccounts.length) },
          { id: "create", label: "新增帳號" },
          { id: "manage", label: "帳號設定", badge: selected ? selected.login_name ?? selected.display_name : undefined },
        ]}
      />
    </section>
    {displayMessage ? <p className={messageKind === "success" && !identityError ? "success-note account-admin-feedback" : "error-box account-admin-feedback"} role="status" aria-live="polite">{displayMessage}</p> : null}
    <RetainedPanelSet
      idPrefix="account-admin"
      activePanelId={activeTab}
      panelClassName="panel import-panel account-admin-content"
      panels={[
        { id: "directory", content: <div className="increase-list account-directory">
      <div className="subheading"><h3>現有業務帳號</h3><span>已載入 {visibleAccounts.length} 筆</span></div>
      <p className="muted">這裡列出已建立正式帳號並完成角色設定的使用者；只存在登入服務、尚未建立業務帳號的身份不會出現在此清單。</p>
      <div className="account-directory-filters">
        <label className="field"><span>搜尋帳號／角色</span><input value={accountQuery} onChange={(event) => { setAccountQuery(event.target.value); setAccountPage(1); }} placeholder="登入帳號、名稱、Email 或角色…" /></label>
        <label className="field"><span>帳號狀態</span><select value={accountStatus} onChange={(event) => { setAccountStatus(event.target.value as AccountDirectoryStatusFilter); setAccountPage(1); }}><option value="ALL">全部狀態</option><option value="ACTIVE">啟用</option><option value="INACTIVE">停用</option></select></label>
      </div>
      <div className="management-catalog-result account-directory-result"><p className="muted">符合條件 {filteredAccounts.length} 筆</p>{accountQuery || accountStatus !== "ALL" ? <button className="text-button" type="button" onClick={() => { setAccountQuery(""); setAccountStatus("ALL"); setAccountPage(1); }}>清除篩選</button> : null}</div>
      <ManagementCatalogTable<AccountDirectoryRecord, AccountDirectorySortKey>
        ariaLabel="業務帳號清單"
        rows={filteredAccounts}
        rowKey={(row) => row.id}
        page={accountPage}
        onPageChange={setAccountPage}
        sortKey={accountSortKey}
        sortDirection={accountSortDirection}
        onSort={toggleAccountSort}
        loading={directoryLoading}
        defaultPageSize={10}
        pageSizeOptions={[10, 25, 50]}
        emptyState={<p className="empty-state">目前沒有符合條件的業務帳號，或目前登入者沒有 SYSTEM_ADMIN 讀取權限。</p>}
        columns={[
          { id: "display-name", label: "顯示名稱", sortKey: "display_name", locked: true, render: (account) => <strong>{account.displayName}</strong> },
          { id: "login-name", label: "登入帳號", sortKey: "login_name", render: (account) => account.loginName || "舊版 Email 登入" },
          { id: "roles", label: "角色", sortKey: "roles", render: (account) => account.roles.length > 0 ? account.roles.join("、") : "尚未指派" },
          { id: "email", label: "聯絡 Email", render: (account) => account.email || <span className="muted">未填寫</span> },
          { id: "status", label: "狀態", sortKey: "status", render: (account) => <span className={`status-pill ${account.isActive ? "success" : "danger"}`}>{account.isActive ? "啟用" : "停用"}</span> },
          { id: "auth", label: "登入綁定", sortKey: "auth", defaultVisible: false, render: (account) => account.authBound ? "已綁定登入" : "未綁定登入" },
          { id: "actions", label: "功能", locked: true, render: (account) => <button className="management-row-action" type="button" onClick={() => selectAccountById(account.id)}>{selectedId === account.id ? "編輯中" : "管理"}</button> },
        ]}
      />
    </div> },
        { id: "create", content: <div>
    <div className="subheading account-create-heading"><h3>新增帳號</h3><span>帳號、密碼、角色與理由完成後送出</span></div>
    <div className="form-grid">
      <label className="field"><span>登入帳號（2–50 個小寫英數字）</span><input autoComplete="username" value={loginName} onChange={(event) => { resetOperation("create"); setLoginName(event.target.value); }} disabled={busy} placeholder="例如 hr01" /></label>
      <label className="field"><span>初始密碼（至少 6 字元）</span><input autoComplete="new-password" type="password" value={password} onChange={(event) => { resetOperation("create"); setPassword(event.target.value); }} disabled={busy} /></label>
      <label className="field"><span>顯示名稱（選填，預設同帳號）</span><input value={displayName} onChange={(event) => { resetOperation("create"); setDisplayName(event.target.value); }} disabled={busy} /></label>
      <label className="field"><span>聯絡 Email（選填，不作登入）</span><input autoComplete="email" type="email" value={email} onChange={(event) => { resetOperation("create"); setEmail(event.target.value); }} disabled={busy} /></label>
      <label className="field"><span>建立理由（必填）</span><input value={reason} onChange={(event) => { resetOperation("create"); setReason(event.target.value); }} disabled={busy} /></label>
    </div>
    <fieldset className="role-fieldset">
      <legend>角色權限（至少選擇一項；SYSTEM_ADMIN 勾選後自動涵蓋其他角色）</legend>
      <div className="role-check-grid">
        {roles.map((roleCode) => <label className="role-check" key={`create-${roleCode}`}><input type="checkbox" checked={accountHasEffectiveRole(createRoleCodes, roleCode)} onChange={(event) => toggleRole(roleCode, event.target.checked, "create")} disabled={busy || (createRoleCodes.includes("SYSTEM_ADMIN") && roleCode !== "SYSTEM_ADMIN")} /><span>{roleCode}</span></label>)}
      </div>
    </fieldset>
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void createAccount()} disabled={busy}>{busy ? "處理中…" : "建立帳號、登入身份與權限"}</button></div>
    </div> },
        { id: "manage", content: <>
    {!selected ? <p className="empty-state">請先從「帳號清單」選擇要管理的帳號。</p> : null}
    {selected ? <>
      <div className="increase-list">
        <div className="subheading"><h3>帳號資料</h3><span>{selected.auth_user_id ? "登入身份由 server-side Auth Admin 同步" : "尚未綁定登入身份"}</span></div>
        <div className="form-grid">
          <label className="field"><span>登入帳號（2–50 個小寫英數字）</span><input autoComplete="username" value={editLoginName} onChange={(event) => { resetOperation("profile"); setEditLoginName(event.target.value); }} disabled={busy} /></label>
          <label className="field"><span>顯示名稱</span><input value={editDisplayName} onChange={(event) => { resetOperation("profile"); setEditDisplayName(event.target.value); }} disabled={busy} /></label>
          <label className="field"><span>聯絡 Email（選填，不作登入）</span><input autoComplete="email" type="email" value={editEmail} onChange={(event) => { resetOperation("profile"); setEditEmail(event.target.value); }} disabled={busy} /></label>
        </div>
        <div className="button-row"><button className="secondary-button" type="button" onClick={() => void updateProfile()} disabled={busy || !editLoginName.trim() || !editDisplayName.trim() || !reason.trim()}>儲存帳號資料</button></div>
      </div>
      <div className="increase-list">
        <div className="subheading"><h3>密碼管理</h3><span>新密碼只經過此次 HTTPS 請求，不寫入 app_accounts</span></div>
        <div className="form-grid">
          <label className="field"><span>設定新密碼（至少 6 字元）</span><input autoComplete="new-password" type="password" value={resetPassword} onChange={(event) => { resetOperation("password"); setResetPassword(event.target.value); }} disabled={busy} /></label>
        </div>
        <div className="button-row"><button className="secondary-button" type="button" onClick={() => void updatePassword()} disabled={busy || resetPassword.length < 6 || !selected.auth_user_id || !reason.trim()}>修改登入密碼</button></div>
      </div>
      <div className="increase-list">
        <div className="subheading"><h3>角色權限</h3><span>SYSTEM_ADMIN 自動具備全部角色權限；其他帳號可同時勾選多個角色</span></div>
        <fieldset className="role-fieldset">
          <legend>目前要授予的角色（至少一項；SYSTEM_ADMIN 勾選後自動涵蓋其他角色）</legend>
          <div className="role-check-grid">
            {roles.map((roleCode) => <label className="role-check" key={`edit-${roleCode}`}><input type="checkbox" checked={accountHasEffectiveRole(editRoleCodes, roleCode)} onChange={(event) => toggleRole(roleCode, event.target.checked, "edit")} disabled={busy || (editRoleCodes.includes("SYSTEM_ADMIN") && roleCode !== "SYSTEM_ADMIN")} /><span>{roleCode}</span></label>)}
          </div>
        </fieldset>
        <div className="button-row"><button className="secondary-button" type="button" onClick={() => void setRoleValues()} disabled={busy || editRoleCodes.length === 0 || !reason.trim()}>儲存角色權限</button></div>
      </div>
      <div className="form-grid admin-controls">
        <label className="field"><span>操作理由（必填）</span><input value={reason} onChange={(event) => { resetOperation("profile"); resetOperation("password"); resetOperation("roles"); resetOperation("status"); resetOperation("delete"); resetOperation("scope"); resetOperation("rebind"); setReason(event.target.value); }} disabled={busy} /></label>
        <label className="field"><span>新的 Auth user UUID（重設綁定）</span><input value={newAuthUserId} onChange={(event) => { resetOperation("rebind"); setNewAuthUserId(event.target.value); }} disabled={busy} placeholder="僅在帳號移交時填寫" /></label>
        <label className="field"><span>Recovery ticket（選填）</span><input value={recoveryTicket} onChange={(event) => { resetOperation("rebind"); setRecoveryTicket(event.target.value); }} disabled={busy} placeholder="工單／核准編號" /></label>
        <label className="field"><span>綁定動作</span><select value={unbindAuth ? "UNBIND" : "REBIND"} onChange={(event) => { resetOperation("rebind"); setUnbindAuth(event.target.value === "UNBIND"); }} disabled={busy}><option value="REBIND">重設到新的 Auth user</option><option value="UNBIND">解除 Auth 綁定</option></select></label>
      </div>
      <p className="muted">目前角色：{selectedRoles.length > 0 ? selectedRoles.join("、") : "尚未指派"}／目前需求窗口範圍：{selectedScopes.length} 筆</p>
      <div className="button-row"><button className="secondary-button" type="button" onClick={() => void setStatus()} disabled={busy || !reason.trim()}>{selected.is_active ? "停用登入與帳號" : "重新啟用帳號"}</button><button className="secondary-button" type="button" onClick={() => void rebindAuth()} disabled={busy || !reason.trim() || (!unbindAuth && !newAuthUserId.trim())}>{unbindAuth ? "解除 Auth 綁定" : "重設 Auth 綁定"}</button><button className="secondary-button" type="button" onClick={() => setDeleteConfirming(true)} disabled={busy || !reason.trim()}>刪除登入身份</button></div>
      {deleteConfirming ? <div className="product-deactivate-warning account-delete-confirmation"><strong>確認刪除「{selected.display_name}」的登入身份？</strong><span>業務歷史會保留，但帳號將停用且 Auth 登入身份會被刪除。此操作必須有上方填寫的理由。</span><div className="button-row"><button className="danger-button" type="button" onClick={() => void deleteAccount()} disabled={busy}>{busy ? "刪除中…" : "確認刪除登入身份"}</button><button className="secondary-button" type="button" onClick={() => setDeleteConfirming(false)} disabled={busy}>取消</button></div></div> : null}
       <div className="increase-list">
         <div className="subheading"><h3>需求窗口範圍</h3><span>只有 DEMAND_COORDINATOR 可設定範圍</span></div>
         {scopeDataLoading || organizationOptionsLoading ? (
           <p className="muted" role="status" aria-live="polite">
             {scopeDataLoading ? <span>正在更新目前帳號的窗口範圍。 </span> : null}
             {organizationOptionsLoading ? <span>正在更新機構／部門選項；{manageOptionsReady ? "目前載入的選項仍可使用。" : "載入完成後即可操作。"}</span> : null}
           </p>
         ) : null}
         <div className="form-grid">
           <label className="field">
             <span>機構</span>
             <select value={institutionId} onChange={(event) => { resetOperation("scope"); setInstitutionId(event.target.value); setDepartmentId(""); }} disabled={busy || !manageOptionsReady}>
               <option value="">{organizationOptionsLoading && !manageOptionsReady ? "載入機構中…" : "選擇機構"}</option>
               {institutions.map((institution) => <option key={institution.id} value={institution.id}>{institution.code}｜{institution.name}</option>)}
             </select>
           </label>
           <label className="field">
             <span>部門</span>
             <select value={departmentId} onChange={(event) => { resetOperation("scope"); setDepartmentId(event.target.value); }} disabled={busy || !manageOptionsReady || !institutionId}>
               <option value="">{organizationOptionsLoading && !manageOptionsReady ? "載入部門中…" : "選擇部門"}</option>
               {filteredDepartments.map((department) => <option key={department.id} value={department.id}>{department.code}｜{department.name}</option>)}
             </select>
           </label>
           <label className="field">
             <span>範圍狀態</span>
             <select value={scopeEnabled ? "ON" : "OFF"} onChange={(event) => { resetOperation("scope"); setScopeEnabled(event.target.value === "ON"); }} disabled={busy || !manageOptionsReady}>
               <option value="ON">授權</option>
               <option value="OFF">撤銷</option>
             </select>
           </label>
         </div>
         <div className="button-row">
           <button className="secondary-button" type="button" onClick={() => void setScope()} disabled={busy || scopeDataLoading || !manageOptionsReady || !institutionId || !departmentId}>
             {scopeActionLabel}
           </button>
         </div>
       </div>
    </> : null}
    </> },
      ]}
    />
  </div>;
}
