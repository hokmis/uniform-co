import { readFile, rename, writeFile } from "node:fs/promises";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (!flag?.startsWith("--")) throw new Error(`Unknown argument: ${flag ?? ""}`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  args.set(flag.slice(2), value);
  index += 1;
}

const attemptId = args.get("attempt-id");
const payloadPath = args.get("payload");
const outputPath = args.get("output");
if (!attemptId || !payloadPath || !outputPath) throw new Error("--attempt-id, --payload and --output are required");

const payload = JSON.parse(await readFile(payloadPath, "utf8"));
if (payload?.schema !== "uniform-erp-render-payload-v1") throw new Error("Unsupported ERP payload schema");
if (payload?.format_version !== "UNIFORM-ERP-SALES-v0") throw new Error("UNIFORM-ERP-SALES-v0 is the only validated demo format");
if (!Array.isArray(payload.lines) || payload.lines.length === 0 || payload.lines.length > 10_000) throw new Error("ERP payload must contain 1..10000 lines");

const seenItems = new Set();
const lines = payload.lines.map((line, index) => {
  if (!line || typeof line !== "object") throw new Error(`Line ${index + 1} is not an object`);
  for (const field of ["item_code", "item_name", "unit"]) {
    if (typeof line[field] !== "string" || line[field].trim() === "") throw new Error(`Line ${index + 1} has an invalid ${field}`);
  }
  if (typeof line.item_id !== "string" || line.item_id.trim() === "") throw new Error(`Line ${index + 1} has an invalid item_id`);
  if (seenItems.has(line.item_id)) throw new Error(`Duplicate item_id in ERP payload: ${line.item_id}`);
  seenItems.add(line.item_id);
  if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) throw new Error(`Line ${index + 1} has an invalid quantity`);
  if (!Number.isSafeInteger(line.line_no) || line.line_no <= 0) throw new Error(`Line ${index + 1} has an invalid line_no`);
  return line;
}).sort((left, right) => left.line_no - right.line_no);

const csvEscape = (value) => `"${String(value).replaceAll('"', '""')}"`;
const csv = [
  "item_code,item_name,unit,quantity",
  ...lines.map((line) => [line.item_code, line.item_name, line.unit, line.quantity].map(csvEscape).join(",")),
].join("\n");
const temporaryPath = `${outputPath}.tmp-${process.pid}-${attemptId}`;
await writeFile(temporaryPath, csv, { encoding: "utf8", flag: "wx", mode: 0o600 });
await rename(temporaryPath, outputPath);
