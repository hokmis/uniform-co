export type SearchableItemOption = {
  id: string;
  code: string;
  name: string;
  size?: string | null;
  detail?: string | null;
};

export type ItemOptionFilters = {
  size?: string;
};

export type SelectedItemSummary = {
  id: string;
  label: string;
};

export type SelectedItemsPreview = {
  items: SelectedItemSummary[];
  totalCount: number;
  hiddenCount: number;
};

/** Escape dismisses the picker from any focused descendant while interactions are allowed. */
export function shouldDismissItemPicker(key: string, disabled: boolean): boolean {
  return !disabled && key === "Escape";
}

/** Build a stable, readable summary for selected items, including stale ids. */
export function selectedItemsPreview(
  options: readonly SearchableItemOption[],
  selectedIds: readonly string[],
  limit = 5,
): SelectedItemsPreview {
  const byId = new Map(options.map((option) => [option.id, option]));
  const items = selectedIds.slice(0, Math.max(0, limit)).map((id) => {
    const option = byId.get(id);
    const label = option
      ? [option.code, option.name, option.size, option.detail].filter((part) => part?.trim()).join("｜")
      : id;
    return { id, label };
  });
  return {
    items,
    totalCount: selectedIds.length,
    hiddenCount: Math.max(0, selectedIds.length - items.length),
  };
}

export function itemOptionSizes<T extends SearchableItemOption>(options: readonly T[]): string[] {
  return [...new Set(options.map((option) => option.size?.trim()).filter((size): size is string => Boolean(size)))]
    .sort((left, right) => left.localeCompare(right, "zh-TW", { numeric: true, sensitivity: "base" }));
}

export function filterItemOptions<T extends SearchableItemOption>(
  options: readonly T[],
  query: string,
  limit = 100,
  filters: ItemOptionFilters = {},
): T[] {
  const normalizedTerms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const selectedSize = filters.size?.trim() ?? "";
  return options.filter((option) => {
    if (selectedSize && option.size?.trim() !== selectedSize) return false;
    const searchable = `${option.code} ${option.name} ${option.size ?? ""} ${option.detail ?? ""}`.toLocaleLowerCase();
    return normalizedTerms.every((term) => searchable.includes(term));
  }).slice(0, Math.max(0, limit));
}

export function canUseCustomItemCode(
  options: readonly SearchableItemOption[],
  query: string,
  allowCustomValue: boolean,
  multiple: boolean,
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!allowCustomValue || multiple || !normalizedQuery) return false;
  if (options.some((option) => option.code.toLocaleLowerCase() === normalizedQuery)) return false;
  return filterItemOptions(options, normalizedQuery, 1).length === 0;
}

export function toggleItemSelection(selectedIds: readonly string[], itemId: string): string[] {
  return selectedIds.includes(itemId)
    ? selectedIds.filter((id) => id !== itemId)
    : [...selectedIds, itemId];
}

export function selectVisibleItemOptions(selectedIds: readonly string[], visibleIds: readonly string[]): string[] {
  const selected = new Set(selectedIds);
  for (const id of visibleIds) {
    if (id) selected.add(id);
  }
  return [...selected];
}

export function clearItemPickerSelection(multiple: boolean): string | string[] {
  return multiple ? [] : "";
}
