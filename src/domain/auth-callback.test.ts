import { describe, expect, it } from "vitest";
import { inspectAuthCallbackUrl, scrubAuthCallbackUrl } from "./auth-callback";

describe("auth callback transport", () => {
  it("accepts the legacy implicit magic-link fragment only for the implicit callback", () => {
    expect(inspectAuthCallbackUrl(
      "https://uniform-co.vercel.app/auth/callback#access_token=opaque&refresh_token=opaque&expires_in=3600&token_type=bearer",
    )).toEqual({ transport: "implicit_fragment", canUseImplicitClient: true });
  });

  it("recognizes a PKCE code and prevents an implicit client flow mismatch", () => {
    expect(inspectAuthCallbackUrl("https://uniform-co.vercel.app/auth/callback?code=one-time-code")).toEqual({
      transport: "pkce_code",
      canUseImplicitClient: false,
    });
  });

  it("rejects a mixed PKCE and fragment callback instead of trying both flows", () => {
    expect(inspectAuthCallbackUrl(
      "https://uniform-co.vercel.app/auth/callback?code=one-time-code#access_token=opaque",
    ).transport).toBe("flow_mismatch");
  });

  it("classifies expired or already-used links as auth errors", () => {
    expect(inspectAuthCallbackUrl(
      "https://uniform-co.vercel.app/auth/callback#error=access_denied&error_code=otp_expired&error_description=link+expired",
    ).transport).toBe("auth_error");
    expect(inspectAuthCallbackUrl(
      "https://uniform-co.vercel.app/auth/callback?error=access_denied&error_code=otp_already_used",
    ).transport).toBe("auth_error");
  });

  it("scrubs callback credentials and auth errors without changing the path", () => {
    expect(scrubAuthCallbackUrl(
      "https://uniform-co.vercel.app/auth/callback?code=one-time-code&flow_id=flow&access_token=opaque&error=access_denied#access_token=opaque&refresh_token=opaque",
    )).toBe("https://uniform-co.vercel.app/auth/callback");
  });
});
