"use client";

import { useEffect, useState } from "react";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import type { SystemGuideDocument } from "@/src/domain/system-guide";
import type { WorkspaceIdentity } from "./workspace-session";

type GuideResponse = { ok: true; documents: SystemGuideDocument[] } | { ok: false; error: string };
type GuideStatus = "allowed" | "forbidden" | "error";
type GuideState = {
  userId: string;
  status: GuideStatus;
  documents: SystemGuideDocument[];
  message: string;
};

export type SystemGuideAccess = {
  allowed: boolean;
  checking: boolean;
  documents: SystemGuideDocument[];
  documentsLoading: boolean;
  message: string;
};

class GuideRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const accessStoragePrefix = "uniform:system-guide-access:";
const stateCache = new Map<string, GuideState>();
const documentRequests = new Map<string, Promise<SystemGuideDocument[]>>();

function hasSessionAccess(userId: string): boolean {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(`${accessStoragePrefix}${userId}`) === "allowed";
}

function rememberSessionAccess(userId: string, allowed: boolean) {
  if (typeof window === "undefined") return;
  const key = `${accessStoragePrefix}${userId}`;
  if (allowed) window.sessionStorage.setItem(key, "allowed");
  else window.sessionStorage.removeItem(key);
}

async function requestDocuments(client: SupabaseClient, userId: string, session?: Session | null): Promise<SystemGuideDocument[]> {
  const existing = documentRequests.get(userId);
  if (existing) return existing;

  const request = (async () => {
    const activeSession = session?.user.id === userId ? session : (await client.auth.getSession()).data.session;
    if (!activeSession || activeSession.user.id !== userId) {
      throw new GuideRequestError("登入工作階段不存在或已過期。", 401);
    }
    const response = await fetch("/api/system-guide", {
      headers: { Authorization: `Bearer ${activeSession.access_token}` },
      cache: "no-store",
    });
    const payload = await response.json() as GuideResponse;
    if (!response.ok || !payload.ok) {
      throw new GuideRequestError(payload.ok ? "系統說明目前無法讀取。" : payload.error, response.status);
    }
    return payload.documents;
  })();

  documentRequests.set(userId, request);
  try {
    return await request;
  } finally {
    documentRequests.delete(userId);
  }
}

