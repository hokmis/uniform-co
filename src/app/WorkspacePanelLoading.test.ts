import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WorkspacePanelLoading from "./WorkspacePanelLoading";

describe("workspace loading presentation", () => {
  it("announces the current module and keeps the visual placeholder decorative", () => {
    const markup = renderToStaticMarkup(createElement(WorkspacePanelLoading, { label: "正在載入倉庫作業" }));

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("正在載入倉庫作業，請稍候");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("workspace-loading-skeleton");
    expect(markup).not.toContain("其他未開啟模組");
  });
});
