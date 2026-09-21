import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MISSING_READ_MODEL_CACHE_TTL_MS,
  shouldProbeReadModel,
  shouldUseLegacyReadModel,
} from "./read-model-rollout";

describe("read model rollout fallback", () => {
  afterEach(() => vi.useRealTimers());

  it("remembers a missing view per client and retries after a short expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    const client = {} as SupabaseClient;

    expect(shouldProbeReadModel(client, "v_overview_core")).toBe(true);
    expect(shouldUseLegacyReadModel(client, "v_overview_core", {
      code: "PGRST205",
      message: "Could not find the table",
    })).toBe(true);
    expect(shouldProbeReadModel(client, "v_overview_core")).toBe(false);
    expect(shouldProbeReadModel({} as SupabaseClient, "v_overview_core")).toBe(true);
    expect(shouldProbeReadModel(client, "v_account_directory")).toBe(true);

    vi.advanceTimersByTime(MISSING_READ_MODEL_CACHE_TTL_MS);
    expect(shouldProbeReadModel(client, "v_overview_core")).toBe(true);
  });

  it("does not cache permission failures as missing views", () => {
    const client = {} as SupabaseClient;

    expect(shouldUseLegacyReadModel(client, "v_account_directory", {
      code: "42501",
      message: "permission denied",
    })).toBe(false);
    expect(shouldProbeReadModel(client, "v_account_directory")).toBe(true);
  });

  it("does not treat a different missing relation as this read model being absent", () => {
    const client = {} as SupabaseClient;

    expect(shouldUseLegacyReadModel(client, "v_employee_directory", {
      code: "42P01",
      message: 'relation "public.employees" does not exist',
    })).toBe(false);
    expect(shouldProbeReadModel(client, "v_employee_directory")).toBe(true);
  });

  it("clears a cached miss after a successful probe", () => {
    const client = {} as SupabaseClient;
    shouldUseLegacyReadModel(client, "v_employee_directory", {
      code: "42P01",
      message: 'relation "public.v_employee_directory" does not exist',
    });
    expect(shouldProbeReadModel(client, "v_employee_directory")).toBe(false);

    expect(shouldUseLegacyReadModel(client, "v_employee_directory", null)).toBe(false);
    expect(shouldProbeReadModel(client, "v_employee_directory")).toBe(true);
  });
});
