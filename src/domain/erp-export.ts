export type ErpSourceLine = {
  sourceId: string;
  distributionDate: string;
  institutionId: string;
  institutionCode: string;
  institutionName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  quantity: number;
};

export type ErpBatchLine = {
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  quantity: number;
  sourceIds: string[];
};

export class ErpExportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErpExportValidationError";
  }
}

export function groupErpSourceLines(
  sourceLines: ErpSourceLine[],
  distributionDate: string,
  institutionId: string,
): ErpBatchLine[] {
  if (sourceLines.length === 0) {
    throw new ErpExportValidationError("ERP export needs at least one source issue line");
  }
  const selected = sourceLines.filter(
    (line) => line.distributionDate === distributionDate && line.institutionId === institutionId,
  );
  if (selected.length !== sourceLines.length || selected.some((line) => !Number.isInteger(line.quantity) || line.quantity <= 0)) {
    throw new ErpExportValidationError("ERP sources must be positive shipped issue lines from one date and institution");
  }
  const grouped = new Map<string, ErpBatchLine>();
  for (const line of selected) {
    const existing = grouped.get(line.itemId);
    if (existing) {
      existing.quantity += line.quantity;
      existing.sourceIds.push(line.sourceId);
    } else {
      grouped.set(line.itemId, {
        itemId: line.itemId,
        itemCode: line.itemCode,
        itemName: line.itemName,
        unit: line.unit,
        quantity: line.quantity,
        sourceIds: [line.sourceId],
      });
    }
  }
  return [...grouped.values()].sort((left, right) => left.itemCode.localeCompare(right.itemCode));
}

export function renderUniformErpCsv(lines: ErpBatchLine[], formatVersion: string): string {
  if (formatVersion !== "UNIFORM-ERP-SALES-v0") {
    throw new ErpExportValidationError("Dingxin format version is not configured; provide a validated sample first");
  }
  const escape = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  return [
    "item_code,item_name,unit,quantity",
    ...lines.map((line) => [line.itemCode, line.itemName, line.unit, String(line.quantity)].map(escape).join(",")),
  ].join("\n");
}
