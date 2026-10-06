"use client";

import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hrRequestStatusLabel, type HrRequestStatus } from "@/src/domain/hr-request-history";
import { loadHrRequestHistoryFallback, loadHrRequestHistoryDetailFallback } from "@/src/lib/hr-request-history-fallback";
import { loadOrganizationMasterData } from "@/src/lib/master-data-cache";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import {
  buildPivotTableData,
  generatePivotXlsx,
  downloadPivotXlsx,
  HR_REQUEST_ALLOWED_DEPARTMENTS,
  type RawIssueLineInput,
  type ItemStockInfo,
} from "@/src/domain/hr-request-pivot-export";
import type { StockMovementPostingKind } from "@/src/domain/stock-movement-history";

type RequestItem = {
  id: string;
  item_id: string;
  item_code_snapshot: string | null;
  item_name_snapshot: string | null;
  unit_snapshot: string | null;
  issue_quantity: number;
  increase_quantity: number;
  requested_transfer_quantity: number;
};

type IssueLine = {
  id: string;
  line_no: number;
  employee_no_snapshot: string | null;
  employee_name_snapshot: string | null;
  institution_code_snapshot: string | null;
  department_code_snapshot: string | null;
  institution_name_snapshot?: string | null;
  department_name_snapshot?: string | null;
  item_code_snapshot: string | null;
  item_name_snapshot: string | null;
  size_snapshot: string | null;
  unit_snapshot: string | null;
  quantity: number;
};

type Reservation = {
  item_id: string;
  quantity: number;
  status: string;
  closed_at: string | null;
};

type HrRequestHeader = {
  id: string;
  requestType: "HR_ISSUE" | "REPLENISHMENT";
  requestNo: string;
  status: HrRequestStatus;
  distributionDate: string;
  rowVersion: number;
  createdAt: string;
  submittedAt: string | null;
  shippedAt: string | null;
  cancelledAt: string | null;
  note: string | null;
  shipmentNo: string | null;
  shipmentStatus: "DRAFT" | "POSTED" | null;
  activeReservedQuantity: number;
};

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type HrRequestDetailModalProps = {
  isOpen: boolean;
  onClose: () => void;
  client: SupabaseClient | null;
  sourceNo: string;
  postingId?: string;
  postingKind?: StockMovementPostingKind;
};

