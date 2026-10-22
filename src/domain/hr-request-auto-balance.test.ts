import { describe, expect, it } from "vitest";
import { autoBalanceIssueAndIncreaseLines } from "./hr-request-auto-balance";
import type { UniformItemSnapshot } from "./hr-request";

const testItem1: UniformItemSnapshot = {
  itemId: "item-1",
  itemCode: "UADCS02L",
  itemName: "廚師冬季上衣L",
  unit: "件",
  hrOnHand: 1,
  generalOnHand: 5,
  activeReserved: 0,
};

const testItem2: UniformItemSnapshot = {
  itemId: "item-2",
  itemCode: "UADCS01S",
  itemName: "廚師夏季上衣S",
  unit: "件",
  hrOnHand: 10,
  generalOnHand: 20,
  activeReserved: 0,
};

describe("autoBalanceIssueAndIncreaseLines", () => {
  it("keeps lines unchanged when hrOnHand is sufficient", () => {
    const lines = [
      { employeeId: "emp-1", itemId: "item-2", quantity: 5, departmentCode: "DEPT-A" },
    ];
    const increases = { "item-2": 2 };
    const result = autoBalanceIssueAndIncreaseLines(lines, increases, [testItem2]);

    expect(result.adjustedIssueLines).toEqual([
      { employeeId: "emp-1", itemId: "item-2", quantity: 5, departmentCode: "DEPT-A" },
    ]);
    expect(result.adjustedIncreases).toEqual({ "item-2": 2 });
    expect(result.autoAdjustedItems).toEqual({});
  });

  it("automatically converts excess quantity to increase when hrOnHand is partially insufficient", () => {
    // 需求 2 件，人資倉僅剩 1 件
    const lines = [
      { employeeId: "emp-1", itemId: "item-1", quantity: 2, departmentCode: "DEPT-A" },
    ];
    const increases = { "item-1": 0 };
    const result = autoBalanceIssueAndIncreaseLines(lines, increases, [testItem1]);

    // 發放量調整為 1 件（等於人資倉現貨）
    expect(result.adjustedIssueLines).toEqual([
      { employeeId: "emp-1", itemId: "item-1", quantity: 1, departmentCode: "DEPT-A" },
    ]);
    // 增庫量增加 1 件
    expect(result.adjustedIncreases).toEqual({ "item-1": 1 });
    expect(result.autoAdjustedItems).toEqual({ "item-1": 1 });
  });

  it("automatically converts all quantity to increase when hrOnHand is 0", () => {
    const zeroHrItem: UniformItemSnapshot = { ...testItem1, hrOnHand: 0 };
    const lines = [
      { employeeId: "emp-1", itemId: "item-1", quantity: 3, departmentCode: "DEPT-A" },
    ];
    const increases = { "item-1": 0 };
    const result = autoBalanceIssueAndIncreaseLines(lines, increases, [zeroHrItem]);

    // 發放量全數轉增庫，發放明細過濾為空
    expect(result.adjustedIssueLines).toEqual([]);
    expect(result.adjustedIncreases).toEqual({ "item-1": 3 });
    expect(result.autoAdjustedItems).toEqual({ "item-1": 3 });
  });

  it("allocates hrOnHand sequentially across multiple department lines", () => {
    // 單位 A 申請 2 件，單位 B 申請 2 件，人資倉剩 3 件
    const lines = [
      { employeeId: "emp-1", itemId: "item-1", quantity: 2, departmentCode: "DEPT-A" },
      { employeeId: "emp-2", itemId: "item-1", quantity: 2, departmentCode: "DEPT-B" },
    ];
    const itemWith3Hr: UniformItemSnapshot = { ...testItem1, hrOnHand: 3 };
    const result = autoBalanceIssueAndIncreaseLines(lines, {}, [itemWith3Hr]);

    // 單位 A 分配 2 件，單位 B 分配 1 件，合計發放 3 件（等於人資倉現有量）
    expect(result.adjustedIssueLines).toEqual([
      { employeeId: "emp-1", itemId: "item-1", quantity: 2, departmentCode: "DEPT-A" },
      { employeeId: "emp-2", itemId: "item-1", quantity: 1, departmentCode: "DEPT-B" },
    ]);
    // 單位 B 不足的 1 件轉為增庫
    expect(result.adjustedIncreases).toEqual({ "item-1": 1 });
    expect(result.autoAdjustedItems).toEqual({ "item-1": 1 });
  });
});
