import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { workspaceDefinitions, searchWorkspaceModules } from "../app/workspaces/workspace-config";

describe("inventory adjustment navigation", () => {
  it("places the independent operation immediately after stocktake and corrections", () => {
    const modules = workspaceDefinitions.find((workspace) => workspace.id === "warehouse")!.modules;
    const index = modules.findIndex((module) => module.anchor === "warehouse-stocktake-title");
    expect(modules[index + 1]).toMatchObject({ anchor: "warehouse-adjustment-title", label: "庫存調整作業" });
    expect(searchWorkspaceModules("庫存調整").map((module) => module.anchor)).toEqual(["warehouse-adjustment-title"]);
  });
  it("retains lazy loading and renders the operation as its own module instead of a stocktake tab", () => {
    const source = readFileSync("src/app/workspaces/WarehouseWorkspace.tsx", "utf8");
    expect(source).toContain('id: "warehouse-adjustment-title", content: <InventoryAdjustmentPanel />');
    expect(source).not.toContain('id: "adjustment"');
    expect(readFileSync("src/app/InventoryAdjustmentPanel.tsx", "utf8")).toContain('id="warehouse-adjustment-title">庫存調整作業');
  });
});
