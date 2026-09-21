export type WorkspacePrefetchIntent<WorkspaceId extends string> = {
  schedule(workspaceId: WorkspaceId): void;
  cancel(workspaceId: WorkspaceId): void;
  cancelAll(): void;
};

export const DEFAULT_WORKSPACE_PREFETCH_INTENT_MS = 180;

export function createWorkspacePrefetchIntent<WorkspaceId extends string>(
  prefetch: (workspaceId: WorkspaceId) => void,
  delayMs = DEFAULT_WORKSPACE_PREFETCH_INTENT_MS,
): WorkspacePrefetchIntent<WorkspaceId> {
  const timers = new Map<WorkspaceId, ReturnType<typeof globalThis.setTimeout>>();

  function cancel(workspaceId: WorkspaceId): void {
    const timer = timers.get(workspaceId);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      timers.delete(workspaceId);
    }
  }

  return {
    schedule(workspaceId) {
      cancel(workspaceId);
      timers.set(workspaceId, globalThis.setTimeout(() => {
        timers.delete(workspaceId);
        prefetch(workspaceId);
      }, delayMs));
    },
    cancel,
    cancelAll() {
      for (const workspaceId of timers.keys()) cancel(workspaceId);
    },
  };
}
