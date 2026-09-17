"use client";

import { useEffect, useState } from "react";
import { parseMasterDataCsv, parseMasterDataJson } from "@/src/domain/master-data";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import type { WorkspaceId } from "./workspaces/workspace-config";

type Props = {
  onNavigate?: (workspaceId: WorkspaceId, anchor: string) => void;
  onGoToAvailability?: () => void;
};

type ParsedRow = {
  warehouseCode: string;
  itemCode: string;
  quantity: number;
};

const sampleRows = [
  { warehouseCode: "DEMO-HR", itemCode: "DEMO-SHIRT-M", quantity: 20 },
  { warehouseCode: "DEMO-HR", itemCode: "DEMO-SHIRT-L", quantity: 20 },
  { warehouseCode: "DEMO-HR", itemCode: "DEMO-PANTS-M", quantity: 20 },
  { warehouseCode: "DEMO-HR", itemCode: "DEMO-PANTS-L", quantity: 20 },
  { warehouseCode: "DEMO-GENERAL", itemCode: "DEMO-SHIRT-M", quantity: 50 },
  { warehouseCode: "DEMO-GENERAL", itemCode: "DEMO-SHIRT-L", quantity: 50 },
  { warehouseCode: "DEMO-GENERAL", itemCode: "DEMO-PANTS-M", quantity: 50 },
  { warehouseCode: "DEMO-GENERAL", itemCode: "DEMO-PANTS-L", quantity: 50 },
];

