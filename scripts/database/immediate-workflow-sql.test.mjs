import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const migrations = [
  "0114_warehouse_post_with_lines.sql",
  "0127_atomic_stocktake_completion.sql",
  "0128_atomic_hr_request_submission.sql",
  "0130_atomic_replenishment_submission.sql",
  "0137_atomic_hr_warehouse_shipment_completion.sql",
];
const read = async (path) => (await readFile(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");
const bundlePath = "supabase/manual/restore-immediate-hr-warehouse-workflows.sql";

test("immediate workflow bundle preserves the exact curated migration bodies in order", async () => {
  const bundle = await read(bundlePath);
  let previous = -1;
  for (const filename of migrations) {
    const source = (await read(`supabase/migrations/${filename}`)).replace(/^(begin|commit);\s*$/gmi, "");
    const marker = `-- Source: supabase/migrations/${filename}\n`;
    const position = bundle.indexOf(marker);
    assert.ok(position > previous, `${filename} must remain in migration order`);
    assert.ok(bundle.slice(position + marker.length).startsWith(source), `${filename} differs from its migration`);
    previous = position;
  }
});

test("immediate workflow bundle checks prerequisites before DDL and commits once", async () => {
  const bundle = await read(bundlePath);
  assert.equal((bundle.match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((bundle.match(/^commit;$/gm) ?? []).length, 1);
  assert.ok(bundle.indexOf("$preflight$;") < bundle.indexOf("create or replace function"));
  assert.match(bundle, /to_regprocedure\(required_signature\)/);
  assert.match(bundle, /notify pgrst, 'reload schema';\s*commit;/);
  assert.doesNotMatch(bundle, /supabase_migrations|SUPABASE_SERVICE_ROLE_KEY|disable trigger/i);
});
