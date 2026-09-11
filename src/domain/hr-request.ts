export type EmployeeSnapshot = {
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  institutionId?: string;
  institutionCode: string;
  institutionName: string;
  departmentId?: string;
  departmentCode: string;
  departmentName: string;
};

export type UniformItemSnapshot = {
  itemId: string;
  itemCode: string;
  itemName: string;
  size?: string;
  unit: string;
  hrOnHand: number;
  generalOnHand: number;
  activeReserved: number;
};

export type IssueLineDraft = {
  lineId: string;
  employee: EmployeeSnapshot;
  item: UniformItemSnapshot;
  quantity: number;
};

export type IncreaseDraft = {
  item: UniformItemSnapshot;
  quantity: number;
};

export type RequestItemSummary = {
  item: UniformItemSnapshot;
  issueQuantity: number;
  increaseQuantity: number;
  requestedTransferQuantity: number;
  combinedOnHand: number;
  availableToRequest: number;
};

export type HrRequestSummary = {
  summaries: RequestItemSummary[];
  totalIssueQuantity: number;
  totalIncreaseQuantity: number;
  totalRequestedTransferQuantity: number;
};

export class HrRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HrRequestValidationError";
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new HrRequestValidationError(`${name} must be a non-negative integer`);
  }
}

function assertRequired(name: string, value: string): void {
  if (!value.trim()) {
    throw new HrRequestValidationError(`${name} is required`);
  }
}

export function summarizeHrRequest(
  issueLines: IssueLineDraft[],
  increases: IncreaseDraft[],
): HrRequestSummary {
  const items = new Map<string, UniformItemSnapshot>();
  const issueByItem = new Map<string, number>();
  const seenEmployeeItems = new Set<string>();

  for (const line of issueLines) {
    assertRequired("employee_no", line.employee.employeeNo);
    assertRequired("employee_name", line.employee.employeeName);
    assertRequired("institution_code", line.employee.institutionCode);
    assertRequired("department_code", line.employee.departmentCode);
    assertRequired("item_code", line.item.itemCode);
    assertNonNegativeInteger("issue_quantity", line.quantity);
    if (line.quantity === 0) {
      throw new HrRequestValidationError("issue_quantity must be greater than zero");
    }

    const employeeItemKey = `${line.employee.employeeId}:${line.item.itemId}`;
    if (seenEmployeeItems.has(employeeItemKey)) {
      throw new HrRequestValidationError("同一員工與品號只能有一筆發放明細");
    }
    seenEmployeeItems.add(employeeItemKey);
    items.set(line.item.itemId, line.item);
    issueByItem.set(
      line.item.itemId,
      (issueByItem.get(line.item.itemId) ?? 0) + line.quantity,
    );
  }

  const increaseByItem = new Map<string, number>();
  for (const increase of increases) {
    assertNonNegativeInteger("increase_quantity", increase.quantity);
    if (increase.quantity === 0) {
      continue;
    }
    items.set(increase.item.itemId, increase.item);
    const existing = increaseByItem.get(increase.item.itemId) ?? 0;
    increaseByItem.set(increase.item.itemId, existing + increase.quantity);
  }

  const itemIds = new Set([...items.keys(), ...increaseByItem.keys()]);
  const summaries = [...itemIds].sort().map((itemId) => {
    const item = items.get(itemId);
    if (!item) {
      throw new HrRequestValidationError(`item ${itemId} is required`);
    }
    assertNonNegativeInteger("hr_on_hand", item.hrOnHand);
    assertNonNegativeInteger("general_on_hand", item.generalOnHand);
    assertNonNegativeInteger("active_reserved", item.activeReserved);

    const issueQuantity = issueByItem.get(itemId) ?? 0;
    const increaseQuantity = increaseByItem.get(itemId) ?? 0;
    const combinedOnHand = item.hrOnHand + item.generalOnHand;
    const availableToRequest = combinedOnHand - item.activeReserved;
    const requestedTransferQuantity = issueQuantity + increaseQuantity;

    if (item.activeReserved > combinedOnHand) {
      throw new HrRequestValidationError(`品號 ${item.itemCode} 的預留量超過兩倉合計`);
    }
    if (requestedTransferQuantity > availableToRequest) {
      throw new HrRequestValidationError(
        `品號 ${item.itemCode} 超過可申請量 ${availableToRequest}`,
      );
    }

    return {
      item,
      issueQuantity,
      increaseQuantity,
      requestedTransferQuantity,
      combinedOnHand,
      availableToRequest,
    };
  });

  if (summaries.every((summary) => summary.requestedTransferQuantity === 0)) {
    throw new HrRequestValidationError("需求單至少要有一筆發放或增庫數量");
  }

  return {
    summaries,
    totalIssueQuantity: summaries.reduce((total, row) => total + row.issueQuantity, 0),
    totalIncreaseQuantity: summaries.reduce((total, row) => total + row.increaseQuantity, 0),
    totalRequestedTransferQuantity: summaries.reduce(
      (total, row) => total + row.requestedTransferQuantity,
      0,
    ),
  };
}
