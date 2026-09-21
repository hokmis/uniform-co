export type OperationAttempt = {
  key: string;
  fingerprint: string;
};

export function prepareOperationAttempt(
  current: OperationAttempt | null,
  fingerprint: string,
  createKey: () => string,
): OperationAttempt {
  if (current?.fingerprint === fingerprint) return current;
  return { key: createKey(), fingerprint };
}
