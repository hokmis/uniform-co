export type CatalogPageWindow = {
  currentPage: number;
  pageCount: number;
  start: number;
  end: number;
};

export function normalizeCatalogPageSize(value: number, options: readonly number[], fallback: number): number {
  const validOptions = options.filter((option) => Number.isInteger(option) && option > 0);
  if (validOptions.includes(value)) return value;
  if (validOptions.includes(fallback)) return fallback;
  return validOptions[0] ?? 1;
}

export function resolveCatalogPageWindow(totalRows: number, requestedPage: number, pageSize: number): CatalogPageWindow {
  const safeTotal = Math.max(0, Math.floor(totalRows));
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const currentPage = Math.min(pageCount, Math.max(1, Math.floor(requestedPage) || 1));
  const start = safeTotal === 0 ? 0 : (currentPage - 1) * safePageSize + 1;
  const end = safeTotal === 0 ? 0 : Math.min(safeTotal, currentPage * safePageSize);
  return { currentPage, pageCount, start, end };
}

export function resolveVisibleCatalogColumnIds(
  columnIds: readonly string[],
  requestedIds: Iterable<string>,
  lockedIds: Iterable<string> = [],
): string[] {
  const allowed = new Set(columnIds);
  const locked = new Set([...lockedIds].filter((id) => allowed.has(id)));
  const requested = new Set([...requestedIds].filter((id) => allowed.has(id)));
  locked.forEach((id) => requested.add(id));
  if (requested.size === 0 && columnIds[0]) requested.add(columnIds[0]);
  return columnIds.filter((id) => requested.has(id));
}

export function toggleCatalogColumnId(
  columnIds: readonly string[],
  visibleIds: Iterable<string>,
  columnId: string,
  lockedIds: Iterable<string> = [],
): string[] {
  const locked = new Set(lockedIds);
  if (locked.has(columnId)) return resolveVisibleCatalogColumnIds(columnIds, visibleIds, locked);
  const next = new Set(visibleIds);
  if (next.has(columnId)) next.delete(columnId);
  else next.add(columnId);
  return resolveVisibleCatalogColumnIds(columnIds, next, locked);
}
