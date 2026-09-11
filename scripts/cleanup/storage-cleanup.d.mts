export interface StorageCleanupDbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
}

export interface StorageCleanupLogger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface StorageCleanupOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  logger?: StorageCleanupLogger;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;
  createDbClient?: (connectionString: string) => Promise<StorageCleanupDbClient>;
}

export interface StorageCleanupResult {
  mode: "dry-run" | "execute";
  candidates: number;
  deleted: number;
  missing: number;
  skipped: number;
  failed: number;
}

export function isSafeCleanupObject(bucketId: unknown, objectKey: unknown): boolean;

export function runStorageCleanup(options?: StorageCleanupOptions): Promise<StorageCleanupResult>;
