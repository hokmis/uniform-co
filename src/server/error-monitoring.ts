import { createHash } from "node:crypto";
import type { Instrumentation } from "next";

type RequestErrorContext = Parameters<Instrumentation.onRequestError>[2];

export type ErrorMonitoringRecord = Readonly<{
  event: "server.request_error";
  version: 1;
  timestamp: string;
  environment: "development" | "preview" | "staging" | "production" | "test" | "unknown";
  routePath: string;
  routerKind: RequestErrorContext["routerKind"];
  routeType: RequestErrorContext["routeType"];
  errorKind: string;
  digest?: string;
  fingerprint: string;
}>;

type ReportServerErrorInput = Readonly<{
  error: unknown;
  context: RequestErrorContext;
}>;

type ReportServerErrorOptions = Readonly<{
  logger?: (line: string) => void;
  now?: () => Date;
  environment?: string;
}>;

const SAFE_ENVIRONMENTS = new Set([
  "development",
  "preview",
  "staging",
  "production",
  "test",
]);

function normalizeEnvironment(candidate: string | undefined): ErrorMonitoringRecord["environment"] {
  if (candidate && SAFE_ENVIRONMENTS.has(candidate)) {
    return candidate as ErrorMonitoringRecord["environment"];
  }
  return "unknown";
}

function resolveEnvironment(override: string | undefined): ErrorMonitoringRecord["environment"] {
  return normalizeEnvironment(
    override ?? process.env.UNIFORM_DEPLOYMENT_ENV ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  );
}

function normalizeRoutePath(routePath: string): string {
  const [pathname] = routePath.split(/[?#]/, 1);
  return (pathname || "/").slice(0, 512);
}

function classifyError(error: unknown): string {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof ReferenceError) return "ReferenceError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof URIError) return "URIError";
  if (error instanceof EvalError) return "EvalError";
  if (error instanceof AggregateError) return "AggregateError";
  if (error instanceof Error) return "Error";
  if (error === null) return "UnknownNull";
  switch (typeof error) {
    case "undefined":
      return "UnknownUndefined";
    case "string":
      return "UnknownString";
    case "number":
      return "UnknownNumber";
    case "bigint":
      return "UnknownBigInt";
    case "boolean":
      return "UnknownBoolean";
    case "symbol":
      return "UnknownSymbol";
    case "function":
      return "UnknownFunction";
    default:
      return "UnknownObject";
  }
}

function safeDigest(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const digest = (error as Error & { digest?: unknown }).digest;
  if (typeof digest !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(digest)) return undefined;
  return digest;
}

function fingerprintFor(record: Pick<ErrorMonitoringRecord, "routePath" | "routerKind" | "routeType" | "errorKind">) {
  return createHash("sha256")
    .update(JSON.stringify([record.routePath, record.routerKind, record.routeType, record.errorKind]))
    .digest("hex");
}

export function createServerErrorRecord(
  input: ReportServerErrorInput,
  options: Pick<ReportServerErrorOptions, "now" | "environment"> = {},
): ErrorMonitoringRecord {
  const base = {
    event: "server.request_error" as const,
    version: 1 as const,
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    environment: resolveEnvironment(options.environment),
    routePath: normalizeRoutePath(input.context.routePath),
    routerKind: input.context.routerKind,
    routeType: input.context.routeType,
    errorKind: classifyError(input.error),
  };
  const digest = safeDigest(input.error);

  return {
    ...base,
    ...(digest ? { digest } : {}),
    fingerprint: fingerprintFor(base),
  };
}

export function reportServerError(
  input: ReportServerErrorInput,
  options: ReportServerErrorOptions = {},
): ErrorMonitoringRecord {
  const record = createServerErrorRecord(input, options);
  const logger = options.logger ?? ((line: string) => console.error(line));
  logger(`[error-monitoring] ${JSON.stringify(record)}`);
  return record;
}
