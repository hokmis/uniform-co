"use client";

import { useCallback, useSyncExternalStore } from "react";
import { getInventoryDataRevision, subscribeToInventoryDataChanges } from "@/src/domain/inventory-events";

export function useInventoryDataRevision(enabled: boolean): number {
  const subscribe = useCallback((onStoreChange: () => void) => enabled
    ? subscribeToInventoryDataChanges(onStoreChange)
    : () => undefined, [enabled]);
  return useSyncExternalStore(subscribe, getInventoryDataRevision, () => 0);
}
