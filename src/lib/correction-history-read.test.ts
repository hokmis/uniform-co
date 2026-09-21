import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCorrectionHistory } from "./correction-history-read";

function queryBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(async () => result),
    in: vi.fn(async () => result),
  };
  return builder;
}

function clientFrom(builders: Record<string, ReturnType<typeof queryBuilder>>): SupabaseClient {
  return {
    from: vi.fn((table: string) => builders[table]),
    auth: { refreshSession: vi.fn() },
  } as unknown as SupabaseClient;
}

describe("correction history read adapter", () => {
  const legacySources = [
    { kind: "PURCHASE_RECEIPT", table: "purchase_receipt_correction_lines", lineColumn: "original_receipt_line_id", parentColumn: "original_purchase_receipt_id", constraint: "purchase_receipt_correction_l_correction_note_id_original__fkey", fields: { delivered_quantity_delta: -2, accepted_quantity_delta: -1, rejected_quantity_delta: -1 } },
    { kind: "RETURN", table: "return_correction_lines", lineColumn: "original_return_line_id", parentColumn: "original_return_note_id", constraint: "return_correction_lines_correction_note_id_original_return_fkey", fields: { return_quantity_delta: -1 } },
    { kind: "HR_ISSUE", table: "issue_correction_lines", lineColumn: "original_issue_line_id", parentColumn: "original_hr_request_id", constraint: "issue_correction_lines_correction_note_id_original_hr_requ_fkey", fields: { issue_quantity_delta: -1 } },
    { kind: "SHIPMENT", table: "warehouse_transfer_correction_lines", lineColumn: "original_shipment_line_id", parentColumn: "original_warehouse_shipment_id", constraint: "warehouse_transfer_correction_correction_note_id_original__fkey", fields: { transfer_quantity_delta: -1 } },
    { kind: "REPLENISHMENT", table: "warehouse_transfer_correction_lines", lineColumn: "original_replenishment_line_id", parentColumn: "original_replenishment_request_id", constraint: "warehouse_transfer_correctio_correction_note_id_original__fkey1", fields: { transfer_quantity_delta: -1 } },
    { kind: "STOCKTAKE", table: "stocktake_correction_lines", lineColumn: "original_stocktake_line_id", parentColumn: "original_stocktake_id", constraint: "stocktake_correction_lines_correction_note_id_original_sto_fkey", fields: { counted_quantity_delta: -1 } },
  ] as const;

  it("maps the unified view in one read and keeps receipt quantity fields", async () => {
    const view = queryBuilder({
      data: [{
        correction_id: "correction-1",
        correction_no: "COR-001",
        status: "POSTED",
        reason: "入庫誤登",
        posted_at: "2026-09-19T01:00:00Z",
        delta_quantity: null,
        delivered_quantity_delta: -2,
        accepted_quantity_delta: -1,
        rejected_quantity_delta: -1,
      }],
      error: null,
    });
    const client = clientFrom({ v_correction_history: view });

    await expect(loadCorrectionHistory(client, {
      kind: "PURCHASE_RECEIPT",
      parentId: "receipt-1",
      lineId: "receipt-line-1",
    })).resolves.toEqual({
      data: [{
        id: "correction-1",
        correction_no: "COR-001",
        status: "POSTED",
        reason: "入庫誤登",
        posted_at: "2026-09-19T01:00:00Z",
        delta: 0,
        delivered_quantity_delta: -2,
        accepted_quantity_delta: -1,
        rejected_quantity_delta: -1,
      }],
      error: null,
      usedLegacyFallback: false,
    });
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(view.select).toHaveBeenCalledWith("correction_id,correction_kind,source_kind,correction_no,status,reason,posted_at,source_parent_id,source_line_id,delta_quantity,delivered_quantity_delta,accepted_quantity_delta,rejected_quantity_delta");
  });

  it("uses one embedded correction-note read when the view is not deployed", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const lines = queryBuilder({
      data: [{
        correction_note_id: "correction-2",
        original_return_line_id: "return-line-1",
        return_quantity_delta: -1,
        correction_note: {
          id: "correction-2",
          correction_no: "COR-002",
          status: "POSTED",
          reason: "退回誤登",
          posted_at: null,
          correction_kind: "RETURN",
          original_return_note_id: "return-1",
        },
      }],
      error: null,
    });
    const notes = queryBuilder({
      data: [{ id: "correction-2", correction_no: "COR-002", status: "POSTED", reason: "退回誤登", posted_at: null }],
      error: null,
    });
    const client = clientFrom({ v_correction_history: view, correction_notes: notes, return_correction_lines: lines });

    const result = await loadCorrectionHistory(client, {
      kind: "RETURN",
      parentId: "return-1",
      lineId: "return-line-1",
    });

    expect(result).toEqual({
      data: [{
        id: "correction-2",
        correction_no: "COR-002",
        status: "POSTED",
        reason: "退回誤登",
        posted_at: null,
        delta: -1,
        delivered_quantity_delta: 0,
        accepted_quantity_delta: 0,
        rejected_quantity_delta: 0,
      }],
      error: null,
      usedLegacyFallback: true,
    });
    expect(client.from).not.toHaveBeenCalledWith("correction_notes");
    expect(client.from).toHaveBeenCalledWith("return_correction_lines");
    expect(client.from).toHaveBeenCalledTimes(2);
    expect(lines.select).toHaveBeenCalledWith(expect.stringContaining("correction_note:correction_notes!return_correction_lines_correction_note_id_original_return_fkey!inner("));
    expect(lines.eq).toHaveBeenCalledWith("correction_note.original_return_note_id", "return-1");
  });

  it.each(legacySources)("uses the correct composite correction-note relationship for $kind", async ({ kind, table, lineColumn, parentColumn, constraint, fields }) => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const lineId = `${kind}-line`;
    const parentId = `${kind}-parent`;
    const lines = queryBuilder({
      data: [{
        correction_note_id: "correction-row",
        [lineColumn]: lineId,
        ...fields,
        correction_note: {
          id: "correction-row",
          correction_no: "COR-TEST",
          status: "POSTED",
          reason: "測試更正",
          posted_at: null,
          correction_kind: kind === "SHIPMENT" || kind === "REPLENISHMENT" ? "WAREHOUSE_TRANSFER" : kind,
          [parentColumn]: parentId,
        },
      }],
      error: null,
    });
    const notes = queryBuilder({ data: [], error: null });
    const client = clientFrom({ v_correction_history: view, [table]: lines, correction_notes: notes });

    const result = await loadCorrectionHistory(client, { kind, parentId, lineId });

    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe("correction-row");
    expect(lines.select).toHaveBeenCalledWith(expect.stringContaining(`correction_notes!${constraint}!inner(`));
    expect(client.from).not.toHaveBeenCalledWith("correction_notes");
    expect(client.from).toHaveBeenCalledTimes(2);
  });

  it("retains the two-read fallback only when the relation is unavailable in PostgREST cache", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const embedded = queryBuilder({ data: null, error: { code: "PGRST200", message: "Could not find a relationship" } });
    const notes = queryBuilder({
      data: [{ id: "correction-fallback", correction_no: "COR-FALLBACK", status: "POSTED", reason: "退回誤登", posted_at: null }],
      error: null,
    });
    const lines = queryBuilder({
      data: [{ correction_note_id: "correction-fallback", original_return_line_id: "return-line-2", return_quantity_delta: -2 }],
      error: null,
    });
    let lineReadCount = 0;
    const client = {
      from: vi.fn((table: string) => {
        if (table === "v_correction_history") return view;
        if (table === "return_correction_lines") return lineReadCount++ === 0 ? embedded : lines;
        if (table === "correction_notes") return notes;
        throw new Error("unexpected table");
      }),
      auth: { refreshSession: vi.fn() },
    } as unknown as SupabaseClient;

    const result = await loadCorrectionHistory(client, { kind: "RETURN", parentId: "return-2", lineId: "return-line-2" });

    expect(result.data[0]).toMatchObject({ id: "correction-fallback", delta: -2 });
    expect(result.usedLegacyFallback).toBe(true);
    expect(client.from).toHaveBeenCalledWith("correction_notes");
    expect(lineReadCount).toBe(2);
  });

  it("does not hide a permission error behind the embedded compatibility read", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const lines = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const notes = queryBuilder({ data: [], error: null });
    const client = clientFrom({ v_correction_history: view, return_correction_lines: lines, correction_notes: notes });

    const result = await loadCorrectionHistory(client, { kind: "RETURN", parentId: "return-3", lineId: "line-3" });

    expect(result.error).toMatchObject({ code: "42501" });
    expect(client.from).not.toHaveBeenCalledWith("correction_notes");
    expect(client.from).toHaveBeenCalledTimes(2);
  });

  it("does not hide permission failures behind the rollout fallback", async () => {
    const view = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const client = clientFrom({ v_correction_history: view });

    const result = await loadCorrectionHistory(client, {
      kind: "STOCKTAKE",
      parentId: "stocktake-1",
      lineId: "stocktake-line-1",
    });

    expect(result.error).toMatchObject({ code: "42501" });
    expect(result.usedLegacyFallback).toBe(false);
    expect(client.from).toHaveBeenCalledTimes(1);
  });
});
