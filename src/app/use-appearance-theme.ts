import { useEffect, useSyncExternalStore } from "react";

export const appearanceThemes = [
  { id: "current", label: "AP", description: "目前 Apple-inspired 風格" },
  { id: "previous", label: "MX", description: "修改前 Prototype 風格" },
  { id: "ga", label: "GS", description: "GSAP motion workspace" },
  { id: "mb", label: "MB", description: "Agent Skills product workspace" },
  { id: "sh", label: "SH", description: "shadcn/ui neutral dashboard" },
] as const;

export type AppearanceTheme = (typeof appearanceThemes)[number]["id"];

const STORAGE_KEY = "uniform:appearance-theme";

function isAppearanceTheme(value: string | null): value is AppearanceTheme {
  return appearanceThemes.some((theme) => theme.id === value);
}

function getStoredTheme(): AppearanceTheme {
  if (typeof window === "undefined") return "current";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isAppearanceTheme(stored) ? stored : "current";
}

function getServerTheme(): AppearanceTheme {
  return "current";
}

function subscribe(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener("uniform:appearance-change", onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener("uniform:appearance-change", onStoreChange);
  };
}

export function useAppearanceTheme() {
  const theme = useSyncExternalStore(subscribe, getStoredTheme, getServerTheme);

  useEffect(() => {
    document.documentElement.dataset.appearance = theme;
  }, [theme]);

  function setTheme(nextTheme: AppearanceTheme) {
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
    document.documentElement.dataset.appearance = nextTheme;
    window.dispatchEvent(new Event("uniform:appearance-change"));
  }

  return { theme, setTheme };
}
