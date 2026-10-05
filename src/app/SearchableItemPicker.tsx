"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { canUseCustomItemCode, clearItemPickerSelection, filterItemOptions, itemOptionSizes, selectVisibleItemOptions, selectedItemsPreview, shouldDismissItemPicker, toggleItemSelection, type SearchableItemOption } from "@/src/domain/item-picker";

type Props = {
  options: readonly SearchableItemOption[];
  value: string | string[];
  onChange: (value: string | string[]) => void;
  multiple?: boolean;
  allowCustomValue?: boolean;
  customValueActionLabel?: string;
  disabled?: boolean;
  label: string;
  entityNoun?: string;
  entityCounter?: string;
  placeholder?: string;
  emptyMessage?: string;
};

function optionLabel(option: SearchableItemOption) {
  return `${option.code}｜${option.name}${option.size ? `｜${option.size}` : ""}${option.detail ? `｜${option.detail}` : ""}`;
}

export default function SearchableItemPicker({
  options,
  value,
  onChange,
  multiple = false,
  allowCustomValue = false,
  customValueActionLabel = "以完整品號查詢",
  disabled = false,
  label,
  entityNoun = "品號",
  entityCounter = "個",
  placeholder = entityNoun === "品號" ? "搜尋品號或品名" : `搜尋${entityNoun}或姓名`,
  emptyMessage = `沒有符合的${entityNoun}`,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sizeFilter, setSizeFilter] = useState("");
  const [showAllSelected, setShowAllSelected] = useState(false);
  const [previousDisabled, setPreviousDisabled] = useState(disabled);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  if (previousDisabled !== disabled) {
    setPreviousDisabled(disabled);
    if (disabled) {
      setOpen(false);
      setQuery("");
      setSizeFilter("");
      setShowAllSelected(false);
    }
  }

  const selectedIds = useMemo(() => Array.isArray(value) ? value : value ? [value] : [], [value]);
  const selectedOptions = useMemo(() => {
    const byId = new Map(options.map((option) => [option.id, option]));
    return selectedIds.map((id) => byId.get(id)).filter((option): option is SearchableItemOption => Boolean(option));
  }, [options, selectedIds]);
  const sizeOptions = useMemo(() => itemOptionSizes(options), [options]);
  const activeSizeFilter = sizeOptions.includes(sizeFilter) ? sizeFilter : "";
  const visibleOptions = useMemo(() => filterItemOptions(options, query, 100, { size: activeSizeFilter }), [activeSizeFilter, options, query]);
  const selectedPreview = useMemo(
    () => selectedItemsPreview(options, selectedIds, showAllSelected ? selectedIds.length : 5),
    [options, selectedIds, showAllSelected],
  );
  const customQuery = query.trim();
  const canUseCustomValue = canUseCustomItemCode(options, query, allowCustomValue, multiple);
  const entityCount = (count: number) => `${count} ${entityCounter}${entityNoun}`;

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setSizeFilter("");
    setShowAllSelected(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  function handlePopoverKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!shouldDismissItemPicker(event.key, disabled)) return;
    event.preventDefault();
    close(true);
  }

  useEffect(() => {
    if (!open) return;
    function closeWhenOutside(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    }
    document.addEventListener("pointerdown", closeWhenOutside);
    return () => document.removeEventListener("pointerdown", closeWhenOutside);
  }, [close, open]);

  const triggerText = multiple
    ? selectedIds.length ? `已選 ${entityCount(selectedIds.length)}` : `請選擇${entityNoun}`
    : selectedOptions[0] ? optionLabel(selectedOptions[0]) : (typeof value === "string" && value ? value : `請選擇${entityNoun}`);

  return <div className="searchable-item-picker" ref={rootRef}>
    <button ref={triggerRef} className="searchable-item-picker-trigger" type="button" aria-label={label} aria-haspopup="dialog" aria-controls={listId} aria-expanded={open} disabled={disabled} onClick={() => setOpen((current) => !current)}>
      <span>{triggerText}</span><span aria-hidden="true">{open ? "▴" : "▾"}</span>
    </button>
    {open ? <div className="searchable-item-picker-popover" id={listId} role="dialog" aria-label={`${label}選擇器`} aria-busy={disabled} onKeyDown={handlePopoverKeyDown}>
      <div className="searchable-item-picker-controls">
        <label className="searchable-item-picker-search"><span className="sr-only">{label}搜尋</span><input type="search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} disabled={disabled} placeholder={placeholder} /></label>
        {sizeOptions.length > 1 ? <label className="searchable-item-picker-size-filter"><span>尺寸篩選</span><select aria-label={`${label}尺寸篩選`} value={activeSizeFilter} onChange={(event) => setSizeFilter(event.target.value)} disabled={disabled}><option value="">全部尺寸</option>{sizeOptions.map((size) => <option key={size} value={size}>{size}</option>)}</select></label> : null}
      </div>
      {multiple && selectedIds.length ? <div className="searchable-item-picker-selected" role="group" aria-label={`${label}已選${entityNoun}`}>
        <div className="searchable-item-picker-selected-heading">
          <strong>已選 {entityCount(selectedPreview.totalCount)}</strong>
          {selectedPreview.hiddenCount > 0
            ? <button className="text-button" type="button" onClick={() => setShowAllSelected(true)} disabled={disabled}>查看另外 {entityCount(selectedPreview.hiddenCount)}</button>
            : showAllSelected && selectedPreview.totalCount > 5
              ? <button className="text-button" type="button" onClick={() => setShowAllSelected(false)} disabled={disabled}>收起清單</button>
              : null}
        </div>
        <div className="searchable-item-picker-selected-list">
          {selectedPreview.items.map((item) => <span className="searchable-item-picker-chip" key={item.id}>
            <span>{item.label}</span>
            <button type="button" aria-label={`移除 ${item.label}`} onClick={() => onChange(toggleItemSelection(selectedIds, item.id))} disabled={disabled}>×</button>
          </span>)}
        </div>
      </div> : null}
      <div className="searchable-item-picker-options" id={`${listId}-options`} role={multiple ? "group" : "listbox"} aria-label={entityNoun}>
        {visibleOptions.map((option) => {
          const selected = selectedIds.includes(option.id);
          if (multiple) return <label className="searchable-item-picker-option searchable-item-picker-option--multiple" key={option.id}>
            <input type="checkbox" checked={selected} onChange={() => onChange(toggleItemSelection(selectedIds, option.id))} disabled={disabled} />
            <span>{optionLabel(option)}</span>
          </label>;
          return <button className="searchable-item-picker-option" type="button" role="option" aria-selected={selected} key={option.id} onClick={() => { onChange(option.id); close(true); }} disabled={disabled}>
            <span>{optionLabel(option)}</span>{selected ? <span aria-hidden="true">✓</span> : null}
          </button>;
        })}
        {!visibleOptions.length ? <p className="searchable-item-picker-empty" role="status">{emptyMessage}</p> : null}
      </div>
      <div className="searchable-item-picker-footer">
        <span>{visibleOptions.length === 100 ? "最多顯示 100 筆，請增加搜尋條件。" : `符合 ${entityCount(visibleOptions.length)}`}</span>
        {canUseCustomValue ? <button className="text-button" type="button" onClick={() => { onChange(customQuery); close(true); }} disabled={disabled}>{customValueActionLabel}「{customQuery}」</button> : null}
        {multiple ? <button className="text-button" type="button" onClick={() => onChange(selectVisibleItemOptions(selectedIds, visibleOptions.map((option) => option.id)))} disabled={disabled || !visibleOptions.length || visibleOptions.every((option) => selectedIds.includes(option.id))}>選取目前顯示 {entityCount(visibleOptions.length)}</button> : null}
        {multiple ? <button className="text-button" type="button" onClick={() => onChange(clearItemPickerSelection(true))} disabled={disabled || !selectedIds.length}>清除已選</button> : null}
        {!multiple && selectedIds.length ? <button className="text-button" type="button" onClick={() => { onChange(clearItemPickerSelection(false)); close(true); }} disabled={disabled}>清除選取</button> : null}
        <button className="text-button" type="button" onClick={() => close(true)} disabled={disabled}>關閉</button>
      </div>
    </div> : null}
  </div>;
}