export function useSystemGuideAccess(
  client: SupabaseClient | null,
  user: User | null,
  session?: Session | null,
  identity?: WorkspaceIdentity,
): SystemGuideAccess {
  const [resolvedState, setResolvedState] = useState<GuideState | null>(null);
  const userId = user?.id ?? null;
  const memoryState = userId ? stateCache.get(userId) : undefined;
  const currentState = userId && resolvedState?.userId === userId ? resolvedState : memoryState;
  const optimisticAllowed = Boolean(userId && !currentState && hasSessionAccess(userId));

  useEffect(() => {
    if (!client || !user) return;
    const activeClient = client;
    const activeUserId = user.id;
    const cachedState = stateCache.get(activeUserId);
    const cachedAllowed = cachedState?.status === "allowed" || hasSessionAccess(activeUserId);
    let active = true;

    async function load() {
      // Workspace identity owns the single account/role read for the shell. Do
      // not issue the older role hint query while that snapshot is resolving.
      if (identity && identity.userId !== activeUserId) return;
      if (identity?.loading) return;
      const identityResolved = Boolean(identity?.userId === activeUserId && !identity.loading && !identity.error);
      const identityHasSystemAdmin = identity?.roles.includes("SYSTEM_ADMIN") ?? false;
      if (identityResolved && !identityHasSystemAdmin) {
        rememberSessionAccess(activeUserId, false);
        const forbiddenState: GuideState = {
          userId: activeUserId,
          status: "forbidden",
          documents: [],
          message: "這個頁面暫時只開放有效的 SYSTEM_ADMIN 帳號。",
        };
        stateCache.set(activeUserId, forbiddenState);
        setResolvedState(forbiddenState);
        return;
      }
      // The API performs the final SYSTEM_ADMIN authorization itself. Starting this
      // protected request alongside the self-readable role check removes one network
      // round trip for a cold admin visit without exposing documents to other roles.
      const prefetchedDocuments = (cachedAllowed || !cachedState) && !(cachedState?.documents.length)
        ? requestDocuments(activeClient, activeUserId, session)
        : null;
      const roleResult = identityResolved
        ? { data: { role_code: "SYSTEM_ADMIN" }, error: null }
        : await activeClient
          .from("user_roles")
          .select("role_code")
          .eq("role_code", "SYSTEM_ADMIN")
          .maybeSingle();
      const role = roleResult.data;
      const roleError = roleResult.error;

      if (!active) return;
      if (roleError || !role) {
        // The role self-read is a fast hint, not the final authorization source.
        // If RLS returns no row (or the hint query fails), use the already-started
        // protected API request so a valid admin is not hidden by a false negative.
        try {
          const fallbackDocuments = await (prefetchedDocuments ?? requestDocuments(activeClient, activeUserId, session));
          if (!active) return;
          const fallbackAllowedState: GuideState = {
            userId: activeUserId,
            status: "allowed",
            documents: fallbackDocuments,
            message: `已載入 ${fallbackDocuments.length} 份同源說明`,
          };
          rememberSessionAccess(activeUserId, true);
          stateCache.set(activeUserId, fallbackAllowedState);
          setResolvedState(fallbackAllowedState);
        } catch (error) {
          if (!active) return;
          const requestError = error instanceof GuideRequestError ? error : null;
          const accessRejected = requestError?.status === 401 || requestError?.status === 403;
          rememberSessionAccess(activeUserId, false);
          const fallbackErrorState: GuideState = {
            userId: activeUserId,
            status: accessRejected ? "forbidden" : "error",
            documents: [],
            message: accessRejected
              ? "這個頁面暫時只開放有效的 SYSTEM_ADMIN 帳號。"
              : requestError?.message ?? "系統說明載入失敗，請稍後重試。",
          };
          stateCache.set(activeUserId, fallbackErrorState);
          setResolvedState(fallbackErrorState);
        }
        return;
      }

      rememberSessionAccess(activeUserId, true);
      const allowedState: GuideState = {
        userId: activeUserId,
        status: "allowed",
        documents: cachedState?.documents ?? [],
        message: cachedState?.documents.length ? `已載入 ${cachedState.documents.length} 份同源說明` : "正在載入說明內容…",
      };
      stateCache.set(activeUserId, allowedState);
      setResolvedState(allowedState);

      try {
        const documents = await (prefetchedDocuments ?? requestDocuments(activeClient, activeUserId, session));
        if (!active) return;
        const completeState: GuideState = {
          userId: activeUserId,
          status: "allowed",
          documents,
          message: `已載入 ${documents.length} 份同源說明`,
        };
        stateCache.set(activeUserId, completeState);
        setResolvedState(completeState);
      } catch (error) {
        if (!active) return;
        const requestError = error instanceof GuideRequestError ? error : null;
        if (requestError?.status === 401 || requestError?.status === 403) {
          rememberSessionAccess(activeUserId, false);
          const forbiddenState: GuideState = {
            userId: activeUserId,
            status: "forbidden",
            documents: [],
            message: requestError.message,
          };
          stateCache.set(activeUserId, forbiddenState);
          setResolvedState(forbiddenState);
          return;
        }
        const errorState: GuideState = {
          ...allowedState,
          status: "error",
          message: requestError?.message ?? "系統說明載入失敗，請稍後重試。",
        };
        stateCache.set(activeUserId, errorState);
        setResolvedState(errorState);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [client, identity, session, user]);

  const allowed = currentState?.status === "allowed" || currentState?.status === "error" || optimisticAllowed;
  return {
    allowed,
    checking: Boolean(userId && !currentState && !optimisticAllowed),
    documents: currentState?.documents ?? [],
    documentsLoading: allowed && !currentState?.documents.length && currentState?.status !== "error",
    message: currentState?.message ?? (optimisticAllowed ? "正在同步說明內容…" : "正在確認 SYSTEM_ADMIN 權限…"),
  };
}
