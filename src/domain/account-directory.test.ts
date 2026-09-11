import { describe, expect, it } from "vitest";
import { filterAccountDirectory, sortAccountDirectory, type AccountDirectoryRecord } from "./account-directory";

const accounts: AccountDirectoryRecord[] = [
  { id: "1", loginName: "hr02", displayName: "人資乙", email: "hr02@example.test", isActive: true, authBound: true, roles: ["HR"] },
  { id: "2", loginName: "warehouse01", displayName: "倉庫甲", email: "", isActive: false, authBound: false, roles: ["WAREHOUSE"] },
];

describe("account directory", () => {
  it("filters account identity, role and status without mutating source rows", () => {
    expect(filterAccountDirectory(accounts, "WAREHOUSE", "INACTIVE").map((row) => row.id)).toEqual(["2"]);
    expect(filterAccountDirectory(accounts, "", "ACTIVE").map((row) => row.id)).toEqual(["1"]);
    expect(accounts).toHaveLength(2);
  });

  it("sorts display values without mutating source rows", () => {
    expect(sortAccountDirectory(accounts, "login_name", "asc").map((row) => row.loginName)).toEqual(["hr02", "warehouse01"]);
    expect(sortAccountDirectory(accounts, "status", "asc").map((row) => row.id)).toEqual(["2", "1"]);
    expect(accounts[0].loginName).toBe("hr02");
  });
});
