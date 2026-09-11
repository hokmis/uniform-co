"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import AuthPanel from "./AuthPanel";
import AuthSessionBoundary from "./AuthSessionBoundary";
import RetainedPanelSet from "./RetainedPanelSet";
import WorkspaceTopbar from "./WorkspaceTopbar";
import SystemGuidePageClient from "./system-guide/SystemGuidePageClient";
import { useAuthSession } from "./use-auth-session";
import { useSystemGuideAccess } from "./use-system-guide-access";
import AccountWorkspace from "./workspaces/AccountWorkspace";
import HrWorkspace from "./workspaces/HrWorkspace";
import OverviewWorkspace from "./workspaces/OverviewWorkspace";
import ProcurementWorkspace from "./workspaces/ProcurementWorkspace";
import ReportsWorkspace from "./workspaces/ReportsWorkspace";
import SeasonalWorkspace from "./workspaces/SeasonalWorkspace";
import WarehouseWorkspace from "./workspaces/WarehouseWorkspace";
import { isWorkspaceId, type WorkspaceId, workspaceDefinitions } from "./workspaces/workspace-config";
import { type AppearanceTheme, useAppearanceTheme } from "./use-appearance-theme";
import { useWorkspaceMotion } from "./use-workspace-motion";
import { accountLabelFromUser } from "@/src/lib/account-login";

function WorkspaceIcon({ name }: { name: (typeof workspaceDefinitions)[number]["icon"] }) {
  const common = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "grid") {
    return <svg {...common}><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg>;
  }
  if (name === "people") {
    return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 5.5a3 3 0 0 1 0 5.8M16.5 14.5a5 5 0 0 1 4 4.5" /></svg>;
  }
  if (name === "account") {
    return <svg {...common}><circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0" /><path d="M19 5v4M17 7h4" /></svg>;
  }
  if (name === "warehouse") {
    return <svg {...common}><path d="m3 10 9-6 9 6" /><path d="M5 9v10h14V9" /><path d="M9 19v-6h6v6M8 10h.01M12 10h.01M16 10h.01" /></svg>;
  }
  if (name === "cart") {
    return <svg {...common}><path d="M4 5h2l1.5 9h9L20 8H7" /><circle cx="10" cy="19" r="1.4" /><circle cx="17" cy="19" r="1.4" /></svg>;
  }
  if (name === "refresh") {
    return <svg {...common}><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.3 9A7 7 0 0 1 20 12M4 12a7 7 0 0 0 13.7 3" /></svg>;
  }
  return <svg {...common}><path d="M4 19V5M4 19h16" /><path d="m7 15 4-4 3 2 5-6" /></svg>;
}

function SystemGuideIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5Z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5Z" /></svg>;
}

const systemGuideDefinition = {
  label: "系統說明",
  eyebrow: "SYSTEM GUIDE / ADMIN ONLY",
  description: "在原作業台中查閱使用者操作、管理設定與 AI Agent 交接說明。",
};

