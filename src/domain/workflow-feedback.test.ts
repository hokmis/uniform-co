import { describe, expect, it } from "vitest";
import { isConfirmedInventoryFeedback } from "./workflow-feedback";

describe("inventory workflow feedback", () => {
  it("does not call a saved draft a completed inventory operation", () => {
    expect(isConfirmedInventoryFeedback({
      status: "DRAFT",
      message: "已建立盤點草稿；確認後送出。",
      completedPrefix: "盤點已完成",
    })).toBe(false);
    expect(isConfirmedInventoryFeedback({
      status: "DRAFT",
      message: "退回草稿已保存，但送出尚未完成。",
      completedPrefix: "退回已完成",
    })).toBe(false);
  });

  it("shows completion only for a posted operation or a confirmed next-item message", () => {
    expect(isConfirmedInventoryFeedback({
      status: "POSTED",
      message: "退回已完成；人資倉已增加退回數量。",
      completedPrefix: "退回已完成",
    })).toBe(true);
    expect(isConfirmedInventoryFeedback({
      status: null,
      message: "本筆入庫已完成，可以選擇下一筆。",
      completedPrefix: "入庫已完成",
      nextItemPrefix: "本筆入庫已完成",
    })).toBe(true);
    expect(isConfirmedInventoryFeedback({
      status: "POSTED",
      message: "入庫草稿已更新；完成分類後即可送出。",
      completedPrefix: "入庫已完成",
    })).toBe(false);
  });
});
