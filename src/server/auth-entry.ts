export const AUTHENTICATED_WORK_ENTRY = "/app";

export function resolveLoginEntry(hasSession: boolean): "/app" | null {
  return hasSession ? AUTHENTICATED_WORK_ENTRY : null;
}

export function resolveAuthenticatedEntry(hasSession: boolean): "/app" | "/login" {
  return hasSession ? AUTHENTICATED_WORK_ENTRY : "/login";
}
