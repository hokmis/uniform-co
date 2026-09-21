"use client";

import { useEffect, useRef } from "react";
import type { AppearanceTheme } from "./use-appearance-theme";

export function useWorkspaceMotion(theme: AppearanceTheme) {
  const scope = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scope.current;
    if (!root) return;

    const motionClass = "workspace-motion-enabled";
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    const syncMotionPreference = () => {
      const enabled = theme === "ga" && !mediaQuery.matches;
      root.classList.toggle(motionClass, enabled);
    };

    syncMotionPreference();
    mediaQuery.addEventListener("change", syncMotionPreference);

    return () => {
      mediaQuery.removeEventListener("change", syncMotionPreference);
      root.classList.remove(motionClass);
    };
  }, [theme]);

  return scope;
}