export default function HrRequestDetailModal({
  isOpen,
  onClose,
  client,
  sourceNo,
  postingId,
  postingKind,
}: HrRequestDetailModalProps) {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [header, setHeader] = useState<HrRequestHeader | null>(null);
  const [items, setItems] = useState<RequestItem[]>([]);
  const [issueLines, setIssueLines] = useState<IssueLine[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [orgMap, setOrgMap] = useState<Map<string, string>>(new Map());
  const [exporting, setExporting] = useState(false);

  // 鍵盤 Esc 關閉
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // 組織主檔對照表
  useEffect(() => {
    if (!client || !isOpen) return;
    let active = true;
    loadOrganizationMasterData(client)
      .then((orgData) => {
        if (!active) return;
        const nextMap = new Map<string, string>();
        for (const dept of HR_REQUEST_ALLOWED_DEPARTMENTS) {
          nextMap.set(dept.code, dept.name);
        }
        for (const dept of orgData?.departments ?? []) {
          if (dept.code) nextMap.set(dept.code, dept.name || dept.code);
        }
        for (const inst of orgData?.institutions ?? []) {
          if (inst.code && !nextMap.has(inst.code)) nextMap.set(inst.code, inst.name || inst.code);
        }
        setOrgMap(nextMap);
      })
      .catch(() => {
        // non-blocking
      });
    return () => {
      active = false;
    };
  }, [client, isOpen]);

  // 載入單據完整資料
  useEffect(() => {
    if (!isOpen || !client) return;
    let active = true;

    async function fetchDetail() {
      if (!client) return;
      setLoading(true);
      setErrorMsg("");
      setHeader(null);
      setItems([]);
      setIssueLines([]);
      setReservations([]);

      try {
        let actualRequestId = postingId || "";
        let isReplenishment = postingKind === "REPLENISHMENT" || sourceNo.startsWith("REP");

        // 若為發貨單（SHIP-...），先查詢關聯之 hr_request_id
        if (postingKind === "WAREHOUSE_SHIPMENT" || sourceNo.startsWith("SHIP") || sourceNo.startsWith("SHP")) {
          const { data: shipmentData, error: shipmentError } = await client
            .from("warehouse_shipments")
            .select("id, shipment_no, hr_request_id, status")
            .or(`id.eq.${actualRequestId || "00000000-0000-0000-0000-000000000000"},shipment_no.eq.${sourceNo}`)
            .limit(1)
            .maybeSingle();

          if (!shipmentError && shipmentData?.hr_request_id) {
            actualRequestId = String(shipmentData.hr_request_id);
          }
        }

        // 處理額外補庫單
        if (isReplenishment) {
          const [repRes, itemsRes] = await retrySupabaseQueriesAfterSessionRefresh(client, () =>
            Promise.all([
              client
                .from("replenishment_requests")
                .select("id, request_no, status, row_version, created_at, submitted_at, shipped_at, cancelled_at, note")
                .or(`id.eq.${actualRequestId || "00000000-0000-0000-0000-000000000000"},request_no.eq.${sourceNo}`)
                .limit(1)
                .maybeSingle(),
              client
                .from("replenishment_request_items")
                .select("id, item_id, quantity, items(item_code, item_name, unit)")
                .eq("request_id", actualRequestId),
            ]),
          );

          if (!active) return;

          if (repRes.error || !repRes.data) {
            setErrorMsg(`找不到此補庫單資料：${safeSupabaseReadErrorMessage(repRes.error)}`);
            setLoading(false);
            return;
          }

          const repData = repRes.data as Record<string, unknown>;
          setHeader({
            id: String(repData.id ?? ""),
            requestType: "REPLENISHMENT",
            requestNo: String(repData.request_no ?? sourceNo),
            status: (repData.status as HrRequestStatus) || "SUBMITTED",
            distributionDate: String(repData.submitted_at || repData.created_at || "").slice(0, 10),
            rowVersion: Number(repData.row_version) || 1,
            createdAt: String(repData.created_at ?? ""),
            submittedAt: (repData.submitted_at as string) || null,
            shippedAt: (repData.shipped_at as string) || null,
            cancelledAt: (repData.cancelled_at as string) || null,
            note: (repData.note as string) || null,
            shipmentNo: null,
            shipmentStatus: null,
            activeReservedQuantity: 0,
          });

          const loadedItems = ((itemsRes.data ?? []) as Array<Record<string, unknown>>).map((row) => {
            const itemObj = (row.items && typeof row.items === "object" ? row.items : {}) as Record<string, unknown>;
            const qty = numberValue(row.quantity);
            return {
              id: String(row.id ?? ""),
              item_id: String(row.item_id ?? ""),
              item_code_snapshot: (itemObj.item_code as string) || null,
              item_name_snapshot: (itemObj.item_name as string) || null,
              unit_snapshot: (itemObj.unit as string) || "件",
              issue_quantity: 0,
              increase_quantity: qty,
              requested_transfer_quantity: qty,
            };
          });
          setItems(loadedItems);
          setLoading(false);
          return;
        }

        // 處理一般員工制服需求單 (HR_ISSUE)
        // 1. 取得單頭
        let headRes = await client
          .from("v_hr_request_history")
          .select("id, request_no, status, distribution_date, row_version, created_at, submitted_at, shipped_at, cancelled_at, note, shipment_no, shipment_status, active_reserved_quantity")
          .or(`id.eq.${actualRequestId || "00000000-0000-0000-0000-000000000000"},request_no.eq.${sourceNo}`)
          .limit(1)
          .maybeSingle();

        let headData = headRes.data as Record<string, unknown> | null;

        if (!headData || headRes.error) {
          // Fallback 至 hr_requests
          const fallback = await loadHrRequestHistoryFallback(client);
          if (fallback.data) {
            headData = (fallback.data.find(
              (r) => r.id === actualRequestId || r.request_no === sourceNo,
            ) as unknown as Record<string, unknown>) || null;
          }
        }

        if (!active) return;

        if (!headData) {
          setErrorMsg("查無此需求單資料。");
          setLoading(false);
          return;
        }

        actualRequestId = String(headData.id);
        setHeader({
          id: actualRequestId,
          requestType: "HR_ISSUE",
          requestNo: String(headData.request_no ?? sourceNo),
          status: (headData.status as HrRequestStatus) || "DRAFT",
          distributionDate: String(headData.distribution_date ?? ""),
          rowVersion: Number(headData.row_version) || 1,
          createdAt: String(headData.created_at ?? ""),
          submittedAt: (headData.submitted_at as string) || null,
          shippedAt: (headData.shipped_at as string) || null,
          cancelledAt: (headData.cancelled_at as string) || null,
          note: (headData.note as string) || null,
          shipmentNo: (headData.shipment_no as string) || null,
          shipmentStatus: (headData.shipment_status as "DRAFT" | "POSTED") || null,
          activeReservedQuantity: numberValue(headData.active_reserved_quantity),
        });

        // 2. 取得明細 (v_hr_request_history_detail)
        let detailRes = await client
          .from("v_hr_request_history_detail")
          .select("request_id, detail_kind, detail_id, item_id, item_code_snapshot, item_name_snapshot, unit_snapshot, issue_quantity, increase_quantity, requested_transfer_quantity, line_no, employee_no_snapshot, employee_name_snapshot, institution_code_snapshot, department_code_snapshot, size_snapshot, quantity, reservation_status, closed_at")
          .eq("request_id", actualRequestId)
          .order("detail_kind")
          .order("line_no");

        let detailRows = detailRes.data as Array<Record<string, unknown>> | null;

        if (!detailRows || detailRes.error) {
          const detailFallback = await loadHrRequestHistoryDetailFallback(client, actualRequestId);
          if (detailFallback.data) {
            detailRows = detailFallback.data as unknown as Array<Record<string, unknown>>;
          }
        }

        if (!active) return;

        if (detailRows) {
          const loadedItems: RequestItem[] = detailRows
            .filter((r) => r.detail_kind === "ITEM")
            .map((r) => ({
              id: String(r.detail_id ?? ""),
              item_id: String(r.item_id ?? ""),
              item_code_snapshot: (r.item_code_snapshot as string) || null,
              item_name_snapshot: (r.item_name_snapshot as string) || null,
              unit_snapshot: (r.unit_snapshot as string) || null,
              issue_quantity: numberValue(r.issue_quantity),
              increase_quantity: numberValue(r.increase_quantity),
              requested_transfer_quantity: numberValue(r.requested_transfer_quantity),
            }));

          const loadedLines: IssueLine[] = detailRows
            .filter((r) => r.detail_kind === "ISSUE")
            .map((r) => ({
              id: String(r.detail_id ?? ""),
              line_no: numberValue(r.line_no),
              employee_no_snapshot: (r.employee_no_snapshot as string) || null,
              employee_name_snapshot: (r.employee_name_snapshot as string) || null,
              institution_code_snapshot: (r.institution_code_snapshot as string) || null,
              institution_name_snapshot: (r.institution_name_snapshot as string) || null,
              department_code_snapshot: (r.department_code_snapshot as string) || null,
              department_name_snapshot: (r.department_name_snapshot as string) || null,
              item_code_snapshot: (r.item_code_snapshot as string) || null,
              item_name_snapshot: (r.item_name_snapshot as string) || null,
              size_snapshot: (r.size_snapshot as string) || null,
              unit_snapshot: (r.unit_snapshot as string) || null,
              quantity: numberValue(r.quantity),
            }));

          const loadedRes: Reservation[] = detailRows
            .filter((r) => r.detail_kind === "RESERVATION")
            .map((r) => ({
              item_id: String(r.item_id ?? ""),
              quantity: numberValue(r.quantity),
              status: (r.reservation_status as string) || "CLOSED",
              closed_at: (r.closed_at as string) || null,
            }));

          setItems(loadedItems);
          setIssueLines(loadedLines);
          setReservations(loadedRes);
        }
      } catch (err) {
        if (active) {
          setErrorMsg(`載入單據明細發生異常：${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void fetchDetail();

    return () => {
      active = false;
    };
  }, [client, isOpen, postingId, postingKind, sourceNo]);

  // 解析單位快取
  const parsedUnitMap = useMemo(() => {
    let map: Record<string, string> = {};
    if (header?.note) {
      const match = header.note.match(/<!--unit_map:(.*?)-->/);
      if (match) {
        try {
          map = JSON.parse(match[1]);
        } catch {}
      }
    }
    if (Object.keys(map).length === 0 && header && typeof window !== "undefined") {
      try {
        const cached =
          localStorage.getItem(`hr_request_units_${header.id}`) ||
          localStorage.getItem(`hr_request_units_${header.requestNo}`);
        if (cached) map = JSON.parse(cached);
      } catch {}
    }
    return map;
  }, [header]);

  const activeReserved = useMemo(
    () => reservations.filter((row) => row.status === "ACTIVE").reduce((sum, row) => sum + numberValue(row.quantity), 0),
    [reservations],
  );

  async function handleExportSingle() {
    if (!header || !client) return;
    setExporting(true);
    try {
      const rawLines: RawIssueLineInput[] = issueLines.map((line) => {
        const selectedCode = parsedUnitMap[line.line_no] || parsedUnitMap[String(line.line_no)];
        const unitCode = selectedCode || line.department_code_snapshot || line.institution_code_snapshot || "";
        const unitName =
          (selectedCode && orgMap.get(selectedCode)) ||
          (unitCode === line.department_code_snapshot ? line.department_name_snapshot : null) ||
          (unitCode === line.institution_code_snapshot ? line.institution_name_snapshot : null) ||
          orgMap.get(unitCode) ||
          line.department_name_snapshot ||
          line.institution_name_snapshot ||
          "";

        return {
          itemCode: line.item_code_snapshot || "",
          itemName: line.item_name_snapshot || "",
          size: line.size_snapshot || "",
          unit: line.unit_snapshot || "件",
          institutionCodeOrName: unitName || unitCode,
          quantity: numberValue(line.quantity),
        };
      });

      const stockMap = new Map<string, ItemStockInfo>();
      for (const item of items) {
        const code = item.item_code_snapshot || item.item_id;
        if (code) {
          stockMap.set(code, {
            itemCode: code,
            itemName: item.item_name_snapshot || code,
            size: "",
            unit: item.unit_snapshot || "件",
            onHand: 0,
            increaseQuantity: numberValue(item.increase_quantity),
          });
        }
      }

      if (client) {
        const availRes = await client
          .from("v_item_availability")
          .select("item_code, item_name, size, unit, hr_on_hand_quantity")
          .order("item_code");
        if (availRes.data) {
          for (const it of availRes.data as Array<Record<string, unknown>>) {
            const code = (typeof it.item_code === "string" && it.item_code.trim()) || "";
            if (!code) continue;
            const existing = stockMap.get(code);
            stockMap.set(code, {
              itemCode: code,
              itemName: existing?.itemName || (typeof it.item_name === "string" ? it.item_name : code),
              size: existing?.size || (typeof it.size === "string" ? it.size : ""),
              unit: existing?.unit || (typeof it.unit === "string" ? it.unit : "件"),
              onHand: numberValue(it.hr_on_hand_quantity),
              increaseQuantity: existing?.increaseQuantity || 0,
            });
          }
        }
      }

      const pivotData = buildPivotTableData(rawLines, stockMap);
      const title = `${header.requestNo} 平日制服領用表`;
      const xlsxBytes = generatePivotXlsx(pivotData, {
        title,
        dateRangeLabel: header.distributionDate,
      });

      downloadPivotXlsx(xlsxBytes, `${header.requestNo}-領用表.xlsx`);
    } catch (err) {
      setErrorMsg(`匯出失敗：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="request-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="panel"
        style={{
          backgroundColor: "#fff",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "960px",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: "24px 28px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
          border: "1px solid #d6d0c5",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          position: "relative",
        }}
      >
        {/* Modal 頂部控制列 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "1px solid #e5e7eb", paddingBottom: "14px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span
                style={{
                  fontSize: "0.75rem",
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontWeight: 700,
                  backgroundColor: header?.requestType === "REPLENISHMENT" ? "#e0f2fe" : "#f3e8ff",
                  color: header?.requestType === "REPLENISHMENT" ? "#0369a1" : "#7e22ce",
                }}
              >
                {header?.requestType === "REPLENISHMENT" ? "額外補庫單" : "員工制服需求單"}
              </span>
              <p className="eyebrow" style={{ margin: 0 }}>
                {header?.requestType === "REPLENISHMENT" ? "REPLENISHMENT DETAILS" : "HR UNIFORM REQUEST"}
              </p>
            </div>
            <h2 id="request-modal-title" style={{ margin: 0, fontSize: "1.35rem", display: "flex", alignItems: "center", gap: 10 }}>
              {header?.requestNo || sourceNo}
              {header?.status ? (
                <span className={`status-pill ${header.status === "SHIPPED" ? "success" : header.status === "CANCELLED" ? "danger" : ""}`} style={{ fontSize: "0.8rem" }}>
                  {hrRequestStatusLabel(header.status)}
                </span>
              ) : null}
            </h2>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {header && header.requestType !== "REPLENISHMENT" && (issueLines.length > 0 || items.length > 0) ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleExportSingle()}
                disabled={exporting || loading}
                title="匯出此單二維交叉領用統計總表 (Excel)"
                style={{ padding: "6px 12px", minHeight: "34px", fontSize: "12px" }}
              >
                {exporting ? "匯出中…" : "匯出此單領用表 (Excel)"}
              </button>
            ) : null}
            <button
              type="button"
              className="text-button"
              onClick={onClose}
              aria-label="關閉視窗"
              style={{
                fontSize: "1.5rem",
                lineHeight: 1,
                padding: "4px 8px",
                color: "#6b7280",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* 錯誤或狀態提示 */}
        {errorMsg ? (
          <div className="error-box" role="alert" style={{ margin: 0 }}>
            {errorMsg}
          </div>
        ) : null}

        {loading ? (
          <div style={{ padding: "40px 0", textAlign: "center", color: "#6b7280" }}>
            <p>正在載入完整需求單內容…</p>
          </div>
        ) : header ? (
          <>
            {/* 指標方塊 */}
            <div className="metric-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
              <div className="metric">
                <span>{header.requestType === "REPLENISHMENT" ? "申請日期" : "發放日期"}</span>
                <strong>{header.distributionDate || "—"}</strong>
              </div>
              <div className="metric">
                <span>{header.requestType === "REPLENISHMENT" ? "增庫總量" : "有效預留量"}</span>
                <strong>
                  {header.requestType === "REPLENISHMENT"
                    ? `${items.reduce((sum, item) => sum + numberValue(item.increase_quantity), 0)} 件`
                    : `${activeReserved} 件`}
                </strong>
              </div>
              <div className="metric">
                <span>關聯發貨單</span>
                <strong>
                  {header.requestType === "REPLENISHMENT"
                    ? "無（調撥直入）"
                    : header.shipmentNo
                      ? `${header.shipmentNo} (${header.shipmentStatus === "POSTED" ? "已發貨" : "草稿"})`
                      : "尚未發貨"}
                </strong>
              </div>
              <div className="metric">
                <span>資料版本</span>
                <strong>第 {header.rowVersion} 版</strong>
              </div>
            </div>

            {/* 備註 */}
            {header.note ? (() => {
              const cleanNote = header.note.replace(/<!--unit_map:.*?-->/g, "").trim();
              return cleanNote ? (
                <div style={{ padding: "10px 14px", backgroundColor: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
                  <span style={{ fontWeight: 600, color: "#475569", fontSize: "0.85rem" }}>單據備註：</span>
                  <span style={{ color: "#1e293b", fontSize: "0.9rem", marginLeft: 6 }}>{cleanNote}</span>
                </div>
              ) : null;
            })() : null}

            {/* 品號彙總 */}
            <div>
              <h4 style={{ margin: "10px 0 8px", fontSize: "1rem" }}>
                {header.requestType === "REPLENISHMENT" ? "增庫申請明細（額外補庫）" : "品號彙總需求"}
              </h4>
              <div className="summary-list" style={{ maxHeight: "200px", overflowY: "auto" }}>
                {items.length === 0 ? (
                  <p className="muted" style={{ padding: "8px 0" }}>尚無品號資料</p>
                ) : (
                  items.map((item) => (
                    <div className="summary-row" key={item.id}>
                      <span>
                        <strong>{item.item_code_snapshot ?? item.item_id}</strong>
                        <small>{item.item_name_snapshot ?? "制服品項"}／{item.unit_snapshot ?? "件"}</small>
                      </span>
                      {header.requestType === "REPLENISHMENT" ? (
                        <strong>增庫 {numberValue(item.increase_quantity)} {item.unit_snapshot ?? "件"}</strong>
                      ) : (
                        <span>
                          發放 {numberValue(item.issue_quantity)} ＋ 增庫 {numberValue(item.increase_quantity)} ＝{" "}
                          <strong style={{ color: "#c65337" }}>
                            {numberValue(item.requested_transfer_quantity)} {item.unit_snapshot ?? "件"}
                          </strong>
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 隨單增庫明細（若有） */}
            {header.requestType !== "REPLENISHMENT" && items.some((item) => numberValue(item.increase_quantity) > 0) ? (
              <div>
                <h4 style={{ margin: "10px 0 8px", fontSize: "1rem" }}>增庫申請明細（隨單增庫）</h4>
                <div className="summary-list" style={{ maxHeight: "160px", overflowY: "auto" }}>
                  {items
                    .filter((item) => numberValue(item.increase_quantity) > 0)
                    .map((item) => (
                      <div className="summary-row" key={`inc-${item.id}`}>
                        <span>
                          <strong>{item.item_code_snapshot ?? item.item_id}</strong>
                          <small>{item.item_name_snapshot ?? "制服品項"}／{item.unit_snapshot ?? "件"}</small>
                        </span>
                        <strong>增庫 {numberValue(item.increase_quantity)} {item.unit_snapshot ?? "件"}</strong>
                      </div>
                    ))}
                </div>
              </div>
            ) : null}

            {/* 員工領用發放明細清單 */}
            {header.requestType !== "REPLENISHMENT" && (
              <div>
                <h4 style={{ margin: "10px 0 8px", fontSize: "1rem" }}>
                  領用發放明細（共 {issueLines.length} 筆）
                </h4>
                {issueLines.length === 0 ? (
                  <p className="muted" style={{ padding: "8px 0" }}>此需求單無各別發放明細</p>
                ) : (
                  <div className="table-scroll" style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e2e8f0" }}>
                    <table className="inventory-movement-table" style={{ width: "100%", fontSize: "0.85rem", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ background: "#f8fafc" }}>
                          <th style={{ padding: "8px 10px", textAlign: "left", width: "40px" }}>序</th>
                          <th style={{ padding: "8px 10px", textAlign: "left" }}>報局單位</th>
                          <th style={{ padding: "8px 10px", textAlign: "left" }}>品號／品名</th>
                          <th style={{ padding: "8px 10px", textAlign: "center", width: "60px" }}>規格</th>
                          <th style={{ padding: "8px 10px", textAlign: "right", width: "70px" }}>數量</th>
                        </tr>
                      </thead>
                      <tbody>
                        {issueLines.map((line, idx) => {
                          const selectedCode = parsedUnitMap[line.line_no] || parsedUnitMap[String(line.line_no)];
                          const unitCode = selectedCode || line.department_code_snapshot || line.institution_code_snapshot || "";
                          const unitName =
                            (selectedCode && orgMap.get(selectedCode)) ||
                            (unitCode === line.department_code_snapshot ? line.department_name_snapshot : null) ||
                            (unitCode === line.institution_code_snapshot ? line.institution_name_snapshot : null) ||
                            orgMap.get(unitCode) ||
                            line.department_name_snapshot ||
                            line.institution_name_snapshot ||
                            "";

                          const unitDisplay = unitName && unitName !== unitCode ? `${unitCode}｜${unitName}` : (unitCode || "—");

                          return (
                            <tr key={line.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                              <td style={{ padding: "8px 10px", color: "#64748b" }}>{line.line_no || idx + 1}</td>
                              <td style={{ padding: "8px 10px", fontWeight: 600 }}>{unitDisplay}</td>
                              <td style={{ padding: "8px 10px" }}>
                                <div><strong>{line.item_code_snapshot || "—"}</strong></div>
                                <div style={{ fontSize: "0.8rem", color: "#64748b" }}>{line.item_name_snapshot}</div>
                              </td>
                              <td style={{ padding: "8px 10px", textAlign: "center" }}>{line.size_snapshot || "—"}</td>
                              <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, color: "#1e293b" }}>
                                {numberValue(line.quantity)} {line.unit_snapshot || "件"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="muted" style={{ marginTop: 6, fontSize: "0.8rem" }}>
                  預留狀態：共 {reservations.length} 筆；有效預留 {reservations.filter((r) => r.status === "ACTIVE").length} 筆，已結案／釋放 {reservations.filter((r) => r.status !== "ACTIVE").length} 筆。
                </p>
              </div>
            )}
          </>
        ) : null}

        {/* Modal 底部關閉按鈕 */}
        <div style={{ display: "flex", justifyContent: "flex-end", borderTop: "1px solid #e5e7eb", paddingTop: "14px", marginTop: "4px" }}>
          <button type="button" className="secondary-button" onClick={onClose} style={{ minWidth: "90px" }}>
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}
