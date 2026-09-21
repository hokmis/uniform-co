import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const projectRoot = process.cwd();
const buildRoot = resolve(projectRoot, ".next");
const manifestPath = resolve(buildRoot, "app-build-manifest.json");
const budgetBytes = 550 * 1024;

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  throw new Error("Next build manifest is unavailable; run npm run build before the login bundle check.");
}

const chunks = manifest.pages?.["/login/page"];
if (!Array.isArray(chunks) || chunks.length === 0) {
  throw new Error("The /login/page entry is missing from the Next build manifest.");
}

const assets = chunks
  .filter((file) => file.endsWith(".js"))
  .map((file) => {
    const assetPath = resolve(buildRoot, file);
    if (!assetPath.startsWith(`${buildRoot}${sep}`)) {
      throw new Error("The login build manifest contains an unsafe asset path.");
    }
    return { file, bytes: statSync(assetPath).size };
  });
const totalBytes = assets.reduce((total, asset) => total + asset.bytes, 0);

console.log(`Login route JavaScript: ${totalBytes} bytes across ${assets.length} chunks (budget ${budgetBytes} bytes).`);
if (totalBytes > budgetBytes) {
  process.exitCode = 1;
  console.error("The login route's initial JavaScript exceeds its payload budget.");
}
