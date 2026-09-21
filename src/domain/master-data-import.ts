export type MasterImportAttemptIdentity = {
  entityType: string;
  sourceFilename: string;
  payloadSha256: string;
};

export type MasterImportAttempt = MasterImportAttemptIdentity & {
  idempotencyKey: string;
  requestFingerprint: string;
};

export type MasterImportOutcome =
  | { kind: "applied"; rowCount: number }
  | { kind: "rejected"; rowCount: number; errorCount: number }
  | { kind: "unknown" };

function sameIdentity(left: MasterImportAttemptIdentity, right: MasterImportAttemptIdentity): boolean {
  return left.entityType === right.entityType
    && left.sourceFilename === right.sourceFilename
    && left.payloadSha256 === right.payloadSha256;
}

export function prepareMasterImportAttempt(
  current: MasterImportAttempt | null,
  identity: MasterImportAttemptIdentity,
  createIdempotencyKey: () => string,
): MasterImportAttempt {
  if (current && sameIdentity(current, identity)) return current;
  return {
    ...identity,
    idempotencyKey: createIdempotencyKey(),
    requestFingerprint: JSON.stringify(identity),
  };
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function classifyMasterImportOutcome(data: unknown, error: unknown): MasterImportOutcome {
  if (error !== null && error !== undefined) return { kind: "unknown" };
  const value = Array.isArray(data) ? data[0] : data;
  if (typeof value !== "object" || value === null) return { kind: "unknown" };
  const row = value as { status?: unknown; row_count?: unknown; error_count?: unknown };
  if (row.status === "APPLIED") return { kind: "applied", rowCount: count(row.row_count) };
  if (row.status === "FAILED") {
    return { kind: "rejected", rowCount: count(row.row_count), errorCount: count(row.error_count) };
  }
  return { kind: "unknown" };
}
