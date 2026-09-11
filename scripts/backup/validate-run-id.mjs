#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const MAX_RUN_ID_LENGTH = 80;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateBackupRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("BACKUP_RUN_ID is required");
  }
  if (runId.length > MAX_RUN_ID_LENGTH) {
    throw new Error(`BACKUP_RUN_ID must be at most ${MAX_RUN_ID_LENGTH} characters`);
  }
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error("BACKUP_RUN_ID must start with an alphanumeric character and contain only letters, numbers, '.', '_' or '-'");
  }
  return runId;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const runId = validateBackupRunId(process.argv[2]);
    console.log(`backup_run_id=${runId}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
