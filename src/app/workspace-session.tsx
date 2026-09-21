"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode, type ReactElement } from "react";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { effectiveAccountRoles } from "@/src/domain/account-roles";
import { workspaceIdentityForUser, type WorkspaceIdentitySnapshot } from "@/src/domain/workspace-identity";
import { retrySupabaseQueriesAfterSessionRefresh } from "@/src/lib/supabase-session";

type IdentityRow = {
  id: string;
  user_roles?: Array<{ role_code?: string | null }> | null;
};

export type WorkspaceIdentity = WorkspaceIdentitySnapshot;

export type WorkspaceSession = {
  client: SupabaseClient | null;
  isAuthenticated: boolean;
  authUserId: string | null;
  accountId: string | null;
  roles: string[];
  identityLoading: boolean;
  identityError: string | null;
};

const WorkspaceSessionContext = createContext<WorkspaceSession | null>(null);
const WorkspaceAccessTokenContext = createContext<string | null>(null);

export function useWorkspaceIdentity(client: SupabaseClient | null, user: User | null): WorkspaceIdentity {
  const userId = user?.id ?? null;
  const [identity, setIdentity] = useState<WorkspaceIdentity>({
    userId,
    accountId: null,
    roles: [],
    loading: Boolean(client && userId),
    error: null,
  });

  useEffect(() => {
    let active = true;

    if (!client || !userId) {
      return () => { active = false; };
    }

    const activeClient = client;
    const activeUserId = userId;

    async function loadIdentity() {
      const [result] = await retrySupabaseQueriesAfterSessionRefresh(
        activeClient,
        async () => [await activeClient
          .from("app_accounts")
          .select("id,user_roles(role_code)")
          .eq("auth_user_id", activeUserId)
          .limit(2)] as const,
      );

      if (!active) return;
      if (result.error) {
        setIdentity({ userId: activeUserId, accountId: null, roles: [], loading: false, error: "工作區身份資料載入失敗。" });
        return;
      }

      const rows = (result.data ?? []) as IdentityRow[];
      if (rows.length !== 1 || !rows[0]?.id) {
        setIdentity({ userId: activeUserId, accountId: null, roles: [], loading: false, error: "目前登入帳號未對應唯一的工作區身份。" });
        return;
      }

      const storedRoles = [...new Set((rows[0].user_roles ?? [])
        .map((role) => role.role_code)
        .filter((role): role is string => Boolean(role)))];
      const roles = effectiveAccountRoles(storedRoles);
      setIdentity({ userId: activeUserId, accountId: rows[0].id, roles, loading: false, error: null });
    }

    void loadIdentity();
    return () => { active = false; };
  }, [client, userId]);

  return useMemo(
    () => workspaceIdentityForUser(identity, userId, Boolean(client && userId)),
    [client, identity, userId],
  );
}

export function WorkspaceSessionProvider({
  client,
  session,
  user,
  identity,
  children,
}: {
  client: SupabaseClient | null;
  session: Session | null;
  user: User | null;
  identity: WorkspaceIdentity;
  children: ReactNode;
}): ReactElement {
  const currentUserId = user?.id ?? null;
  const isAuthenticated = Boolean(session);
  const accessToken = session?.access_token ?? null;
  const identityMatchesUser = identity.userId === currentUserId;
  const value = useMemo<WorkspaceSession>(() => ({
    client,
    isAuthenticated,
    authUserId: currentUserId,
    accountId: identityMatchesUser ? identity.accountId : null,
    roles: identityMatchesUser ? identity.roles : [],
    identityLoading: Boolean(isAuthenticated && (!identityMatchesUser || identity.loading)),
    identityError: identityMatchesUser ? identity.error : null,
  }), [client, currentUserId, identity.accountId, identity.error, identity.loading, identity.roles, identityMatchesUser, isAuthenticated]);

  return (
    <WorkspaceAccessTokenContext.Provider value={accessToken}>
      <WorkspaceSessionContext.Provider value={value}>{children}</WorkspaceSessionContext.Provider>
    </WorkspaceAccessTokenContext.Provider>
  );
}

export function useWorkspaceSession(): WorkspaceSession {
  const value = useContext(WorkspaceSessionContext);
  if (!value) throw new Error("useWorkspaceSession must be used inside WorkspaceSessionProvider");
  return value;
}

export function useWorkspaceAccessToken(): string | null {
  return useContext(WorkspaceAccessTokenContext);
}
