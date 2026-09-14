const encoder = new TextEncoder();

function comparePgJsonbKeys(left: string, right: string): number {
  // PostgreSQL jsonb orders object pairs by UTF-8 byte length, then bytewise.
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return leftBytes.length - rightBytes.length;
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return 0;
}

export function pgJsonbText(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(pgJsonbText).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => comparePgJsonbKeys(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}: ${pgJsonbText(child)}`).join(", ")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Fingerprint payload contains a non-finite number");
    return JSON.stringify(value);
  }
  throw new TypeError("Fingerprint payload contains an unsupported value");
}

export async function canonicalFingerprint(payload: unknown): Promise<string> {
  const encoded = encoder.encode(pgJsonbText(payload));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
