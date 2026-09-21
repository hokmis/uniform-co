import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/app/workspace-session.tsx"), "utf8");
const identitySource = readFileSync(resolve(process.cwd(), "src/domain/workspace-identity.ts"), "utf8");
const guideSource = readFileSync(resolve(process.cwd(), "src/app/use-system-guide-access.ts"), "utf8");
const accountAdminSource = readFileSync(resolve(process.cwd(), "src/app/AccountAdminPanel.tsx"), "utf8");

function listWorkspacePanelFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return listWorkspacePanelFiles(entryPath);
    return entry.name.endsWith(".tsx") ? [entryPath] : [];
  });
}

describe("workspace identity read seam", () => {
  it("keys the identity lookup by user id instead of the rotating User object", () => {
    expect(source).toContain("const userId = user?.id ?? null;");
    expect(source).toContain("}, [client, userId]);");
    expect(source).not.toContain("}, [client, user]);");
  });

  it("retries the single identity read through the shared session adapter", () => {
    expect(source).toContain("retrySupabaseQueriesAfterSessionRefresh");
    expect(source).toContain('select("id,user_roles(role_code)")');
  });

  it("does not expose a previous account while the Auth user changes", () => {
    expect(source).toContain("WorkspaceIdentitySnapshot");
    expect(identitySource).toContain("userId: string | null;");
    expect(source).toContain("workspaceIdentityForUser(identity, userId, Boolean(client && userId))");
    expect(source).toContain("identityMatchesUser");
    expect(source).toContain("accountId: identityMatchesUser ? identity.accountId : null");
    expect(source).not.toContain("queueMicrotask");
  });

  it("does not resolve a system-guide role from an identity snapshot belonging to another user", () => {
    expect(guideSource).toContain("if (identity && identity.userId !== activeUserId) return;");
    expect(guideSource).toContain("identity?.userId === activeUserId");
  });

  it("keeps rotating access tokens out of the shared workspace identity context", () => {
    expect(source).toContain("isAuthenticated: boolean;");
    expect(source).toContain("authUserId: string | null;");
    expect(source).toContain("const WorkspaceAccessTokenContext = createContext<string | null>(null);");
    expect(source).toContain("const accessToken = session?.access_token ?? null;");
    expect(source).toContain("WorkspaceAccessTokenContext.Provider value={accessToken}");
    expect(source).toContain("export function useWorkspaceAccessToken(): string | null");
    expect(source).toContain("}), [client, currentUserId, identity.accountId, identity.error, identity.loading, identity.roles, identityMatchesUser, isAuthenticated]);");
    expect(accountAdminSource).toContain("const accessToken = useWorkspaceAccessToken();");
    expect(accountAdminSource).not.toContain("session?.access_token");
  });

  it("keeps workspace panels on the stable identity selector instead of destructuring a rotating Session", () => {
    const outdatedConsumers = listWorkspacePanelFiles(resolve(process.cwd(), "src/app"))
      .filter((file) => {
        const panelSource = readFileSync(file, "utf8");
        return panelSource.includes("useWorkspaceSession()")
          && /const\s*\{[^}]*\bsession\b[^}]*\}\s*=\s*useWorkspaceSession\(\)/.test(panelSource);
      });

    expect(outdatedConsumers).toEqual([]);
  });
});
