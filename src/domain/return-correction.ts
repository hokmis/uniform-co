export type ReturnCorrectionInput = {
  returnQuantityDelta: number;
  reason: string;
};

export function validateReturnCorrectionInput(input: ReturnCorrectionInput): string | null {
  if (!Number.isSafeInteger(input.returnQuantityDelta)) return "退回更正量必須是安全範圍內的整數";
  if (input.returnQuantityDelta === 0) return "退回更正量不可為 0";
  if (input.reason.trim() === "") return "更正原因不可空白";
  return null;
}
