type WarehouseTransferCorrectionPickerSource = {
  kind: "SHIPMENT" | "REPLENISHMENT";
  lineId: string;
  parentNo: string;
  itemCode: string;
  itemName: string;
  actual: number;
  requested: number;
};

type StocktakeCorrectionPickerSource = {
  lineId: string;
  stocktakeNo: string;
  itemCode: string;
  itemName: string;
  book: number;
  counted: number;
};

export function warehouseTransferCorrectionPickerOptions<T extends WarehouseTransferCorrectionPickerSource>(sources: readonly T[]) {
  return sources.map((source) => ({
    id: `${source.kind}:${source.lineId}`,
    code: source.itemCode,
    name: source.itemName,
    detail: `${source.kind === "SHIPMENT" ? "發貨" : "補庫"} ${source.parentNo}｜原調撥 ${source.actual}／上限 ${source.requested}`,
  }));
}

export function stocktakeCorrectionPickerOptions<T extends StocktakeCorrectionPickerSource>(sources: readonly T[]) {
  return sources.map((source) => ({
    id: source.lineId,
    code: source.itemCode,
    name: source.itemName,
    detail: `盤點 ${source.stocktakeNo}｜帳面 ${source.book}／實盤 ${source.counted}`,
  }));
}

export function canSubmitCorrection(
  correction: { status: "DRAFT" | "POSTED" } | null,
  hasSelectedSource: boolean,
  hasCorrectionNo: boolean,
  hasValidInput: boolean,
) {
  if (correction) return correction.status === "DRAFT";
  return hasSelectedSource && hasCorrectionNo && hasValidInput;
}
