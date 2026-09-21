import { shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "./read-refresh";
import type { SupabaseSessionError } from "@/src/lib/supabase-session";

export type AccountScopedReadState<T extends readonly unknown[]> = {
  data: T;
  accountId: string | null;
  loading: boolean;
  message: string;
};

export type AccountScopedReadOutcome<T extends readonly unknown[]> =
  | { status: "success"; data: T; message: string }
  | { status: "failure"; errors: readonly SupabaseSessionError[]; message: string };

export function createInitialAccountScopedRead<T extends readonly unknown[]>(
  data: T,
  message: string,
): AccountScopedReadState<T> {
  return { data, accountId: null, loading: false, message };
}

export function beginAccountScopedRead<T extends readonly unknown[]>(
  current: AccountScopedReadState<T>,
): AccountScopedReadState<T> {
  return { ...current, loading: true };
}

export function hasCurrentAccountScopedReadMessage(
  enabled: boolean,
  snapshotAccountId: string | null,
  accountId: string | null,
  completedRequestKey: string | null,
  requestKey: string,
): boolean {
  return enabled
    && Boolean(accountId)
    && (snapshotAccountId === accountId || completedRequestKey === requestKey);
}

/**
 * Commits one account-bound list read. Only a non-empty snapshot from the same
 * account survives a known transient JWT synchronization error; all other
 * failures clear the data before it can be presented as authoritative.
 */
export function completeAccountScopedRead<T extends readonly unknown[]>(
  current: AccountScopedReadState<T>,
  accountId: string,
  outcome: AccountScopedReadOutcome<T>,
  emptyData: T,
  resourceLabel: string,
): AccountScopedReadState<T> {
  if (outcome.status === "success") {
    return {
      data: outcome.data,
      accountId,
      loading: false,
      message: outcome.message,
    };
  }

  const preserveSnapshot = Boolean(accountId)
    && current.accountId === accountId
    && shouldPreserveReadSnapshot(current.data, [...outcome.errors]);

  if (preserveSnapshot) {
    return {
      ...current,
      loading: false,
      message: staleReadSnapshotMessage(resourceLabel),
    };
  }

  return {
    data: emptyData,
    accountId: null,
    loading: false,
    message: outcome.message,
  };
}
