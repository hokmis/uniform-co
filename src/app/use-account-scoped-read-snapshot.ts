"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  beginAccountScopedRead,
  completeAccountScopedRead,
  createInitialAccountScopedRead,
  hasCurrentAccountScopedReadMessage,
  type AccountScopedReadOutcome,
  type AccountScopedReadState,
} from "@/src/domain/account-scoped-read";
import { createReadRequestController, hasCurrentReadSnapshot } from "@/src/domain/read-refresh";
import { safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";

type Options<T extends readonly unknown[]> = {
  accountId: string | null;
  enabled: boolean;
  refreshKey: number | string;
  emptyData: T;
  resourceLabel: string;
  initialMessage: string;
  read: () => Promise<AccountScopedReadOutcome<T>>;
};

export function useAccountScopedReadSnapshot<T extends readonly unknown[]>({
  accountId,
  enabled,
  refreshKey,
  emptyData,
  resourceLabel,
  initialMessage,
  read,
}: Options<T>) {
  const [state, setState] = useState<AccountScopedReadState<T>>(
    () => createInitialAccountScopedRead(emptyData, initialMessage),
  );
  const [reloadSequence, setReloadSequence] = useState(0);
  const [completedRequestKey, setCompletedRequestKey] = useState<string | null>(null);
  const controllerRef = useRef(createReadRequestController());
  const requestKey = JSON.stringify([accountId, refreshKey, reloadSequence]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!enabled || !accountId) {
      controller.invalidate();
      return;
    }

    const requestSequence = controller.begin();
    let active = true;

    void (async () => {
      let outcome: AccountScopedReadOutcome<T>;
      try {
        outcome = await read();
      } catch {
        // Network exceptions can contain URLs, request details, or database
        // messages. They are intentionally reduced to the standard safe copy.
        outcome = {
          status: "failure",
          errors: [],
          message: `${resourceLabel}讀取失敗：${safeSupabaseReadErrorMessage(null)}`,
        };
      }

      if (!active || !controller.isCurrent(requestSequence)) return;
      setState((current) => completeAccountScopedRead(
        current,
        accountId,
        outcome,
        emptyData,
        resourceLabel,
      ));
      setCompletedRequestKey(requestKey);
    })();

    return () => {
      active = false;
      controller.invalidate();
    };
  }, [accountId, emptyData, enabled, initialMessage, read, refreshKey, reloadSequence, requestKey, resourceLabel]);

  const reload = useCallback(() => {
    setState((current) => beginAccountScopedRead(current));
    setReloadSequence((sequence) => sequence + 1);
  }, []);
  const setMessage = useCallback((message: string) => {
    setState((current) => ({ ...current, message }));
  }, []);
  const hasCurrentSnapshot = hasCurrentReadSnapshot(enabled, state.accountId, accountId);
  const hasCurrentMessage = hasCurrentAccountScopedReadMessage(
    enabled,
    state.accountId,
    accountId,
    completedRequestKey,
    requestKey,
  );

  return {
    data: hasCurrentSnapshot ? state.data : emptyData,
    hasCurrentSnapshot,
    loading: enabled && (state.loading || completedRequestKey !== requestKey),
    message: hasCurrentMessage ? state.message : initialMessage,
    reload,
    setMessage,
  };
}
