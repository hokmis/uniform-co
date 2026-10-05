import { calculateRequestSummary, calculateWarehousePost, InventoryRuleError, type WarehousePostInput } from "./inventory";

function previewError(error: unknown): string {
  if (!(error instanceof InventoryRuleError)) return "輸入資料無法試算，請檢查數量。";
  const messages: Record<string, string> = {
    "active_reserved exceeds combined_on_hand": "其他有效預留超過兩倉合計庫存，請檢查數量。",
    "requested quantity exceeds available_to_request": "發放量與增庫量合計超過可申請量，請調整需求。",
    "actual_transfer exceeds maximum_transfer": "實際調庫量超過最大可調量，請調整數量。",
    "human_resources_warehouse would become negative": "完成後人資倉庫存不足，請增加調庫量或減少發放量。",
    "short_ship_reason is required": "實際調庫量低於最大可調量，請填寫短發原因。",
  };
  return messages[error.message] ?? "數量必須是零或正整數，請檢查輸入。";
}

export function calculateInventoryPreview(input: WarehousePostInput, shortShipReason: string) {
  const { hrOnHand, generalOnHand, activeReserved, issueQuantity, increaseQuantity, actualTransfer } = input;
  const requestInput = { hrOnHand, generalOnHand, activeReserved, issueQuantity, increaseQuantity };
  let request;
  try {
    request = calculateRequestSummary(requestInput);
  } catch (error) {
    return { request: null, post: null, requestError: previewError(error), postError: "" };
  }
  try {
    return { request, post: calculateWarehousePost({ ...requestInput, actualTransfer, shortShipReason }), requestError: "", postError: "" };
  } catch (error) {
    return { request, post: null, requestError: "", postError: previewError(error) };
  }
}
