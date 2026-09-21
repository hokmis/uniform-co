export type WorkspaceIdentitySnapshot = {
  userId: string | null;
  accountId: string | null;
  roles: string[];
  loading: boolean;
  error: string | null;
};

export function workspaceIdentityForUser(
  snapshot: WorkspaceIdentitySnapshot,
  userId: string | null,
  isLoading: boolean,
): WorkspaceIdentitySnapshot {
  if (snapshot.userId === userId) return snapshot;
  return {
    userId,
    accountId: null,
    roles: [],
    loading: isLoading,
    error: null,
  };
}
