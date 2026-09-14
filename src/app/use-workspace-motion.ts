"use client";

import { useRef } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import type { AppearanceTheme } from "./use-appearance-theme";

gsap.registerPlugin(useGSAP);

export function useWorkspaceMotion(theme: AppearanceTheme) {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (theme !== "ga") return;

    const root = scope.current;
    if (!root) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const sidebar = root.querySelector<HTMLElement>(".app-sidebar");
    const topbar = root.querySelector<HTMLElement>(".workspace-topbar");
    const moduleNav = root.querySelector<HTMLElement>(".workspace-module-nav");
    const pageChildren = root.querySelectorAll<HTMLElement>(".workspace-page.is-active > *");
    if (!sidebar || !topbar || !moduleNav) return;

    const timeline = gsap.timeline({ defaults: { duration: 0.62, ease: "power3.out" } });
    timeline
      .from(sidebar, { x: -22, autoAlpha: 0, duration: 0.52 })
      .from(topbar, { y: -16, autoAlpha: 0 }, "<0.1")
      .from(moduleNav, { y: 14, autoAlpha: 0 }, "<0.1")
      .from(pageChildren, { y: 16, autoAlpha: 0, stagger: 0.045, duration: 0.5 }, "<0.12");

    return () => timeline.kill();
  }, { scope, dependencies: [theme], revertOnUpdate: true });

  return scope;
}
