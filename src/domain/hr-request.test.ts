import { describe, expect, it } from "vitest";
import {
  HrRequestValidationError,
  summarizeHrRequest,
  type EmployeeSnapshot,
  type IssueLineDraft,
  type UniformItemSnapshot,
} from "./hr-request";

const employee: EmployeeSnapshot = {
  employeeId: "employee-1",
  employeeNo: "E001",
  employeeName: "測試員工",
  institutionCode: "ABC",
  institutionName: "ABC 機構",
  departmentCode: "A",
  departmentName: "A 部門",
};

const item: UniformItemSnapshot = {
  itemId: "item-m",
  itemCode: "U-M",
  itemName: "測試上衣",
  size: "M",
  unit: "件",
  hrOnHand: 10,
  generalOnHand: 5,
  activeReserved: 0,
};

function line(quantity: number, lineId = "line-1"): IssueLineDraft {
  return { lineId, employee, item, quantity };
}

describe("HR request line aggregation", () => {
  it("requests transfer from GENERAL warehouse for issues and increases", () => {
    // item: hrOnHand: 10, generalOnHand: 5, issueQuantity: 10, increaseQuantity: 5
    // 標準調撥模式：發放 10 件 + 增庫 5 件 -> 總倉調庫 15 件
    const result = summarizeHrRequest([line(10)], [{ item, quantity: 5 }]);

    expect(result.summaries).toEqual([
      expect.objectContaining({
        issueQuantity: 10,
        increaseQuantity: 5,
        hrDeduction: 0,
        transferFromGeneral: 10,
        requestedTransferQuantity: 15,
        combinedOnHand: 15,
        availableToRequest: 15,
      }),
    ]);
    expect(result.totalRequestedTransferQuantity).toBe(15);
  });

  it("supports an increase-only item without an employee issue line", () => {
    const increaseOnlyItem = { ...item, itemId: "item-l", itemCode: "U-L" };
    const result = summarizeHrRequest([], [{ item: increaseOnlyItem, quantity: 3 }]);

    expect(result.summaries[0]).toMatchObject({
      issueQuantity: 0,
      increaseQuantity: 3,
      hrDeduction: 0,
      requestedTransferQuantity: 3,
    });
  });

  it("requests transfer from GENERAL for employee issues", () => {
    // item: hrOnHand: 10, generalOnHand: 5, 發放 12 件 -> 調庫 12 件
    const result = summarizeHrRequest([line(12)], []);
    expect(result.summaries[0]).toMatchObject({
      issueQuantity: 12,
      increaseQuantity: 0,
      hrDeduction: 0,
      transferFromGeneral: 12,
      requestedTransferQuantity: 12,
    });
  });

  it("rejects a quantity that exceeds this item's two-warehouse availability", () => {
    expect(() => summarizeHrRequest([line(15)], [{ item, quantity: 1 }])).toThrow(
      "超過可申請量",
    );
  });

  it("allows duplicate employee and item lines, aggregating them into transfer quantity", () => {
    // 2 + 3 = 5 件，調庫量為 5
    const result = summarizeHrRequest([line(2), line(3, "line-2")], []);
    expect(result.summaries[0]).toMatchObject({
      issueQuantity: 5,
      requestedTransferQuantity: 5,
    });
  });
});