export default function OpeningBalanceDirectImportPanel({ onNavigate, onGoToAvailability }: Props) {
  const client = getSupabaseBrowserClient();
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);
  const [missingRpc, setMissingRpc] = useState(false);
  const [itemsCount, setItemsCount] = useState<number | null>(null);

  useEffect(() => {
    if (!client) return;
    async function loadItemCount() {
      const { count } = await client!.from("uniform_items").select("*", { count: "exact", head: true }).eq("is_active", true);
      if (count !== null) setItemsCount(count);
    }
    void loadItemCount();
  }, [client]);

  function normalizeRow(row: Record<string, string>): ParsedRow {
    const warehouseCode = (
      row.warehouseCode ||
      row.warehouse_code ||
      row.warehouse ||
      row["倉庫代碼"] ||
      row["倉庫"] ||
      ""
    ).trim();

    const itemCode = (
      row.itemCode ||
      row.item_code ||
      row.item ||
      row["制服品號"] ||
      row["品號"] ||
      ""
    ).trim();

    const qtyStr = (
      row.quantity ||
      row.qty ||
      row["期初數量"] ||
      row["數量"] ||
      "0"
    ).trim();

    const quantity = Math.max(0, parseInt(qtyStr, 10) || 0);

    return { warehouseCode, itemCode, quantity };
  }

  async function handleFile(selectedFile?: File | null) {
    if (!selectedFile) return;
    setFile(selectedFile);
    setFileName(selectedFile.name);
    setMessage("");
    setIsSuccess(false);
    setMissingRpc(false);

    try {
      const text = await selectedFile.text();
      let parseResult;
      if (selectedFile.name.endsWith(".json")) {
        parseResult = parseMasterDataJson(text);
      } else {
        parseResult = parseMasterDataCsv(text);
      }

      if (parseResult.errors.length > 0) {
        setMessage(`檔案解析發生錯誤：${parseResult.errors.map((e) => `第 ${e.row} 列: ${e.message}`).join("; ")}`);
        setRows([]);
        setRawRows([]);
        return;
      }

      const normalized = parseResult.rows.map(normalizeRow);
      setRawRows(parseResult.rows);
      setRows(normalized);
      setMessage(`成功載入 ${normalized.length} 筆資料，請檢視下方預覽後點擊「確認直接匯入期初庫存」。`);
    } catch (err) {
      setMessage(`讀取檔案失敗：${err instanceof Error ? err.message : String(err)}`);
      setRows([]);
      setRawRows([]);
    }
  }

  function loadSampleData() {
    setFile(null);
    setFileName("sample-opening-balances.csv (範例)");
    setRows(sampleRows);
    setRawRows(sampleRows.map((r) => ({ warehouseCode: r.warehouseCode, itemCode: r.itemCode, quantity: String(r.quantity) })));
    setIsSuccess(false);
    setMissingRpc(false);
    setMessage(`已載入 ${sampleRows.length} 列測試範例；請確認後點擊匯入。`);
  }

  function downloadSampleCsv() {
    const csvContent = "warehouseCode,itemCode,quantity\n" + sampleRows.map((r) => `${r.warehouseCode},${r.itemCode},${r.quantity}`).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "sample-opening-balances.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("範例 CSV 已下載。");
  }

  async function downloadCatalogTemplate() {
    if (!client) {
      setMessage("尚未連線至 Supabase，無法取得現有品號清單。");
      return;
    }
    setBusy(true);
    try {
      const [itemsRes, whRes] = await Promise.all([
        client.from("uniform_items").select("item_code,item_name").eq("is_active", true).order("item_code"),
        client.from("warehouses").select("code,name,purpose").eq("is_active", true).order("purpose"),
      ]);

      const activeItems = itemsRes.data ?? [];
      const activeWh = whRes.data ?? [];

      if (activeItems.length === 0) {
        setMessage("目前資料庫中無啟用中商品品號。");
        setBusy(false);
        return;
      }

      const hrWh = activeWh.find((w) => w.purpose === "HR")?.code ?? "DEMO-HR";
      const genWh = activeWh.find((w) => w.purpose === "GENERAL")?.code ?? "DEMO-GENERAL";

      const lines = ["warehouseCode,itemCode,quantity,itemName"];
      for (const item of activeItems) {
        lines.push(`${hrWh},${item.item_code},0,${item.item_name || ""}`);
        lines.push(`${genWh},${item.item_code},0,${item.item_name || ""}`);
      }

      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `opening-template-${activeItems.length}-items.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(`已下載包含 ${activeItems.length} 項商品的期初庫存預填範本 CSV（包含人資倉與總倉）。請在 Excel 填寫數量後上傳。`);
    } catch (err) {
      setMessage(`產生範本失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function applyDirectImport() {
    if (!client) {
      setMessage("請先登入後再進行期初庫存匯入。");
      return;
    }
    if (rows.length === 0) {
      setMessage("目前沒有可匯入的資料列，請先選擇 CSV 檔案。");
      return;
    }

    setBusy(true);
    setMessage("正在匯入期初庫存中，請稍候…");
    setIsSuccess(false);
    setMissingRpc(false);

    try {
      const idempotencyKey = `DIRECT-OPENING-${crypto.randomUUID()}`;
      const payloadRows = rows.map((r) => ({
        warehouseCode: r.warehouseCode,
        itemCode: r.itemCode,
        quantity: r.quantity,
      }));

      const { data, error } = await client.rpc("apply_opening_balance_direct", {
        p_source_filename: fileName || "manual-direct-import.csv",
        p_rows: payloadRows,
        p_idempotency_key: idempotencyKey,
        p_request_fingerprint: `direct-opening:${fileName}:${rows.length}`,
      });

      if (error) {
        if (error.message.includes("function public.apply_opening_balance_direct") || error.message.includes("does not exist")) {
          setMissingRpc(true);
          setMessage("資料庫尚未建立 apply_opening_balance_direct RPC。請在 Supabase SQL Editor 執行 migration 0081_direct_opening_balance_import.sql。");
        } else {
          setMessage(`匯入失敗：${error.message}`);
        }
        setIsSuccess(false);
      } else {
        const result = data as {
          success?: boolean;
          imported_rows?: number;
          error_rows?: number;
          message?: string;
          errors?: string[];
        };

        if (result?.success) {
          setIsSuccess(true);
          setMessage(result.message || `成功匯入 ${result.imported_rows ?? rows.length} 筆期初庫存！庫存與不可變異動流水已即時更新。`);
        } else {
          setMessage(result?.message || "匯入未完全成功，請查看錯誤提示。");
        }
      }
    } catch (err) {
      setMessage(`發生非預期錯誤：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel import-panel" aria-label="期初庫存即時匯入">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">INVENTORY / OPENING BALANCE</p>
          <h2>期初庫存即時匯入（免 Worker）</h2>
        </div>
        <span className={`status-pill ${isSuccess ? "success" : rows.length > 0 ? "info" : ""}`}>
          {isSuccess ? "已成功入帳" : rows.length > 0 ? `已載入 ${rows.length} 筆` : "尚未選檔"}
        </span>
      </div>

      <p className="auth-message">
        免 Worker 即時匯入：由瀏覽器直接解析 CSV，並透過 Supabase RPC 原子寫入庫存餘額（<code>inventory_balances</code>）與不可變異動流水（<code>inventory_ledger_entries</code>），不需在背景啟動 worker 即可立即生效。
        {itemsCount !== null ? ` 目前資料庫中共有 ${itemsCount} 項啟用中的商品品號。` : ""}
      </p>

      <div className="form-grid master-tools">
        <label className="file-picker">
          <span>選擇 CSV／JSON 檔案</span>
          <input
            type="file"
            accept=".csv,text/csv,application/json,.json"
            onChange={(event) => void handleFile(event.target.files?.[0])}
            disabled={busy}
          />
        </label>
      </div>

      <div className="button-row">
        <button className="secondary-button" type="button" onClick={loadSampleData} disabled={busy}>
          載入測試範例
        </button>
        <button className="secondary-button" type="button" onClick={downloadSampleCsv} disabled={busy}>
          下載範例 CSV
        </button>
        <button className="secondary-button" type="button" onClick={() => void downloadCatalogTemplate()} disabled={busy}>
          下載現有全部商品預填範本 CSV
        </button>
      </div>

      {fileName ? <p className="file-name">{fileName} ／ 共 {rows.length} 列資料</p> : null}

      {rows.length > 0 ? (
        <div className="summary-list" style={{ marginTop: 14 }}>
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 60 }}>#</th>
                  <th>倉庫代碼</th>
                  <th>制服品號</th>
                  <th style={{ textAlign: "right" }}>期初庫存數量</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 20).map((row, index) => (
                  <tr key={`${row.warehouseCode}-${row.itemCode}-${index}`}>
                    <td>{index + 1}</td>
                    <td><code>{row.warehouseCode || "(預設總倉)"}</code></td>
                    <td><strong>{row.itemCode}</strong></td>
                    <td style={{ textAlign: "right" }}>{row.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 20 ? (
            <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              …以上顯示前 20 筆，其餘 {rows.length - 20} 筆亦將於點擊匯入時全部寫入。
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="button-row" style={{ marginTop: 16 }}>
        <button
          className="primary-button"
          type="button"
          onClick={() => void applyDirectImport()}
          disabled={busy || rows.length === 0}
        >
          {busy ? "匯入處理中…" : `確認直接匯入期初庫存（共 ${rows.length} 筆）`}
        </button>

        {isSuccess ? (
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              if (onGoToAvailability) onGoToAvailability();
              else if (onNavigate) onNavigate("warehouse", "warehouse-inventory-title");
            }}
          >
            前往查看「兩倉可用量」➜
          </button>
        ) : null}
      </div>

      {message ? (
        <p className={isSuccess ? "success-note" : "auth-message"} role="status" style={{ marginTop: 14 }}>
          {message}
        </p>
      ) : null}

      {missingRpc ? (
        <div className="summary-list" style={{ marginTop: 16, padding: 14, background: "rgba(255, 149, 0, .08)", border: "1px solid rgba(255, 149, 0, .3)", borderRadius: 10 }}>
          <p style={{ fontWeight: "bold", color: "#b35900" }}>尚未在 Supabase 執行 Migration 0081</p>
          <p style={{ fontSize: 12, color: "var(--ink)", marginTop: 4 }}>
            請開啟 Supabase 控制台的 SQL Editor，貼上並執行 <code>supabase/migrations/0081_direct_opening_balance_import.sql</code> 即可啟用即時直匯。
          </p>
        </div>
      ) : null}
    </section>
  );
}
