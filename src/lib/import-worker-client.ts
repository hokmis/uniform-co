export const maxImportWorkerKickInvocations = 4;

type ImportWorkerInvokeResult = {
  data: unknown;
  error: unknown | null;
};

export type ImportWorkerInvoker = (options: {
  body: { batchId: string };
}) => Promise<ImportWorkerInvokeResult>;

export type ImportWorkerKickResult = {
  ok: boolean;
  status: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drain a small, server-authorized amount of ready work without waiting for a
 * UI poll between Edge invocations. The server remains authoritative: each
 * continuation must be explicitly requested and report a processing status.
 */
export async function kickImportWorkerUntilYielded(
  invoke: ImportWorkerInvoker,
  batchId: string,
): Promise<ImportWorkerKickResult> {
  let lastStatus: string | null = null;

  for (let count = 0; count < maxImportWorkerKickInvocations; count += 1) {
    try {
      const { data, error } = await invoke({ body: { batchId } });
      if (error || !isRecord(data) || data.ok !== true || typeof data.status !== "string") {
        return { ok: false, status: null };
      }

      lastStatus = data.status;
      const statusHasReadyWork = lastStatus === "PARSING" || lastStatus === "VALIDATING";
      if (data.continueImmediately !== true || !statusHasReadyWork) {
        return { ok: true, status: lastStatus };
      }
    } catch {
      return { ok: false, status: null };
    }
  }

  return { ok: true, status: lastStatus };
}
