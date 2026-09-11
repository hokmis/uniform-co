import { describe, expect, it } from "vitest";
import { canonicalFingerprint, pgJsonbText } from "./fingerprint";

describe("canonicalFingerprint", () => {
  it("uses PostgreSQL jsonb text formatting", () => {
    expect(pgJsonbText({ b: 2, a: 1 })).toBe('{"a": 1, "b": 2}');
  });
  it("returns a stable SHA-256 hex fingerprint for the same payload", async () => {
    const first = await canonicalFingerprint({ accountId: "a", enabled: true });
    const second = await canonicalFingerprint({ accountId: "a", enabled: true });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the operation payload changes", async () => {
    const enabled = await canonicalFingerprint({ accountId: "a", enabled: true });
    const disabled = await canonicalFingerprint({ accountId: "a", enabled: false });
    expect(enabled).not.toBe(disabled);
  });

  it("ignores object key order", async () => {
    await expect(canonicalFingerprint({ a: 1, b: 2 })).resolves.toBe(await canonicalFingerprint({ b: 2, a: 1 }));
  });
});
