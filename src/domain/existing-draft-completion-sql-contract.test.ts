import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(process.cwd(), "supabase/migrations/0135_atomic_existing_receipt_return_completion.sql");

describe("atomic completion of existing receiving and return drafts", () => {
  const migration = readFileSync(migrationPath, "utf8");

  it.each([
    ["complete_existing_purchase_receipt", "update_purchase_receipt_draft", "post_purchase_receipt", "WAREHOUSE"],
    ["complete_existing_return_note", "update_return_note_draft", "post_return_note", "HR"],
  ])("updates and completes %s inside one protected transaction", (wrapper, updateFunction, postFunction, role) => {
    const start = migration.indexOf(`create or replace function public.${wrapper}(`);
    const end = migration.indexOf("\n$$;", start);
    const definition = migration.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(definition).toContain("security definer");
    expect(definition).toContain("auth.uid() is null");
    expect(definition).toContain(`private.has_role('${role}')`);
    expect(definition.indexOf(`public.${updateFunction}(`)).toBeGreaterThan(-1);
    expect(definition.indexOf(`public.${postFunction}(`)).toBeGreaterThan(definition.indexOf(`public.${updateFunction}(`));
    expect(definition).toContain("status = 'POSTED'");
    expect(migration).toContain(`revoke all on function public.${wrapper}(`);
    expect(migration).toContain(`grant execute on function public.${wrapper}(`);
  });

  it("delegates inventory writes to the existing guarded RPCs", () => {
    expect(migration).not.toMatch(/insert into public\.(inventory_balances|inventory_ledger_entries|purchase_receipts|return_notes)/i);
    expect(migration).not.toMatch(/update public\.(inventory_balances|inventory_ledger_entries|purchase_receipts|return_notes)/i);
    expect(migration).not.toMatch(/delete from public\.(inventory_balances|inventory_ledger_entries|purchase_receipts|return_notes)/i);
  });

  it("keeps the SQL Editor copy byte-identical to the versioned migration", () => {
    const manual = readFileSync(
      resolve(process.cwd(), "supabase/manual/0135_atomic_existing_receipt_return_completion.sql"),
      "utf8",
    );

    expect(manual).toBe(migration);
  });
});
