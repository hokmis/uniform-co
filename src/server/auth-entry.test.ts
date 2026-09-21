import { describe, expect, it } from "vitest";
import {
  resolveAuthenticatedEntry,
  resolveLoginEntry,
} from "./auth-entry";

describe("authenticated work entry", () => {
  it("sends a valid existing session from the login page to the workbench", () => {
    expect(resolveLoginEntry(true)).toBe("/app");
    expect(resolveAuthenticatedEntry(true)).toBe("/app");
  });

  it("keeps anonymous users on the existing login form", () => {
    expect(resolveLoginEntry(false)).toBeNull();
    expect(resolveAuthenticatedEntry(false)).toBe("/login");
  });
});
