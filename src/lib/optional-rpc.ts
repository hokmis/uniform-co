export type OptionalRpcError = {
  code?: string | null;
  message?: string | null;
};

export type OptionalRpcCall<TError extends OptionalRpcError = OptionalRpcError> = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: TError | null }>;

export type OptionalRpcAttempt<TError extends OptionalRpcError> =
  | { status: "called"; data: unknown; error: TError | null }
  | { status: "missing" };

export const MISSING_OPTIONAL_RPC_CACHE_TTL_MS = 60_000;

const missingFunctionsByOwner = new WeakMap<object, Map<string, number>>();

function isExplicitlyMissing(error: OptionalRpcError | null, functionName: string): boolean {
  if (!error) return false;
  const message = (error?.message ?? "").toLocaleLowerCase();
  const name = functionName.toLocaleLowerCase();
  const namesTargetFunction = message.includes(`function public.${name}`)
    || message.includes(`function ${name}`);

  if (!namesTargetFunction) return false;
  if (error.code === "PGRST202") return message.includes("could not find") && message.includes("schema cache");
  return error.code === "42883" && message.includes("does not exist");
}

/**
 * Calls an optional rollout RPC once its absence is known for this client.
 * Only an explicit missing-function response is cached; transport, permission,
 * and business errors remain visible to the caller and never select a fallback.
 */
export async function attemptOptionalRpc<TError extends OptionalRpcError>(
  owner: object,
  rpc: OptionalRpcCall<TError>,
  functionName: string,
  args: Record<string, unknown>,
): Promise<OptionalRpcAttempt<TError>> {
  const now = Date.now();
  const knownMissingUntil = missingFunctionsByOwner.get(owner)?.get(functionName);
  if (knownMissingUntil !== undefined && now < knownMissingUntil) {
    return { status: "missing" };
  }
  if (knownMissingUntil !== undefined) missingFunctionsByOwner.get(owner)?.delete(functionName);

  const response = await rpc(functionName, args);
  if (isExplicitlyMissing(response.error, functionName)) {
    const missingFunctions = missingFunctionsByOwner.get(owner) ?? new Map<string, number>();
    missingFunctions.set(functionName, Date.now() + MISSING_OPTIONAL_RPC_CACHE_TTL_MS);
    missingFunctionsByOwner.set(owner, missingFunctions);
    return { status: "missing" };
  }

  return { status: "called", data: response.data, error: response.error };
}
