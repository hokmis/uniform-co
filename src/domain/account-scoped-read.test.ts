import { describe, expect, it } from "vitest";
import {
  beginAccountScopedRead,
  completeAccountScopedRead,
  createInitialAccountScopedRead,
  hasCurrentAccountScopedReadMessage,
  type AccountScopedReadOutcome,
} from "./account-scoped-read";

type Row = { id: string };

const emptyRows: Row[] = [];

function readyState(rows: Row[] = [{ id: "row-a" }]) {
  const initial = createInitialAccountScopedRead(emptyRows, "登入後載入資料");
  const success: AccountScopedReadOutcome<Row[]> = {
    status: "success",
    data: rows,
    message: `已載入 ${rows.length} 筆`,
  };
  return completeAccountScopedRead(initial, "account-a", success, emptyRows, "清單");
}

describe("account-scoped read snapshot", () => {
  it("keeps a same-account snapshot visible while a background refresh runs", () => {
    const state = beginAccountScopedRead(readyState());

    expect(state).toMatchObject({
      data: [{ id: "row-a" }],
      accountId: "account-a",
      loading: true,
      message: "已載入 1 筆",
    });
  });

  it("binds fresh results to the account that requested them", () => {
    const initial = createInitialAccountScopedRead(emptyRows, "登入後載入資料");
    const result: AccountScopedReadOutcome<Row[]> = {
      status: "success",
      data: [{ id: "private-a" }],
      message: "已載入",
    };

    expect(completeAccountScopedRead(initial, "account-a", result, emptyRows, "清單")).toMatchObject({
      data: [{ id: "private-a" }],
      accountId: "account-a",
      loading: false,
    });
  });

  it("preserves non-empty data only for a same-account transient session-sync failure", () => {
    const state = readyState();
    const result: AccountScopedReadOutcome<Row[]> = {
      status: "failure",
      errors: [{ code: "PGRST301", message: "expired session" }],
      message: "資料暫時無法更新",
    };

    expect(completeAccountScopedRead(state, "account-a", result, emptyRows, "商品清單")).toEqual({
      data: [{ id: "row-a" }],
      accountId: "account-a",
      loading: false,
      message: "商品清單暫時無法更新，仍顯示上次已載入資料；請稍後重新整理。",
    });
  });

  it("never carries a previous account snapshot into a new account", () => {
    const result: AccountScopedReadOutcome<Row[]> = {
      status: "failure",
      errors: [{ code: "PGRST301" }],
      message: "新帳號資料尚未載入",
    };

    expect(completeAccountScopedRead(readyState(), "account-b", result, emptyRows, "員工清單")).toEqual({
      data: [],
      accountId: null,
      loading: false,
      message: "新帳號資料尚未載入",
    });
  });

  it("clears snapshots after permission, schema, or unclassified network failures", () => {
    const permissionFailure: AccountScopedReadOutcome<Row[]> = {
      status: "failure",
      errors: [{ code: "42501" }],
      message: "目前帳號無法讀取清單",
    };
    const thrownFailure: AccountScopedReadOutcome<Row[]> = {
      status: "failure",
      errors: [],
      message: "清單讀取暫時失敗",
    };

    expect(completeAccountScopedRead(readyState(), "account-a", permissionFailure, emptyRows, "清單")).toMatchObject({
      data: [],
      accountId: null,
      loading: false,
      message: "目前帳號無法讀取清單",
    });
    expect(completeAccountScopedRead(readyState(), "account-a", thrownFailure, emptyRows, "清單")).toMatchObject({
      data: [],
      accountId: null,
      loading: false,
      message: "清單讀取暫時失敗",
    });
  });

  it("does not preserve an empty snapshot as if it were authoritative data", () => {
    const emptyState = readyState([]);
    const result: AccountScopedReadOutcome<Row[]> = {
      status: "failure",
      errors: [{ code: "PGRST301" }],
      message: "登入狀態暫時不同步",
    };

    expect(completeAccountScopedRead(emptyState, "account-a", result, emptyRows, "清單")).toMatchObject({
      data: [],
      accountId: null,
      loading: false,
      message: "登入狀態暫時不同步",
    });
  });

  it("hides the previous account's read message until the new account finishes loading", () => {
    expect(hasCurrentAccountScopedReadMessage(true, "account-a", "account-b", null, "request-b")).toBe(false);
    expect(hasCurrentAccountScopedReadMessage(true, "account-a", "account-a", null, "request-a")).toBe(true);
  });

  it("shows a current request failure even though it has no data snapshot", () => {
    expect(hasCurrentAccountScopedReadMessage(true, null, "account-a", "request-a", "request-a")).toBe(true);
    expect(hasCurrentAccountScopedReadMessage(true, null, "account-a", "request-a", "request-b")).toBe(false);
    expect(hasCurrentAccountScopedReadMessage(false, "account-a", "account-a", "request-a", "request-a")).toBe(false);
  });
});
