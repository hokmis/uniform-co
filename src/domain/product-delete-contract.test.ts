import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(join(root, "supabase", "migrations", "0085_uniform_item_delete.sql"), "utf8");
const manualSql = readFileSync(join(root, "supabase", "manual", "0085_uniform_item_delete.sql"), "utf8");
const catalogSource = readFileSync(join(root, "src", "app", "ProductCatalogPanel.tsx"), "utf8");
const editorSource = readFileSync(join(root, "src", "app", "ProductMasterEditorPanel.tsx"), "utf8");

describe("uniform item delete contract", () => {
  it("exposes a protected, idempotent hard-delete RPC", () => {
    for (const sql of [migration, manualSql]) {
      expect(sql).toContain("create or replace function public.delete_uniform_item(");
      expect(sql).toContain("on conflict on constraint operation_commands_operation_code_idempotency_key_key");
      expect(sql).toContain("private.append_audit_event");
      expect(sql).toContain("revoke all on function public.delete_uniform_item(uuid, text, text) from public, anon");
      expect(sql).toContain("grant execute on function public.delete_uniform_item(uuid, text, text) to authenticated");
    }
  });

  it("rejects every inventory balance or ledger reference before deletion", () => {
    expect(migration).toContain("exists (select 1 from public.inventory_balances where item_id = p_item_id)");
    expect(migration).toContain("exists (select 1 from public.inventory_ledger_entries where item_id = p_item_id)");
    expect(migration).toContain("Uniform item cannot be deleted because inventory records exist");
    expect(migration).toContain("when foreign_key_violation then");
  });

  it("keeps stop and delete as separate catalog actions", () => {
    expect(catalogSource).toContain("onDeactivateItem");
    expect(catalogSource).toContain("onDeleteItem");
    expect(catalogSource).toContain('row.is_active ? "停用" : "已停用"');
    expect(catalogSource).toContain('onClick={() => onDeleteItem(row)}');
    expect(editorSource).toContain('intent?: "EDIT" | "DEACTIVATE" | "DELETE"');
    expect(editorSource).toContain('client.rpc("delete_uniform_item"');
    expect(editorSource).toContain("確認刪除");
  });
});
