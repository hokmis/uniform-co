export type SystemGuideBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language: string; text: string }
  | { type: "table"; headers: string[]; rows: string[][] };

export type SystemGuideDocumentId = "user" | "admin" | "agent";

export type SystemGuideDocument = {
  id: SystemGuideDocumentId;
  title: string;
  audience: string;
  blocks: SystemGuideBlock[];
};

export const systemGuideDocumentDefinitions: ReadonlyArray<{
  id: SystemGuideDocumentId;
  fileName: string;
  title: string;
  audience: string;
}> = [
  { id: "user", fileName: "user-guide.md", title: "使用者操作說明", audience: "日常作業與各業務角色" },
  { id: "admin", fileName: "admin-guide.md", title: "管理者設定說明", audience: "SYSTEM_ADMIN 與平台維運者" },
  { id: "agent", fileName: "agent-guide.md", title: "AI Agent 交接說明", audience: "開發、維護與 DevOps Agent" },
];

const MAX_SOURCE_LENGTH = 300_000;
const MAX_BLOCKS = 2_000;
const UNSAFE_MARKUP = /<\s*(script|iframe|object|embed|style|svg|math|form|input|button|link|meta)\b|\bon[a-z]+\s*=|javascript\s*:/i;

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isTableDivider(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanText);
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (!line.trim()) return true;
  if (/^#{1,4}\s+/.test(line) || /^```/.test(line) || /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) return true;
  return line.trim().startsWith("|") && isTableDivider(lines[index + 1] ?? "");
}

export function assertSafeSystemGuideMarkdown(source: string): void {
  if (source.length > MAX_SOURCE_LENGTH) throw new Error("System Guide document is too large.");
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
  if (UNSAFE_MARKUP.test(withoutComments)) throw new Error("System Guide contains unsafe HTML or JavaScript.");
}

export function parseSystemGuideMarkdown(source: string): SystemGuideBlock[] {
  assertSafeSystemGuideMarkdown(source);
  const lines = source.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: SystemGuideBlock[] = [];
  let index = 0;

  function add(block: SystemGuideBlock) {
    blocks.push(block);
    if (blocks.length > MAX_BLOCKS) throw new Error("System Guide contains too many blocks.");
  }

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      add({ type: "heading", level: heading[1].length as 1 | 2 | 3 | 4, text: cleanText(heading[2]) });
      index += 1;
      continue;
    }

    const fence = /^```([^`]*)$/.exec(line.trim());
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        content.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) throw new Error("System Guide contains an unclosed code block.");
      index += 1;
      add({ type: "code", language: cleanText(fence[1]), text: content.join("\n") });
      continue;
    }

    if (line.trim().startsWith("|") && isTableDivider(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        const cells = tableCells(lines[index]);
        rows.push(headers.map((_header, cellIndex) => cells[cellIndex] ?? ""));
        index += 1;
      }
      add({ type: "table", headers, rows });
      continue;
    }

    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      const pattern = isOrdered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*]\s+(.+)$/;
      while (index < lines.length) {
        const item = pattern.exec(lines[index]);
        if (!item) break;
        items.push(cleanText(item[1]));
        index += 1;
      }
      add({ type: "list", ordered: isOrdered, items });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    add({ type: "paragraph", text: cleanText(paragraph.join(" ")) });
  }

  return blocks;
}
