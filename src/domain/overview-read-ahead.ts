export type OverviewReadAheadCoordinator<T> = {
  start(authUserId: string, read: () => Promise<T>): Promise<T>;
  take(authUserId: string | null): Promise<T> | null;
  clear(authUserId: string): void;
};

/**
 * Holds one authenticated user's read while workspace identity is resolving.
 * The caller may start the protected read early, then consume it only after
 * its normal identity gate succeeds. A user mismatch always discards the
 * pending result instead of transferring it to another session.
 */
export function createOverviewReadAheadCoordinator<T>(): OverviewReadAheadCoordinator<T> {
  let pending: { authUserId: string; result: Promise<T> } | null = null;

  return {
    start(authUserId, read) {
      if (pending?.authUserId === authUserId) return pending.result;

      let result: Promise<T>;
      try {
        result = Promise.resolve(read());
      } catch (error) {
        result = Promise.reject(error);
      }
      // A session can disappear before the result is consumed. Mark the
      // rejection handled here; the normal overview read still observes it.
      void result.catch(() => undefined);
      pending = { authUserId, result };
      return result;
    },

    take(authUserId) {
      const current = pending;
      pending = null;
      return current && current.authUserId === authUserId ? current.result : null;
    },

    clear(authUserId) {
      if (pending?.authUserId === authUserId) pending = null;
    },
  };
}
