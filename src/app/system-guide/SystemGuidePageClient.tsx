"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  systemGuideDocumentDefinitions,
  type SystemGuideBlock,
  type SystemGuideDocument,
  type SystemGuideDocumentId,
} from "@/src/domain/system-guide";

type Props = {
  documents: SystemGuideDocument[];
  loading: boolean;
  message: string;
  forbidden: boolean;
};

function inlineParts(text: string): ReactNode[] {
  const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  const result: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > offset) result.push(text.slice(offset, index));
    const token = match[0];
    if (token.startsWith("**")) result.push(<strong key={`${index}-strong`}>{token.slice(2, -2)}</strong>);
    else result.push(<code key={`${index}-code`}>{token.slice(1, -1)}</code>);
    offset = index + token.length;
  }
  if (offset < text.length) result.push(text.slice(offset));
  return result;
}

function blockId(text: string, index: number): string {
  const normalized = text.toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "");
  return `guide-${normalized || "section"}-${index}`;
}

function GuideBlock({ block, index }: { block: SystemGuideBlock; index: number }) {
  if (block.type === "heading") {
    const id = blockId(block.text, index);
    if (block.level === 1) return <h1 id={id}>{inlineParts(block.text)}</h1>;
    if (block.level === 2) return <h2 id={id}>{inlineParts(block.text)}</h2>;
    if (block.level === 3) return <h3 id={id}>{inlineParts(block.text)}</h3>;
    return <h4 id={id}>{inlineParts(block.text)}</h4>;
  }
  if (block.type === "paragraph") return <p>{inlineParts(block.text)}</p>;
  if (block.type === "code") return <pre data-language={block.language || undefined}><code>{block.text}</code></pre>;
  if (block.type === "list") {
    const List = block.ordered ? "ol" : "ul";
    return <List>{block.items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{inlineParts(item)}</li>)}</List>;
  }
  return <div className="system-guide-table-wrap"><table><thead><tr>{block.headers.map((header) => <th key={header}>{inlineParts(header)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{inlineParts(cell)}</td>)}</tr>)}</tbody></table></div>;
}

export default function SystemGuidePageClient({ documents, loading, message, forbidden }: Props) {
  const [activeDocumentId, setActiveDocumentId] = useState<SystemGuideDocumentId>("user");
  const activeDocument = documents.find((document) => document.id === activeDocumentId);
  const sections = useMemo(() => activeDocument?.blocks.flatMap((block, index) => block.type === "heading" && block.level === 2
    ? [{ id: blockId(block.text, index), text: block.text }]
    : []) ?? [], [activeDocument]);

  if (forbidden) {
    return (
      <section className="panel system-guide-embedded-gate" aria-live="polite">
        <p className="eyebrow">SYSTEM GUIDE / PROTECTED</p>
        <h2>無法查看 System Guide</h2>
        <p>{message}</p>
      </section>
    );
  }

  return (
    <section className="system-guide-page system-guide-page-embedded" aria-label="制服管理系統說明中心">
      <header className="system-guide-hero">
        <div>
          <p className="eyebrow">SYSTEM GUIDE / ADMIN ONLY</p>
          <h2>制服管理系統說明中心</h2>
          <p>使用者操作、管理設定與 AI Agent 交接共用同一組版本化 Markdown 來源。</p>
        </div>
      </header>

      <div className="system-guide-shell">
        <aside className="system-guide-sidebar">
          <nav aria-label="System Guide 文件">
            {systemGuideDocumentDefinitions.map((definition) => (
              <button
                key={definition.id}
                className={definition.id === activeDocumentId ? "active" : ""}
                type="button"
                onClick={() => setActiveDocumentId(definition.id)}
              >
                <strong>{definition.title}</strong>
                <small>{definition.audience}</small>
              </button>
            ))}
          </nav>
          {sections.length ? <div className="system-guide-toc"><p>本頁章節</p>{sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.text}</a>)}</div> : null}
        </aside>

        <article className="system-guide-document" aria-live="polite" aria-busy={loading}>
          <div className="system-guide-document-meta"><span className="status-pill">READ ONLY</span><span>{message}</span></div>
          {activeDocument
            ? activeDocument.blocks.map((block, index) => <Fragment key={`${block.type}-${index}`}><GuideBlock block={block} index={index} /></Fragment>)
            : <div className="system-guide-loading"><span className="status-pill">LOADING</span><p>{message}</p></div>}
        </article>
      </div>
    </section>
  );
}
