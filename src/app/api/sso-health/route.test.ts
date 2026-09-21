import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("SSO health endpoint", () => {
  it("is public and returns only a successful health marker", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });
});
