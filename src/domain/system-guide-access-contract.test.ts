import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("System Guide access contract", () => {
  it("authorizes both discovery and document reads on the server", () => {
    const route = source("../app/api/system-guide/route.ts");
    expect(route).toContain("authorizeSystemAdmin(client)");
    expect(route).toContain("export async function HEAD");
    expect(route).toContain("export async function GET");
    expect(route.indexOf("await authorize(request)")).toBeLessThan(route.indexOf("await loadSystemGuideDocuments()"));
    expect(route).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("loads only the three allowlisted Markdown sources", () => {
    const loader = source("../server/system-guide.ts");
    const domain = source("system-guide.ts");
    expect(domain).toContain('fileName: "user-guide.md"');
    expect(domain).toContain('fileName: "admin-guide.md"');
    expect(domain).toContain('fileName: "agent-guide.md"');
    expect(loader).toContain("systemGuideDocumentDefinitions.map");
    expect(loader).not.toMatch(/fileName\s*:\s*(request|params|searchParams)/);
  });

  it("renders typed blocks and never injects Markdown as HTML", () => {
    const page = source("../app/system-guide/SystemGuidePageClient.tsx");
    expect(page).toContain("function GuideBlock");
    expect(page).not.toContain("dangerouslySetInnerHTML");
  });

  it("keeps the original workspace shell around the System Guide route", () => {
    const routePage = source("../app/system-guide/page.tsx");
    const shell = source("../app/WorkspaceShell.tsx");
    expect(routePage).toContain("<WorkspaceShell initialSystemGuide />");
    expect(shell).toContain('className="app-sidebar"');
    expect(shell).toContain("<SystemGuidePageClient");
  });

  it("does not wait for a second client request before showing document navigation", () => {
    const page = source("../app/system-guide/SystemGuidePageClient.tsx");
    expect(page).toContain("systemGuideDocumentDefinitions.map");
    expect(page).not.toContain('fetch("/api/system-guide"');
    expect(page).not.toContain("useAuthSession");
  });

  it("uses the self-readable role table and cached prefetch instead of a delayed HEAD probe", () => {
    const accessHook = source("../app/use-system-guide-access.ts");
    expect(accessHook).toContain('.from("user_roles")');
    expect(accessHook).toContain("sessionStorage");
    expect(accessHook).toContain('fetch("/api/system-guide"');
    expect(accessHook).not.toContain('method: "HEAD"');
  });

  it("includes the Markdown files in the standalone route bundle", () => {
    const nextConfig = source("../../next.config.ts");
    expect(nextConfig).toContain('"/api/system-guide"');
    expect(nextConfig).toContain('"./docs/system-guide/*.md"');
  });
});
