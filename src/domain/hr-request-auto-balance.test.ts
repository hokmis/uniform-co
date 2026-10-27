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

  it("does not auto-balance and preserves original issue lines when both warehouses have zero stock", () => {
    const zeroStockItem: UniformItemSnapshot = {
      ...testItem1,
      hrOnHand: 0,
      generalOnHand: 0,
      activeReserved: 0,
    };
    const lines = [
      { employeeId: "emp-1", itemId: "item-1", quantity: 58, departmentCode: "02" },
    ];
    const result = autoBalanceIssueAndIncreaseLines(lines, {}, [zeroStockItem]);

    // 發放明細維持原樣（不被轉為增庫，維持發放詞彙與數量）
    expect(result.adjustedIssueLines).toEqual([
      { employeeId: "emp-1", itemId: "item-1", quantity: 58, departmentCode: "02" },
    ]);
    expect(result.adjustedIncreases).toEqual({});
    expect(result.autoAdjustedItems).toEqual({});
  });

  it("does not auto-balance when combined inventory across both warehouses is insufficient", () => {
    // 人資倉 2 件，總倉 5 件，合計 7 件；但請領 50 件
    const limitedItem: UniformItemSnapshot = {
      ...testItem1,
      hrOnHand: 2,
      generalOnHand: 5,
      activeReserved: 0,
    };
    const lines = [
      { employeeId: "emp-1", itemId: "item-1", quantity: 50, departmentCode: "DEPT-A" },
    ];
    const result = autoBalanceIssueAndIncreaseLines(lines, {}, [limitedItem]);

    // 兩倉合計不足以滿足總量時，維持原發放明細，不轉增庫
    expect(result.adjustedIssueLines).toEqual([
      { employeeId: "emp-1", itemId: "item-1", quantity: 50, departmentCode: "DEPT-A" },
    ]);
    expect(result.adjustedIncreases).toEqual({});
    expect(result.autoAdjustedItems).toEqual({});
  });
});
