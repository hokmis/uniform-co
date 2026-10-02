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
  it("deducts HR warehouse directly for issues and requests transfer to replenish and increase", () => {
    // item: hrOnHand: 10, generalOnHand: 5, issueQuantity: 10, increaseQuantity: 5
    // 階段一：人事單位申請領用 10 件，人事倉即時扣庫 10 件；月底調庫需求為 10 件（補回）+ 5 件（增庫）= 15 件
    const result = summarizeHrRequest([line(10)], [{ item, quantity: 5 }]);

    expect(result.summaries).toEqual([
      expect.objectContaining({
        issueQuantity: 10,
        increaseQuantity: 5,
        hrDeduction: 10,
        transferFromGeneral: 10,
        requestedTransferQuantity: 15,
        combinedOnHand: 15,
        availableToRequest: 15,
      }),
    ]);
    expect(result.totalHrDeduction).toBe(10);
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

  it("requests transfer from GENERAL for monthly replenishment of employee issues (Mode B)", () => {
    // item: hrOnHand: 10, generalOnHand: 5, 發放 12 件（允許預支方式 B）
    // 階段一：人事單位申請領用 12 件，人事倉即時扣庫 12 件；月底調庫補回 12 件
    const result = summarizeHrRequest([line(12)], []);
    expect(result.summaries[0]).toMatchObject({
      issueQuantity: 12,
      increaseQuantity: 0,
      hrDeduction: 12,
      transferFromGeneral: 12,
      requestedTransferQuantity: 12,
    });
  });

  it("rejects a quantity that exceeds this item's two-warehouse availability", () => {
    expect(() => summarizeHrRequest([line(15)], [{ item, quantity: 1 }])).toThrow(
      "超過可申請量",
    );
  });

  it("allows duplicate employee and item lines, setting requested transfer for replenishment", () => {
    // 2 + 3 = 5 件，人事倉庫即時扣庫 5 件，調庫補回量為 5 件
    const result = summarizeHrRequest([line(2), line(3, "line-2")], []);
    expect(result.summaries[0]).toMatchObject({
      issueQuantity: 5,
      hrDeduction: 5,
      requestedTransferQuantity: 5,
    });
  });
});
