import { beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.fn(() => ({ auth: {} }));

vi.mock("@supabase/supabase-js", () => ({ createClient }));

describe("legacy magic-link browser client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://target-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "target-anon-key");
  });

  it("uses an explicit implicit flow only for the dedicated legacy callback", async () => {
    const { getSupabaseMagicLinkBrowserClient } = await import("./supabase-magic-link-browser");

    getSupabaseMagicLinkBrowserClient();

    expect(createClient).toHaveBeenCalledWith(
      "https://target-project.supabase.co",
      "target-anon-key",
      expect.objectContaining({
        auth: expect.objectContaining({
          flowType: "implicit",
          storage: expect.objectContaining({ isServer: false }),
          storageKey: "sb-target-project-auth-token",
        }),
      }),
    );
  });
});
