import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const loginPage = readFileSync(resolve(process.cwd(), "src/app/login/page.tsx"), "utf8");
const authPanel = readFileSync(resolve(process.cwd(), "src/app/AuthPanel.tsx"), "utf8");
const authLanding = readFileSync(resolve(process.cwd(), "src/app/AuthLanding.tsx"), "utf8");

describe("login entry loading contract", () => {
  it("renders the local sign-in surface without importing the authenticated workspace shell", () => {
    expect(loginPage).not.toContain("WorkspaceShell");
    expect(loginPage).toContain("<AuthLanding bindingPending={bindingPending}>");
    expect(loginPage).toContain("<AuthPanel />");
    expect(loginPage).toContain("getServerAuthUser");
    expect(loginPage).toContain("resolveLoginEntry(Boolean(user))");
    expect(authLanding).toContain("SSO帳號綁定中");
  });

  it("loads the Supabase browser SDK only after login intent, without changing its direct auth flow", () => {
    expect(authPanel).not.toMatch(/import\s+\{\s*getSupabaseBrowserClient\s*\}\s+from/);
    expect(authPanel).toContain('import("@/src/lib/supabase-browser")');
    expect(authPanel.match(/onFocus=\{prefetchBrowserAuthClient\}/g)).toHaveLength(2);
    expect(authPanel).toContain("supabase.auth.signInWithPassword({ email: authEmail, password })");
    expect(authPanel).toContain("window.location.replace(result.redirectTo)");
  });
});
