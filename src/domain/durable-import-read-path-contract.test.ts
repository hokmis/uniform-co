import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0124_durable_import_work_queue_index.sql"),
  "utf8",
);
const workerMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0045_import_worker_snapshot_and_storage.sql"),
  "utf8",
);

describe("durable import queue read path", () => {
  it("indexes the worker's active queue ordering", () => {
    expect(migration).toContain("create index if not exists import_batches_work_queue_idx");
    expect(migration).toContain("on public.import_batches (created_at, id)");
    expect(migration).toContain("'AWAITING_UPLOAD', 'UPLOADED', 'PARSING'");
    expect(migration).toContain("'VALIDATING', 'VALIDATED', 'APPLYING'");
    expect(migration).not.toMatch(/\b(drop|delete|truncate|alter)\b/i);
  });

  it("matches the worker queue's status and order contract", () => {
    expect(workerMigration).toContain("where b.status in ('AWAITING_UPLOAD', 'UPLOADED', 'PARSING', 'VALIDATING', 'VALIDATED', 'APPLYING')");
    expect(workerMigration).toContain("order by b.created_at, b.id");
  });
});