function workspaceFromUrl(): WorkspaceId {
  if (typeof window === "undefined") {
    return "overview";
  }
  const value = window.location.hash.replace(/^#/, "");
  return isWorkspaceId(value) ? value : "overview";
}

function AuthLanding({ children }: { children: ReactNode }) {
  return (
    <main className="auth-landing">
      <div className="auth-landing-pattern" aria-hidden="true" />
      <div className="auth-landing-content">
        <div className="auth-landing-brand">
          <span className="app-brand-mark" aria-hidden="true">U</span>
          <div>
            <p className="eyebrow">UNIFORM CO.</p>
            <h1>制服資產作業台</h1>
            <p>正式資料工作區</p>
          </div>
        </div>
        {children}
        <p className="auth-landing-footnote">Supabase Auth ／ PostgreSQL RLS ／ 正式資料工作區</p>
      </div>
    </main>
  );
}

function WorkspaceStage({ children, appearanceTheme }: { children: ReactNode; appearanceTheme: AppearanceTheme }) {
  const motionScope = useWorkspaceMotion(appearanceTheme);
  return <div ref={motionScope} className="app-shell">{children}</div>;
}

export default function WorkspaceShell({ initialSystemGuide = false }: { initialSystemGuide?: boolean }) {
  const router = useRouter();
  const { client, user, loading } = useAuthSession();
  const systemGuide = useSystemGuideAccess(client, user);
  const { theme: appearanceTheme, setTheme: setAppearanceTheme } = useAppearanceTheme();
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>("overview");
  const [activeModuleByWorkspace, setActiveModuleByWorkspace] = useState<Partial<Record<WorkspaceId, string>>>({});
  const activeDefinition = workspaceDefinitions.find((workspace) => workspace.id === activeWorkspace) ?? workspaceDefinitions[0];
  const activeHeaderDefinition = initialSystemGuide ? systemGuideDefinition : activeDefinition;
  const activeModule = activeModuleByWorkspace[activeWorkspace] ?? activeDefinition.modules[0].anchor;
  const accountLabel = user ? accountLabelFromUser(user) : "已登入帳號";
  const guideNavigationVisible = systemGuide.allowed || (initialSystemGuide && systemGuide.checking);

  useEffect(() => {
    const syncWorkspace = () => setActiveWorkspace(workspaceFromUrl());
    syncWorkspace();
    window.addEventListener("hashchange", syncWorkspace);
    window.addEventListener("popstate", syncWorkspace);
    return () => {
      window.removeEventListener("hashchange", syncWorkspace);
      window.removeEventListener("popstate", syncWorkspace);
    };
  }, []);

  function selectWorkspace(id: WorkspaceId, anchor?: string) {
    const definition = workspaceDefinitions.find((workspace) => workspace.id === id) ?? workspaceDefinitions[0];
    const nextModule = anchor && definition.modules.some((module) => module.anchor === anchor)
      ? anchor
      : definition.modules[0].anchor;
    const workspaceChanged = activeWorkspace !== id;
    if (initialSystemGuide) {
      router.push(`/#${id}`);
      return;
    }
    setActiveWorkspace(id);
    setActiveModuleByWorkspace((current) => ({ ...current, [id]: nextModule }));
    if (window.location.hash !== `#${id}`) {
      window.history.pushState({}, "", `#${id}`);
    }
    if (workspaceChanged) window.scrollTo({ top: 0, behavior: "auto" });
  }

  if (!client) {
    return <AuthLanding><AuthPanel /></AuthLanding>;
  }

  if (loading) {
    return (
      <AuthLanding>
        <section className="auth-panel panel auth-loading" aria-live="polite" aria-label="確認登入狀態">
          <div>
            <p className="eyebrow">ACCOUNT / VERIFYING SESSION</p>
            <h2>正在確認登入狀態</h2>
            <p className="auth-message">工作區資料會在登入驗證完成後載入。</p>
          </div>
          <span className="status-pill">SESSION CHECK</span>
        </section>
      </AuthLanding>
    );
  }

  if (!user) {
    return <AuthLanding><AuthPanel /></AuthLanding>;
  }

  return (
    <WorkspaceStage appearanceTheme={appearanceTheme}>
      <aside className="app-sidebar" aria-label="工作區導航">
        <div className="app-brand">
          <span className="app-brand-mark" aria-hidden="true">U</span>
          <div>
            <strong>UNIFORM CO.</strong>
            <span>制服資產作業台</span>
          </div>
        </div>

        <p className="app-nav-label">WORKSPACE</p>
        <nav className="app-nav" aria-label="主要工作區">
          {workspaceDefinitions.map((workspace) => (
            <button
              key={workspace.id}
              id={`workspace-tab-${workspace.id}`}
              className={!initialSystemGuide && activeWorkspace === workspace.id ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={activeWorkspace === workspace.id}
              aria-controls={`workspace-${workspace.id}`}
              onClick={() => selectWorkspace(workspace.id)}
            >
              <span className="app-nav-icon"><WorkspaceIcon name={workspace.icon} /></span>
              <span>{workspace.label}</span>
            </button>
          ))}
          {guideNavigationVisible ? <button className={initialSystemGuide ? "active" : ""} type="button" aria-label="開啟系統說明" aria-current={initialSystemGuide ? "page" : undefined} onClick={() => router.push("/system-guide")}><span className="app-nav-icon"><SystemGuideIcon /></span><span>系統說明</span></button> : null}
        </nav>

        <div className="app-sidebar-bottom">
          <div className="app-user-chip">
            <span className="app-avatar" aria-hidden="true">{(accountLabel[0] ?? "U").toUpperCase()}</span>
            <div>
              <strong>{accountLabel}</strong>
              <span>角色與資料範圍由 RLS 判定</span>
            </div>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <WorkspaceTopbar
          activeDefinition={activeHeaderDefinition}
          user={user}
          appearanceTheme={appearanceTheme}
          onAppearanceChange={(theme: AppearanceTheme) => setAppearanceTheme(theme)}
          onNavigate={selectWorkspace}
          onOpenSystemGuide={systemGuide.allowed && !initialSystemGuide ? () => router.push("/system-guide") : undefined}
          onSignOut={async () => {
            const { error } = await client.auth.signOut();
            if (error) throw error;
          }}
        />

        <div className="workspace-mobile-switcher">
          <label htmlFor="workspace-mobile-select">目前工作區</label>
          <select
            id="workspace-mobile-select"
            value={initialSystemGuide ? "system-guide" : activeWorkspace}
            onChange={(event) => {
              if (isWorkspaceId(event.target.value)) {
                selectWorkspace(event.target.value);
              }
            }}
          >
            {workspaceDefinitions.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.label}</option>)}
            {guideNavigationVisible ? <option value="system-guide">系統說明</option> : null}
          </select>
        </div>

        {!initialSystemGuide ? <nav className="workspace-module-nav" aria-label={`${activeDefinition.label}模組導航`}>
          <div className="workspace-module-nav-heading">
            <p className="eyebrow">MODULES</p>
            <span>本工作區功能</span>
          </div>
          <div className="workspace-module-links" role="tablist" aria-label={`${activeDefinition.label}功能頁籤`}>
            {activeDefinition.modules.map((module) => (
              <button
                key={module.anchor}
                className={activeModule === module.anchor ? "active" : ""}
                id={`workspace-module-tab-${module.anchor}`}
                type="button"
                role="tab"
                aria-selected={activeModule === module.anchor}
                aria-controls={`workspace-module-panel-${module.anchor}`}
                onClick={() => selectWorkspace(activeWorkspace, module.anchor)}
              >
                <span>{module.label}</span>
              </button>
            ))}
          </div>
        </nav> : null}

        <AuthSessionBoundary>
          {initialSystemGuide ? (
            <SystemGuidePageClient
              documents={systemGuide.documents}
              loading={systemGuide.checking || systemGuide.documentsLoading}
              message={systemGuide.message}
              forbidden={!systemGuide.checking && !systemGuide.allowed}
            />
          ) : <RetainedPanelSet
            idPrefix="workspace"
            activePanelId={activeWorkspace}
            panelClassName="workspace-page"
            activePanelClassName="is-active"
            panels={workspaceDefinitions.map((workspace) => {
              const workspaceModule = activeModuleByWorkspace[workspace.id] ?? workspace.modules[0].anchor;
              return {
                id: workspace.id,
                panelId: `workspace-${workspace.id}`,
                tabId: `workspace-tab-${workspace.id}`,
                content: <>
                  {workspace.id === "overview" ? <OverviewWorkspace activeModule={workspaceModule} onNavigate={selectWorkspace} /> : null}
                  {workspace.id === "accounts" ? <AccountWorkspace activeModule={workspaceModule} /> : null}
                  {workspace.id === "hr" ? <HrWorkspace activeModule={workspaceModule} /> : null}
                  {workspace.id === "warehouse" ? <WarehouseWorkspace activeModule={workspaceModule} onNavigate={selectWorkspace} /> : null}
                  {workspace.id === "procurement" ? <ProcurementWorkspace activeModule={workspaceModule} /> : null}
                  {workspace.id === "seasonal" ? <SeasonalWorkspace activeModule={workspaceModule} /> : null}
                  {workspace.id === "reports" ? <ReportsWorkspace activeModule={workspaceModule} /> : null}
                </>,
              };
            })}
          />}
        </AuthSessionBoundary>
      </div>
    </WorkspaceStage>
  );
}
