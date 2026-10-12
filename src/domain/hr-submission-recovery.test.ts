import {describe,expect,it} from "vitest";
import {parsePendingHrRequestSubmission} from "./hr-request-submission";
const uuid="c18b3cc5-752c-40b1-894b-890d4ccafc70";
const input={requestId:null,requestNo:"HR-1",distributionDate:"2026-10-11",note:"",issueLines:[{employeeId:uuid,itemId:uuid,quantity:2}],increaseLines:[],createIdempotencyKey:"CREATE-1",createRequestFingerprint:"one",updateIdempotencyKey:"UPDATE-1",updateRequestFingerprint:"two",submitIdempotencyKey:"SUBMIT-1"};
describe("HR submit reload recovery",()=>{
  it("retains the complete submitted body and keys",()=>expect(parsePendingHrRequestSubmission(JSON.parse(JSON.stringify(input)))).toEqual(input));
  it.each([{...input,requestId:"foreign"},{...input,issueLines:[]},{...input,issueLines:[{employeeId:uuid,itemId:uuid,quantity:0}]},{...input,submitIdempotencyKey:""}])("rejects invalid recovery without creating another request",value=>expect(parsePendingHrRequestSubmission(value)).toBeNull());
});
