import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0098_read_path_indexes.sql"),
  "utf8",
);
const reportingJoinMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0100_reporting_join_indexes.sql"),
  "utf8",
);
const transactionReadMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0101_transaction_read_indexes.sql"),
  "utf8",
);
const correctionHistoryReadMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0102_correction_history_read_indexes.sql"),
  "utf8",
);
const ssoAccountReadMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0115_sso_account_email_read_index.sql"),
  "utf8",
);
const correctionHistoryLineReadMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0123_correction_history_line_indexes.sql"),
  "utf8",
);
const durableImportWorkQueueMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0124_durable_import_work_queue_index.sql"),
  "utf8",
);

describe("read path index migration", () => {
  it("covers the active workbench filters without changing data", () => {
    for (const indexName of [
      "institutions_active_code_idx",
      "departments_active_institution_code_idx",
      "employees_active_employee_no_idx",
      "uniform_items_active_code_idx",
      "inventory_reservations_active_item_idx",
      "hr_requests_status_created_at_idx",
      "seasonal_campaigns_status_closes_at_idx",
      "seasonal_approval_submission_lines_submission_item_code_idx",
      "inventory_ledger_entries_warehouse_item_date_idx",
    ]) {
      expect(migration).toContain(`create index if not exists ${indexName}`);
    }
  });

  it("is additive and repeatable", () => {
    expect(migration).not.toMatch(/\b(drop|delete|truncate|alter)\b/i);
    expect(migration.match(/create index if not exists/gi)).toHaveLength(16);
  });

  it("covers the reporting joins without changing business data", () => {
    for (const indexName of [
      "inventory_balances_item_warehouse_read_idx",
      "hr_issue_lines_request_item_read_idx",
      "purchase_receipt_lines_order_line_read_idx",
      "purchase_receipt_correction_lines_source_read_idx",
      "audit_events_occurred_at_read_idx",
    ]) {
      expect(reportingJoinMigration).toContain(`create index if not exists ${indexName}`);
    }
  });

  it("keeps reporting indexes additive and repeatable", () => {
    expect(reportingJoinMigration).not.toMatch(/\b(drop|delete|truncate|alter)\b/i);
    expect(reportingJoinMigration.match(/create index if not exists/gi)).toHaveLength(5);
  });

  it("covers correction history source filters without changing workflow data", () => {
    for (const indexName of [
      "correction_notes_hr_request_source_idx",
      "correction_notes_stocktake_source_idx",
      "correction_notes_warehouse_shipment_source_idx",
      "correction_notes_replenishment_source_idx",
    ]) {
      expect(correctionHistoryReadMigration).toContain(`create index if not exists ${indexName}`);
    }
    expect(correctionHistoryReadMigration).not.toMatch(/\b(drop|delete|truncate|alter)\b/i);
    expect(correctionHistoryReadMigration.match(/create index if not exists/gi)).toHaveLength(4);
  });

  it("covers transaction workbench filters without changing workflow data", () => {
    for (const indexName of [
      "purchase_orders_open_po_no_idx",
      "purchase_receipts_posted_receipt_no_idx",
      "hr_requests_shipped_distribution_date_idx",
      "return_notes_posted_id_idx",
      "correction_notes_purchase_receipt_source_idx",
      "correction_notes_return_note_source_idx",
    ]) {
      expect(transactionReadMigration).toContain(`create index if not exists ${indexName}`);
    }
    expect(transactionReadMigration).not.toMatch(/\b(drop|delete|truncate|alter)\b/i);
    expect(transactionReadMigration.match(/create index if not exists/gi)).toHaveLength(6);
  });

  it("keeps local SSO email resolution indexed", () => {
    expect(ssoAccountReadMigration).toContain("create index if not exists app_accounts_email_snapshot_idx");
    expect(ssoAccountReadMigration).toContain("where email_snapshot is not null");
    expect(ssoAccountReadMigration).not.toMatch(/\b(drop|delete|truncate|alter)\b/i);
    expect(ssoAccountReadMigration.match(/create index if not exists/gi)).toHaveLength(1);
  });

  it("indexes correction source lines used by the unified history view", () => {
    for (const indexName of [
      "return_correction_lines_source_read_idx",
      "issue_correction_lines_source_read_idx",
      "warehouse_transfer_correction_lines_shipment_source_read_idx",
      "warehouse_transfer_correction_lines_replenishment_source_read_idx",
      "stocktake_correction_lines_source_read_idx",
    ]) {
      expect(correctionHistoryLineReadMigration).toContain(`create index if not exists ${indexName}`);
    }
    expect(correctionHistoryLineReadMigration).toContain("where original_shipment_line_id is not null");
    expect(correctionHistoryLineReadMigration).toContain("where original_replenishment_line_id is not null");
    expect(correctionHistoryLineReadMigration).not.toMatch(/\b(drop|delete|truncate|alter)\b/i);
    expect(correctionHistoryLineReadMigration.match(/create index if not exists/gi)).toHaveLength(5);
  });

  it("keeps the durable import worker queue scan additive", () => {
    expect(durableImportWorkQueueMigration).toContain("create index if not exists import_batches_work_queue_idx");
    expect(durableImportWorkQueueMigration).toContain("on public.import_batches (created_at, id)");
    expect(durableImportWorkQueueMigration).toContain("where status in");
    expect(durableImportWorkQueueMigration).not.toMatch(/\b(drop|delete|truncate|alter)\b/i);
  });
});
