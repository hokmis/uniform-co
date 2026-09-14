export type ReceiptCorrectionInput = {
  deliveredQuantityDelta: number;
  acceptedQuantityDelta: number;
  rejectedQuantityDelta: number;
  rejectionReason: string;
  reason: string;
};

export function validateReceiptCorrectionInput(input: ReceiptCorrectionInput): string | null {
  const deltas = [input.deliveredQuantityDelta, input.acceptedQuantityDelta, input.rejectedQuantityDelta];
  if (deltas.some((value) => !Number.isSafeInteger(value))) return "更正數量必須是安全範圍內的整數";
  if (deltas.every((value) => value === 0)) return "至少一個更正數量必須不為 0";
  if (input.rejectedQuantityDelta > 0 && input.rejectionReason.trim() === "") return "增加拒收量時必須填寫拒收理由";
  if (input.reason.trim() === "") return "更正原因不可空白";
  return null;
}
