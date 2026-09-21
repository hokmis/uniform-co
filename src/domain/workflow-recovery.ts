export type WorkflowRecoveryCandidate =
  | { kind: "id"; value: string }
  | { kind: "key"; value: string };

/**
 * A completed browser operation can leave both an entity id and an idempotency
 * key in localStorage. Prefer the id because it is the cheapest, most direct
 * lookup; only fall back to the key when that lookup cannot recover anything.
 */
export function workflowRecoveryCandidates(
  entityId: string | null | undefined,
  requestKey: string | null | undefined,
): WorkflowRecoveryCandidate[] {
  const candidates: WorkflowRecoveryCandidate[] = [];
  const normalizedEntityId = entityId?.trim();
  const normalizedRequestKey = requestKey?.trim();
  if (normalizedEntityId) candidates.push({ kind: "id", value: normalizedEntityId });
  if (normalizedRequestKey) candidates.push({ kind: "key", value: normalizedRequestKey });
  return candidates;
}
