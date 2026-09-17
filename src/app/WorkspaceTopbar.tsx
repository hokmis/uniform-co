"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  searchWorkspaceModules,
  type WorkspaceId,
  type WorkspaceSearchResult,
} from "./workspaces/workspace-config";
import { appearanceThemes, type AppearanceTheme } from "./use-appearance-theme";
import { accountLabelFromUser } from "@/src/lib/account-login";

type Props = {
  activeDefinition: { label: string; eyebrow: string; description: string };
  user: User;
  appearanceTheme: AppearanceTheme;
  onAppearanceChange: (theme: AppearanceTheme) => void;
  onNavigate: (workspaceId: WorkspaceId, anchor: string) => void;
  onOpenSystemGuide?: () => void;
  onSignOut: () => Promise<void>;
};

function SearchIcon() {
  return <svg className="workspace-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.5 4.5" /></svg>;
}

function GuideIcon() {
  return <svg className="workspace-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5Z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5Z" /></svg>;
}

function AppearanceIcon() {
  return <svg className="workspace-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4v16M4 12h16" /><circle cx="12" cy="12" r="2.5" /></svg>;
}

function AppearanceSelect({ theme, onChange }: { theme: AppearanceTheme; onChange: (theme: AppearanceTheme) => void }) {
  return (
    <label className="workspace-appearance" htmlFor="workspace-appearance-select" title={appearanceThemes.find((option) => option.id === theme)?.description}>
      <span className="workspace-appearance-label"><AppearanceIcon /><span>風格</span></span>
      <select
        id="workspace-appearance-select"
        className="workspace-appearance-select"
        value={theme}
        aria-label="切換版面風格"
        onChange={(event) => onChange(event.target.value as AppearanceTheme)}
      >
        {appearanceThemes.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
  );
}

function SearchResults({ results, onSelect }: { results: WorkspaceSearchResult[]; onSelect: (result: WorkspaceSearchResult) => void }) {
  if (results.length === 0) {
    return <p className="workspace-search-empty">找不到相符的正式模組，請改用工作區或流程關鍵字。</p>;
  }

  return (
    <div className="workspace-search-results" role="listbox" aria-label="模組搜尋結果">
      {results.map((result) => (
        <button
          className="workspace-search-result"
          key={`${result.workspaceId}-${result.anchor}`}
          type="button"
          role="option"
          aria-selected="false"
          onClick={() => onSelect(result)}
        >
          <span className="workspace-search-result-copy">
            <strong>{result.label}</strong>
            <small>{result.keywords}</small>
          </span>
          <span className="workspace-search-result-workspace">{result.workspaceLabel}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * WorkspaceTopbar component renders the main workspace header actions,
 * including global module search, system guide access, appearance theme toggle,
 * and account authentication controls.
 */
export default function WorkspaceTopbar({ activeDefinition, user, appearanceTheme, onAppearanceChange, onNavigate, onOpenSystemGuide, onSignOut }: Props) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const results = searchWorkspaceModules(query);
  const accountLabel = accountLabelFromUser(user);

  useEffect(() => {
    function closeTransientPanels(event: KeyboardEvent) {
      if (event.key === "/" && event.target instanceof HTMLElement && !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) {
        event.preventDefault();
        searchInputRef.current?.focus();
        setSearchOpen(true);
        return;
      }
      if (event.key !== "Escape") return;
      setSearchOpen(false);
    }

    window.addEventListener("keydown", closeTransientPanels);
    return () => window.removeEventListener("keydown", closeTransientPanels);
  }, []);

  function selectSearchResult(result: WorkspaceSearchResult) {
    setSearchOpen(false);
    setQuery("");
    onNavigate(result.workspaceId, result.anchor);
  }

  function submitSearch() {
    if (results[0]) selectSearchResult(results[0]);
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <header className="workspace-topbar" aria-labelledby="active-workspace-title">
      <div className="workspace-topbar-copy">
        <p className="eyebrow">{activeDefinition.eyebrow}</p>
        <h1 id="active-workspace-title">{activeDefinition.label}</h1>
        <p>{activeDefinition.description}</p>
      </div>
      <div className="workspace-topbar-actions">
        <div className="workspace-search-wrap">
          <label className="workspace-search" htmlFor="workspace-global-search">
            <SearchIcon />
            <input
              id="workspace-global-search"
              ref={searchInputRef}
              value={query}
              placeholder="搜尋模組與流程"
              autoComplete="off"
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </label>
          {searchOpen && query.trim() ? <SearchResults results={results} onSelect={selectSearchResult} /> : null}
        </div>
        {onOpenSystemGuide ? <button className="workspace-icon-button" type="button" aria-label="系統說明" title="開啟 SYSTEM_ADMIN 系統說明" onClick={onOpenSystemGuide}><GuideIcon /></button> : null}
        <AppearanceSelect theme={appearanceTheme} onChange={onAppearanceChange} />
        <span className="workspace-date-pill">正式資料工作區</span>
        <span className="status-pill">SUPABASE + RLS</span>
        <div className="workspace-account-actions">
          <span className="workspace-account-email" title={accountLabel}>{accountLabel}</span>
          <button className="secondary-button workspace-signout" type="button" onClick={() => void signOut()} disabled={signingOut}>
            {signingOut ? "登出中…" : "登出"}
          </button>
        </div>
      </div>
    </header>
  );
}
