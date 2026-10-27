import type { UniformItemSnapshot } from "./hr-request";

export type AutoBalanceInputLine = {
  lineId?: string;
  employeeId: string;
  itemId: string;
  quantity: number;
  departmentCode?: string;
};

export type AutoBalancedRequestResult<T extends AutoBalanceInputLine> = {
  adjustedIssueLines: T[];
  adjustedIncreases: Record<string, number>;
  autoAdjustedItems: Record<string, number>;
};

/**
 * 智慧自動適配發放量與增庫量：
 * 當員工/單位填寫的請領總量超過「人資倉現有庫存（hrOnHand）」時，
 * 自動將超過人資倉現貨的部分轉移為該品項的「增庫量」（向總倉申請調撥），
 * 使發放總量不超過人資倉現貨，避免送出時觸發 HR_INSUFFICIENT_ISSUE_STOCK，
 * 並確保總申請量（發放 + 增庫）維持原數量不變。
 */
export function autoBalanceIssueAndIncreaseLines<T extends AutoBalanceInputLine>(
  lines: T[],
  increases: Record<string, number>,
  itemOptions: UniformItemSnapshot[],
): AutoBalancedRequestResult<T> {
  const resultIncreases: Record<string, number> = { ...increases };
  const autoAdjustedItems: Record<string, number> = {};

  // 1. 統計每個 item 的需求發放總量
  const issueByItem = new Map<string, number>();
  for (const line of lines) {
    if (line.quantity > 0) {
      issueByItem.set(line.itemId, (issueByItem.get(line.itemId) ?? 0) + line.quantity);
    }
  }

  // 2. 判斷各品項是否可進行智慧轉增庫
  const remainingHrQuota = new Map<string, number>();
  for (const [itemId, totalRequested] of issueByItem.entries()) {
    const item = itemOptions.find((opt) => opt.itemId === itemId);
    const hrOnHand = item ? Math.max(0, item.hrOnHand) : 0;
    const generalOnHand = item ? Math.max(0, item.generalOnHand) : 0;
    const activeReserved = item ? Math.max(0, item.activeReserved) : 0;
    const combinedAvailable = Math.max(0, hrOnHand + generalOnHand - activeReserved);
    const userIncrease = increases[itemId] ?? 0;

    // 只有在請領量超過人資倉現有量、總倉有現貨可供調撥，且兩倉合計足以支應總需求時，
    // 才將超額部分智慧轉為總倉增庫調撥
    const isSufficientInBoth = totalRequested + userIncrease <= combinedAvailable;
    const excess = totalRequested - hrOnHand;

    if (totalRequested > hrOnHand && generalOnHand > 0 && isSufficientInBoth) {
      autoAdjustedItems[itemId] = excess;
      resultIncreases[itemId] = (resultIncreases[itemId] ?? 0) + excess;
      remainingHrQuota.set(itemId, hrOnHand);
    } else {
      // 兩倉無庫存、總倉無現貨、或兩倉合計不足（超出可申請量）：
      // 維持原始發放明細與數量，不自動轉增庫，由送出前檢查標示超額
      remainingHrQuota.set(itemId, totalRequested);
    }
  }

  // 3. 調整發放明細，確保各品項發放量總和不超過 hrOnHand
  const adjustedIssueLines = lines
    .map((line) => {
      if (line.quantity <= 0) return { ...line };
      if (!autoAdjustedItems[line.itemId]) return { ...line };

      const quota = remainingHrQuota.get(line.itemId) ?? 0;
      const allocated = Math.min(line.quantity, quota);
      remainingHrQuota.set(line.itemId, quota - allocated);

      return {
        ...line,
        quantity: allocated,
      };
    })
    .filter((line) => line.quantity > 0);

  return {
    adjustedIssueLines,
    adjustedIncreases: resultIncreases,
    autoAdjustedItems,
  };
}
