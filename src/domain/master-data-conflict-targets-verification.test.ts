import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const verificationSql = readFileSync(
  join(process.cwd(), "supabase", "manual", "verify-master-data-conflict-targets.sql"),
  "utf8",
);
const rebuildSql = readFileSync(
  join(process.cwd(), "supabase", "manual", "rebuild-master-import-rpc.sql"),
  "utf8",
);
const constraintTargetSql = readFileSync(
  join(process.cwd(), "supabase", "manual", "0084_master_data_constraint_targets.sql"),
  "utf8",
);
const editorSource = readFileSync(
  join(process.cwd(), "src", "app", "ProductMasterEditorPanel.tsx"),
  "utf8",
);
const normalizedSql = verificationSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

describe("manual master-data conflict target verification SQL", () => {
  it("checks the exact indexes created by 0083 and the deployed apply RPC", () => {
    expect(normalizedSql).toContain("pg_indexes");
    expect(normalizedSql).toContain("to_regprocedure('public.apply_master_import(text, text, jsonb, text, text)')");
    expect(normalizedSql).toContain("uniform_items_item_code_conflict_idx");
    expect(normalizedSql).toContain("operation_commands_operation_idempotency_conflict_idx");
    expect(normalizedSql).toContain("supplier_uniform_items_supplier_item_conflict_idx");
  });

  it("is read-only and does not mask manually applied migration ledger gaps", () => {
    expect(normalizedSql).toContain("supabase_migrations.schema_migrations");
    expect(normalizedSql).not.toMatch(/\b(create|alter|drop|insert|update|delete|truncate)\b/i);
  });

  it("guides users to verify the active project instead of blindly rerunning 0083", () => {
    expect(editorSource).toContain("verify-master-data-conflict-targets.sql");
    expect(editorSource).toContain("0084_master_data_constraint_targets.sql");
    expect(editorSource).toContain("錯誤碼");
  });

  it("provides a transactional plan-rebuild repair without application data writes", () => {
    const normalizedRebuildSql = rebuildSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
    expect(normalizedRebuildSql).toContain("pg_get_functiondef");
    expect(normalizedRebuildSql).toContain("execute current_definition");
    expect(normalizedRebuildSql).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
  });

  it("provides an idempotent named-constraint repair guarded by constraint checks", () => {
    const normalizedConstraintSql = constraintTargetSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
    expect(normalizedConstraintSql).toContain("pg_constraint");
    expect(normalizedConstraintSql).toContain("on conflict on constraint uniform_items_item_code_key");
    expect(normalizedConstraintSql).toContain("on conflict on constraint operation_commands_operation_code_idempotency_key_key");
    expect(normalizedConstraintSql).toContain("execute patched_definition");
    expect(normalizedConstraintSql).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
  });
});
