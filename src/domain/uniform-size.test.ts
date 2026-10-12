import { describe, expect, it } from "vitest";
import {
  STANDARD_UNIFORM_SIZES,
  extractUniformSize,
  getUniformSizeRank,
  compareUniformItems,
} from "./uniform-size";

describe("uniform-size module", () => {
  it("defines standard uniform sizes in exact requested order: XS, S, M, L, XL, 2L, 3L, 4L, 5L, 6L", () => {
    expect(STANDARD_UNIFORM_SIZES).toEqual([
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "2L",
      "3L",
      "4L",
      "5L",
      "6L",
    ]);
  });

  it("extracts uniform sizes correctly from size or itemName", () => {
    expect(extractUniformSize("XS")).toBe("XS");
    expect(extractUniformSize("女M")).toBe("M");
    expect(extractUniformSize("男2L")).toBe("2L");
    expect(extractUniformSize("-XL")).toBe("XL");
    expect(extractUniformSize("", "行政冬季上衣-女2L")).toBe("2L");
    expect(extractUniformSize(undefined, "工務冬季上衣-3L")).toBe("3L");
  });

  it("assigns strictly ascending rank for XS < S < M < L < XL < 2L < 3L < 4L < 5L < 6L", () => {
    const ranks = STANDARD_UNIFORM_SIZES.map((sz) => getUniformSizeRank(sz));
    for (let i = 0; i < ranks.length - 1; i++) {
      expect(ranks[i]).toBeLessThan(ranks[i + 1]);
    }
  });

  it("sorts items by size when base item is identical", () => {
    const items = [
      { itemCode: "U-06", itemName: "照服夏季短袖-4L", size: "4L" },
      { itemCode: "U-02", itemName: "照服夏季短袖-S", size: "S" },
      { itemCode: "U-08", itemName: "照服夏季短袖-6L", size: "6L" },
      { itemCode: "U-01", itemName: "照服夏季短袖-XS", size: "XS" },
      { itemCode: "U-05", itemName: "照服夏季短袖-2L", size: "2L" },
      { itemCode: "U-04", itemName: "照服夏季短袖-XL", size: "XL" },
      { itemCode: "U-03", itemName: "照服夏季短袖-M", size: "M" },
      { itemCode: "U-07", itemName: "照服夏季短袖-5L", size: "5L" },
      { itemCode: "U-035", itemName: "照服夏季短袖-L", size: "L" },
      { itemCode: "U-055", itemName: "照服夏季短袖-3L", size: "3L" },
    ];

    const sorted = [...items].sort(compareUniformItems);
    expect(sorted.map((item) => item.size)).toEqual([
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "2L",
      "3L",
      "4L",
      "5L",
      "6L",
    ]);
  });
});
