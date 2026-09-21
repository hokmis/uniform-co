import type { SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseSessionError } from "./supabase-session";

export const MISSING_READ_MODEL_CACHE_TTL_MS = 60_000;

const missingReadModels = new WeakMap<SupabaseClient, Map<string, number>>();

/**
 * Avoid retrying a known-missing rollout view on every navigation or refresh.
 * The short expiry lets an already-open browser detect a later DB migration.
 */
export function shouldProbeReadModel(client: SupabaseClient, name: string): boolean {
  const missingUntil = missingReadModels.get(client)?.get(name);
  if (missingUntil === undefined) return true;
  if (Date.now() < missingUntil) return false;
  missingReadModels.get(client)?.delete(name);
  return true;
}

/**
 * Cache only missing-object errors. Permission, schema, and other failures
 * remain visible and must never be converted into a legacy fallback.
 */
export function shouldUseLegacyReadModel(
  client: SupabaseClient,
  name: string,
  error: SupabaseSessionError | null,
): boolean {
  const message = (error?.message ?? "").toLocaleLowerCase();
  const lowerName = name.toLocaleLowerCase();
  const namesReadModel = message.includes(lowerName);
  const isMissing = error?.code === "PGRST205"
    || namesReadModel && (message.includes("does not exist") || message.includes("not found") || message.includes("could not find"));

  if (isMissing) {
    let models = missingReadModels.get(client);
    if (!models) {
      models = new Map();
      missingReadModels.set(client, models);
    }
    models.set(name, Date.now() + MISSING_READ_MODEL_CACHE_TTL_MS);
    return true;
  }

  missingReadModels.get(client)?.delete(name);
  return false;
}
