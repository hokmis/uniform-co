import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const motionHook = readFileSync("src/app/use-workspace-motion.ts", "utf8");
const globalStyles = readFileSync("src/app/globals.css", "utf8");

describe("workspace motion seam", () => {
  it("keeps the GS theme animation lightweight and reduced-motion safe", () => {
    expect(motionHook).not.toContain('from "gsap"');
    expect(motionHook).not.toContain('from "@gsap/react"');
    expect(motionHook).toContain("workspace-motion-enabled");
    expect(motionHook).toContain("prefers-reduced-motion");
    expect(globalStyles).toContain("@keyframes workspace-shell-enter");
    expect(globalStyles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
