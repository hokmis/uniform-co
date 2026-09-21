"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  searchWorkspaceModules,
  type WorkspaceId,
  type WorkspaceSearchResult,
} from "./workspaces/workspace-config";
import { appearanceThemes, type AppearanceTheme } from "./use-appearance-theme";

type Props = {
  activeDefinition: { label: string; eyebrow: string; description: string };
  user?: User;
  appearanceTheme: AppearanceTheme;
  onAppearanceChange: (theme: AppearanceTheme) => void;
  onNavigate: (workspaceId: WorkspaceId, anchor: string) => void;
  onOpenSystemGuide?: () => void;
  onSignOut?: () => Promise<void>;
};

function SearchIcon() {
  return <svg className="workspace-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.5 4.5" /></svg>;
}

function GuideIcon() {
  return <svg className="workspace-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>;
}

function AppearanceSelect({ theme, onChange }: { theme: AppearanceTheme; onChange: (theme: AppearanceTheme) => void }) {
  return (
    <label className="workspace-appearance">
      <span className="sr-only">視覺主題</span>
      <select
        className="workspace-appearance-select"
        value={theme}
        aria-label="切換視覺主題"
        onChange={(event) => onChange(event.target.value as AppearanceTheme)}
      >
        {appearanceThemes.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
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

export default function WorkspaceTopbar({ activeDefinition, appearanceTheme, onAppearanceChange, onNavigate, onOpenSystemGuide }: Props) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const results = searchWorkspaceModules(query);

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
    onNavigate(result.workspaceId, result.anchor);
    setSearchOpen(false);
    setQuery("");
  }

  function submitSearch() {
    if (results[0]) selectSearchResult(results[0]);
  }

  return (
    <header className="workspace-topbar" aria-labelledby="active-workspace-title">
      <div className="workspace-topbar-copy">
        <p className="workspace-topbar-label">{activeDefinition.eyebrow}</p>
        <h1 id="active-workspace-title">{activeDefinition.label}</h1>
        <p>{activeDefinition.description}</p>
      </div>

      <div className="workspace-topbar-actions">
        <div className="workspace-search-wrap">
          <label className="workspace-search">
            <span className="workspace-search-icon"><SearchIcon /></span>
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              placeholder="搜尋模組與流程（/）…"
              aria-label="全域模組搜尋"
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
        <span className="status-pill">資料權限已啟用</span>
      </div>
    </header>
  );
}
