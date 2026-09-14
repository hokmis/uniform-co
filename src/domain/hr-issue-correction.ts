export function validateHrIssueCorrectionInput(input: {
  issueQuantityDelta: number;
  reason: string;
}): string | null {
  if (!Number.isSafeInteger(input.issueQuantityDelta) || input.issueQuantityDelta === 0) {
    return "發放更正差額必須是非零整數。";
  }
  if (input.reason.trim().length === 0) return "請填寫更正原因。";
  if (input.reason.trim().length > 500) return "更正原因不可超過 500 字。";
  return null;
}
