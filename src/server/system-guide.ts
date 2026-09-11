import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSystemGuideMarkdown,
  systemGuideDocumentDefinitions,
  type SystemGuideDocument,
} from "@/src/domain/system-guide";

const DOCUMENT_DIRECTORY = join(process.cwd(), "docs", "system-guide");

export async function loadSystemGuideDocuments(): Promise<SystemGuideDocument[]> {
  return Promise.all(systemGuideDocumentDefinitions.map(async (definition) => {
    const source = await readFile(join(DOCUMENT_DIRECTORY, definition.fileName), "utf8");
    return {
      id: definition.id,
      title: definition.title,
      audience: definition.audience,
      blocks: parseSystemGuideMarkdown(source),
    };
  }));
}
