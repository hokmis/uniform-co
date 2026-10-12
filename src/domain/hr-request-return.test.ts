import { describe,expect,it } from "vitest";
import { parsePendingHrRequestReturn,hrReturnFailureMessage } from "./hr-request-return";
const pending={requestId:"c18b3cc5-752c-40b1-894b-890d4ccafc70",requestNo:"HR-1",version:4,reason:"修改員工數量",key:"RETURN-1"};
describe("warehouse return recovery",()=>{
  it("restores the exact version, reason and retry key",()=>expect(parsePendingHrRequestReturn(JSON.parse(JSON.stringify(pending)))).toEqual(pending));
  it.each([{...pending,version:-1},{...pending,reason:""},{...pending,requestId:"-".repeat(36)},{...pending,key:""},{...pending,version:1.5}])("rejects malformed recovery",value=>expect(parsePendingHrRequestReturn(value)).toBeNull());
  it("classifies stale source safely while unknown errors remain retryable",()=>{
    expect(hrReturnFailureMessage({message:"HR_RETURN_SOURCE_STALE"})).toContain("重新載入");
    expect(hrReturnFailureMessage({message:"secret raw error"})).toBeNull();
    expect(hrReturnFailureMessage({code:"42501",message:"sensitive database error"})).toBe("目前帳號沒有退回此單據的權限。");
  });
});
