export interface ImportStagingRetentionDbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
}

export interface ImportStagingRetentionLogger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ImportStagingRetentionOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  logger?: ImportStagingRetentionLogger;
  createDbClient?: (connectionString: string) => Promise<ImportStagingRetentionDbClient>;
}

export interface ImportStagingRetentionResult {
  mode: "dry-run" | "execute";
  candidates: number;
  payloadRows: number;
  purged: number;
  skipped: number;
  failed: number;
}

export function runImportStagingRetention(
  options?: ImportStagingRetentionOptions,
): Promise<ImportStagingRetentionResult>;
