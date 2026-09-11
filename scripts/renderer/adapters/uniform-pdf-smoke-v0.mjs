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
const mode = args.get("mode") ?? "render";

if (!attemptId || !payloadPath || !outputPath) {
  throw new Error("--attempt-id, --payload and --output are required");
}
if (mode === "fail") {
  throw new Error("Intentional smoke adapter failure");
}
if (mode !== "render") throw new Error(`Unsupported smoke adapter mode: ${mode}`);

const payload = JSON.parse(await readFile(payloadPath, "utf8"));
if (payload?.schema !== "uniform-document-render-payload-v1") {
  throw new Error("Unsupported document payload schema");
}

const safeAscii = (value) => String(value ?? "")
  .replaceAll(/[^\x20-\x7e]/g, "?")
  .replaceAll("\\", "\\\\")
  .replaceAll("(", "\\(")
  .replaceAll(")", "\\)");

const summary = [
  `Uniform staging renderer smoke`,
  `Type: ${safeAscii(payload.document_type)}`,
  `Kind: ${safeAscii(payload.artifact_kind)}`,
  `Revision: ${safeAscii(payload.revision)}`,
  `Template: ${safeAscii(payload.template_version)}`,
].join(" | ");

const stream = `BT\n/F1 11 Tf\n50 780 Td\n(${summary}) Tj\nET\n`;
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`,
];

let pdf = "%PDF-1.4\n";
const offsets = [0];
for (let index = 0; index < objects.length; index += 1) {
  offsets.push(Buffer.byteLength(pdf, "ascii"));
  pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
}
const xrefOffset = Buffer.byteLength(pdf, "ascii");
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += "0000000000 65535 f \n";
for (const offset of offsets.slice(1)) {
  pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

const temporaryPath = `${outputPath}.tmp-${process.pid}-${attemptId}`;
await writeFile(temporaryPath, Buffer.from(pdf, "ascii"), { flag: "wx", mode: 0o600 });
await rename(temporaryPath, outputPath);
