import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

describe("Supabase Edge durable import adapter", () => {
  it("keeps the existing worker RPC and actor boundaries", () => {
    const source = readFileSync(resolve(repositoryRoot, "supabase/functions/import-worker/index.ts"), "utf8");

    expect(source).toContain("IMPORT_EDGE_DATABASE_URL");
    expect(source).toContain("prepare: false");
    expect(source).toContain("public.list_import_work");
    expect(source).toContain("public.confirm_import_upload");
    expect(source).toContain("public.complete_import_chunk");
    expect(source).toContain("public.apply_import_batch");
    expect(source).toContain("const maxChunksPerInvocation = 4");
    expect(source).toContain("cachedPreview ?? await previewRows");
    expect(source).toContain("for (let count = 0; count < maxChunksPerInvocation");
    expect(source).toContain("authClient.auth.getUser");
    expect(source).toContain("const storage = authClient");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(source).not.toContain("console.error(error");
  });

  it("is invoked by the browser only after the file remains in private Storage", () => {
    const source = readFileSync(resolve(repositoryRoot, "src/app/DurableImportPanel.tsx"), "utf8");

    expect(source).toContain('client.functions.invoke("import-worker"');
    expect(source).toContain("storage.from(activeBatch.storage_bucket).upload");
    expect(source).toContain("不持有 service-role 權限");
  });

  it("reads the durable status back immediately after an on-demand worker kick", () => {
    const source = readFileSync(resolve(repositoryRoot, "src/app/DurableImportPanel.tsx"), "utf8");
    expect(source).toContain("const refreshedAfterKick = await refreshBatch(activeBatch.id)");
    expect(source).toContain("檔案已檢查完成，請確認預覽內容後按「確認後匯入」。");
  });

  it("continues only when the worker reports bounded forward progress", () => {
    const edgeSource = readFileSync(resolve(repositoryRoot, "supabase/functions/import-worker/index.ts"), "utf8");
    const panelSource = readFileSync(resolve(repositoryRoot, "src/app/DurableImportPanel.tsx"), "utf8");
    const clientSource = readFileSync(resolve(repositoryRoot, "src/lib/import-worker-client.ts"), "utf8");

    expect(edgeSource).toContain("shouldImmediatelyContinueImportBatch");
    expect(edgeSource).toContain("continueImmediately");
    expect(panelSource).toContain("kickImportWorkerUntilYielded");
    expect(clientSource).toContain("maxImportWorkerKickInvocations = 4");
  });
});
