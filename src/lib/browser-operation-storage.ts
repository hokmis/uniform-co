export type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const OPERATION_RECOVERY_STORAGE_UNAVAILABLE_MESSAGE =
  "瀏覽器無法保存本次操作的安全重試資訊，未送出更正，也沒有變更庫存。請允許此網站使用本機儲存後重試。";

export const OPERATION_RECOVERY_STORAGE_READ_FAILED_MESSAGE =
  "無法讀取本次更正的核對資訊；更正可能已完成，請勿重送，先重新載入並核對庫存異動紀錄。";

export function getBrowserOperationStorage(): BrowserStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readBrowserStorageEntries(
  keys: readonly string[],
  storage: BrowserStorage | null = getBrowserOperationStorage(),
): { available: boolean; values: Record<string, string | null> } {
  if (!storage) return { available: false, values: {} };
  try {
    return {
      available: true,
      values: Object.fromEntries(keys.map((key) => [key, storage.getItem(key)])),
    };
  } catch {
    return { available: false, values: {} };
  }
}

/** Persist all retry keys before a mutation; a partial write must never start a transaction. */
export function writeBrowserStorageEntries(
  entries: readonly (readonly [string, string])[],
  storage: BrowserStorage | null = getBrowserOperationStorage(),
): boolean {
  if (!storage) return false;
  const previous = readBrowserStorageEntries(entries.map(([key]) => key), storage);
  if (!previous.available) return false;

  try {
    for (const [key, value] of entries) storage.setItem(key, value);
    return true;
  } catch {
    for (const [key] of entries) {
      try {
        const value = previous.values[key];
        if (value === null || value === undefined) storage.removeItem(key);
        else storage.setItem(key, value);
      } catch {
        // Best-effort rollback only. The mutation is not started after any write failure.
      }
    }
    return false;
  }
}

export function removeBrowserStorageEntries(
  keys: readonly string[],
  storage: BrowserStorage | null = getBrowserOperationStorage(),
): void {
  if (!storage) return;
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // Cleanup is best-effort; retained idempotency keys are safe to recover later.
    }
  }
}
