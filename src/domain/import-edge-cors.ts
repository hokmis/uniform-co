/** Exact origin allowlist; never reflect arbitrary request origins. */
export function isAllowedImportOrigin(origin: string | null, configured: string): boolean {
  if (!origin) return false;
  return configured.split(/[,;\s]+/).some((entry) => {
    if (!entry) return false;
    try {
      const url = new URL(entry);
      return (url.protocol === "https:" || url.protocol === "http:")
        && !url.username && !url.password && !url.search && !url.hash
        && url.pathname === "/" && url.origin === origin;
    } catch {
      return false;
    }
  });
}

export function importCorsHeaders(origin: string | null, configured: string): Headers {
  const headers = new Headers({
    "vary": "Origin",
    "access-control-allow-headers": "authorization, apikey, x-client-info, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  });
  if (isAllowedImportOrigin(origin, configured)) headers.set("access-control-allow-origin", origin!);
  return headers;
}
