import { describe, expect, it, vi } from "vitest";
import {
  readBrowserStorageEntries,
  removeBrowserStorageEntries,
  writeBrowserStorageEntries,
  type BrowserStorage,
} from "./browser-operation-storage";

function storage(initial: Record<string, string> = {}): BrowserStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => { values.set(key, value); }),
    removeItem: vi.fn((key) => { values.delete(key); }),
    values,
  };
}

describe("browser operation recovery storage", () => {
  it("reads recovery keys without exposing storage implementation details", () => {
    const local = storage({ "correction:create": "create-1" });

    expect(readBrowserStorageEntries(["correction:create", "correction:post"], local)).toEqual({
      available: true,
      values: { "correction:create": "create-1", "correction:post": null },
    });
  });

  it("reports unavailable storage when reads throw", () => {
    const local = storage();
    vi.mocked(local.getItem).mockImplementation(() => { throw new Error("blocked"); });

    expect(readBrowserStorageEntries(["correction:create"], local)).toEqual({ available: false, values: {} });
  });

  it("rolls back partial writes when persisting an idempotency key fails", () => {
    const local = storage({ "correction:post": "old-post" });
    vi.mocked(local.setItem).mockImplementationOnce((key, value) => { local.values.set(key, value); })
      .mockImplementationOnce(() => { throw new Error("quota"); });

    expect(writeBrowserStorageEntries([
      ["correction:post", "new-post"],
      ["correction:fingerprint", "fingerprint"],
    ], local)).toBe(false);
    expect(local.values).toEqual(new Map([["correction:post", "old-post"]]));
  });

  it("removes operation keys best-effort without throwing", () => {
    const local = storage();
    vi.mocked(local.removeItem).mockImplementation(() => { throw new Error("blocked"); });

    expect(() => removeBrowserStorageEntries(["correction:post"], local)).not.toThrow();
  });
});
