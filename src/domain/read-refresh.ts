import { isSupabaseSessionSyncError, type SupabaseSessionError } from "../lib/supabase-session";

export type ReadRequestController = {
  begin: () => number;
  invalidate: () => void;
  isCurrent: (sequence: number) => boolean;
};

/**
 * A read snapshot is usable only while the view is authorized and still in
 * the same data scope that produced it. Background refresh does not invalidate
 * an otherwise current snapshot; callers decide separately which controls
 * depend on the refresh completing.
 */
export function hasCurrentReadSnapshot(
  scopeReady: boolean,
  snapshotScopeKey: string | null | undefined,
  currentScopeKey: string | null | undefined,
): boolean {
  return scopeReady && Boolean(currentScopeKey) && snapshotScopeKey === currentScopeKey;
}

/**
 * Owns the ordering rule for overlapping reads. A caller only needs to keep
 * the token returned by begin(); older requests can never close the loading
 * state or publish a result after a newer read begins.
 */
export function createReadRequestController(): ReadRequestController {
  let currentSequence = 0;
  return {
    begin: () => {
      currentSequence += 1;
      return currentSequence;
    },
    invalidate: () => {
      currentSequence += 1;
    },
    isCurrent: (sequence) => sequence === currentSequence,
  };
}

/**
 * A dependent read is loading only while its selected resource is still the
 * resource owned by the active view. Clearing/changing the selection or
 * leaving the authorized scope immediately removes the stale loading state,
 * even when an abandoned network request never reaches its finally block.
 */
export function isReadPendingForSelection(
  selectedKey: string | null | undefined,
  pendingKey: string | null | undefined,
  scopeReady: boolean,
): boolean {
  return scopeReady && Boolean(selectedKey) && selectedKey === pendingKey;
}

/**
 * A transient browser-session sync failure should not erase a successful read
 * snapshot. Permission, schema, and data errors must still clear the view so
 * the UI never presents stale rows as an authoritative result after access is
 * lost.
 */
export function shouldPreserveReadSnapshot<T>(
  snapshot: readonly T[],
  errors: readonly SupabaseSessionError[],
): boolean {
  return snapshot.length > 0
    && errors.length > 0
    && errors.every((error) => isSupabaseSessionSyncError(error));
}

export function staleReadSnapshotMessage(resourceLabel: string): string {
  return `${resourceLabel}暫時無法更新，仍顯示上次已載入資料；請稍後重新整理。`;
}
