import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertSafeSystemGuideMarkdown, parseSystemGuideMarkdown } from "./system-guide";

describe("System Guide Markdown", () => {
  it("parses the supported document blocks without rendering HTML", () => {
    const blocks = parseSystemGuideMarkdown(`<!-- generated note -->
# 說明中心

第一行
第二行

- 項目一
- 項目二

1. 第一步
2. 第二步

| 欄位 | 說明 |
| --- | --- |
| role | SYSTEM_ADMIN |

\`\`\`sql
select current_user;
\`\`\`
`);

    expect(blocks).toEqual([
      { type: "heading", level: 1, text: "說明中心" },
      { type: "paragraph", text: "第一行 第二行" },
      { type: "list", ordered: false, items: ["項目一", "項目二"] },
      { type: "list", ordered: true, items: ["第一步", "第二步"] },
      { type: "table", headers: ["欄位", "說明"], rows: [["role", "SYSTEM_ADMIN"]] },
      { type: "code", language: "sql", text: "select current_user;" },
    ]);
  });

  it.each([
    "<script>alert(1)</script>",
    "<img src=x onclick=alert(1)>",
    "[危險連結](javascript:alert(1))",
    "<iframe src=\"https://example.test\"></iframe>",
  ])("rejects unsafe markup: %s", (source) => {
    expect(() => assertSafeSystemGuideMarkdown(source)).toThrow(/unsafe HTML or JavaScript/);
  });

  it("rejects an unclosed code fence", () => {
    expect(() => parseSystemGuideMarkdown("```sql\nselect 1;")).toThrow(/unclosed code block/);
  });

  it("parses every versioned guide document from the repository", () => {
    for (const fileName of ["user-guide.md", "admin-guide.md", "agent-guide.md"]) {
      const source = readFileSync(new URL(`../../docs/system-guide/${fileName}`, import.meta.url), "utf8");
      const blocks = parseSystemGuideMarkdown(source);
      expect(blocks.length, fileName).toBeGreaterThan(10);
      expect(blocks[0], fileName).toMatchObject({ type: "heading", level: 1 });
    }
  });
});
