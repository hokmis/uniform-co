import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "supabase", "migrations", "0131_atomic_correction_completion.sql"), "utf8");

const corrections = [
  ["return", "create_return_correction_draft", "post_return_correction", "text, uuid, bigint, text, text, text, text, text, text"],
  ["hr_issue", "create_hr_issue_correction_draft", "post_hr_issue_correction", "text, uuid, bigint, text, text, text, text, text, text"],
  ["warehouse_transfer", "create_warehouse_transfer_correction_draft", "post_warehouse_transfer_correction", "text, text, uuid, bigint, text, text, text, text, text, text"],
  ["purchase_receipt", "create_purchase_receipt_correction_draft", "post_purchase_receipt_correction", "text, uuid, bigint, bigint, bigint, text, text, text, text, text, text"],
  ["stocktake", "create_stocktake_correction_draft", "post_stocktake_correction", "text, uuid, bigint, text, text, text, text, text, text"],
] as const;

function functionBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.complete_${name}_correction(`);
  if (start < 0) return "";
  const end = sql.indexOf("\n$$;", start);
  return end < 0 ? "" : sql.slice(start, end + 4);
}

describe("atomic correction completion migration", () => {
  it.each(corrections)("wraps %s create and POST in one invoker transaction", (kind, createFunction, postFunction, signature) => {
    const body = functionBody(kind);
    expect(body).not.toBe("");
    expect(body).toContain("returns public.correction_notes");
    expect(body).toMatch(/security invoker/i);
    expect(body).toContain("set search_path = pg_catalog, private");
    expect(body).toContain(`public.${createFunction}(`);
    expect(body).toContain(`public.${postFunction}(`);
    expect(body).toContain("p_post_request_fingerprint");
    expect(body.indexOf(`public.${createFunction}(`)).toBeLessThan(body.indexOf(`public.${postFunction}(`));
    expect(body).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(sql).toContain(`revoke all on function public.complete_${kind}_correction(${signature}) from public, anon`);
    expect(sql).toContain(`grant execute on function public.complete_${kind}_correction(${signature}) to authenticated`);
  });
});
