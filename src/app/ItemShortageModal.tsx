"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export type ItemShortageRow = {
  itemId?: string;
  itemCode: string;
  itemName: string;
  unit?: string;
  size?: string | null;
  category?: string | null;
  hrOnHand?: number;
  generalOnHand?: number;
  combinedOnHand: number;
  activeReserved: number;
  availableToRequest: number;
  safetyStock?: number | null;
  isBelowSafetyStock?: boolean;
  statusLabel?: string;
  isDataError?: boolean;
  isGeneralOutOfStock?: boolean;
};

export type ItemShortageModalProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  items: ItemShortageRow[];
  loading?: boolean;
  onNavigateToWarehouse?: () => void;
  onFilterInTable?: () => void;
};

export default function ItemShortageModal({
  isOpen,
  onClose,
  title,
  subtitle,
  items,
  loading = false,
  onNavigateToWarehouse,
  onFilterInTable,
}: ItemShortageModalProps) {
  const [search, setSearch] = useState("");

  const handleClose = useCallback(() => {
    setSearch("");
    onClose();
  }, [onClose]);

  // 監聽 Esc 鍵關閉彈窗
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  const hasHrOrGeneralOnHand = useMemo(() => {
    return items.some((item) => item.hrOnHand !== undefined || item.generalOnHand !== undefined);
  }, [items]);

  const hasSafetyStockConfigured = useMemo(() => {
    return items.some((item) => item.safetyStock !== undefined && item.safetyStock !== null);
  }, [items]);

  const zeroStockCount = useMemo(() => {
    return items.filter((item) => item.availableToRequest === 0 && !item.isGeneralOutOfStock && item.statusLabel !== "總倉無庫存").length;
  }, [items]);

  const belowSafetyStockCount = useMemo(() => {
    return items.filter((item) => item.isBelowSafetyStock || item.statusLabel === "低於安全庫存").length;
  }, [items]);

  const generalZeroCount = useMemo(() => {
    return items.filter((item) => item.isGeneralOutOfStock || item.statusLabel === "總倉無庫存" || ((item.generalOnHand ?? 0) <= 0 && item.availableToRequest > 0)).length;
  }, [items]);

  const dataErrorCount = useMemo(() => {
    return items.filter((item) => item.availableToRequest < 0 || item.isDataError).length;
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      return (
        item.itemCode.toLowerCase().includes(q) ||
        item.itemName.toLowerCase().includes(q) ||
        (item.size && item.size.toLowerCase().includes(q)) ||
        (item.category && item.category.toLowerCase().includes(q))
      );
    });
  }, [items, search]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortage-modal-title"
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
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        className="panel"
        style={{
          backgroundColor: "#fff",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "1020px",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          padding: "24px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
          border: "1px solid #d6d0c5",
          position: "relative",
          gap: "14px",
          overflow: "hidden",
        }}
      >
        {/* 頂部標題列 */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            borderBottom: "1px solid #e5e7eb",
            paddingBottom: "14px",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span
                style={{
                  fontSize: "0.75rem",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  fontWeight: 700,
                  backgroundColor: "#fee2e2",
                  color: "#b91c1c",
                }}
              >
                缺量品項檢視
              </span>
              <span
                style={{
                  fontSize: "12px",
                  color: "#64748b",
                  fontWeight: 600,
                }}
              >
                共 {items.length} 筆需注意
              </span>
            </div>
            <h2
              id="shortage-modal-title"
              style={{
                margin: 0,
                fontSize: "1.35rem",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                color: "#1e293b",
              }}
            >
              <span>⚠️</span>
              <span>{title}</span>
            </h2>
            {subtitle && (
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                {subtitle}
              </p>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            {onFilterInTable && (
              <button
                type="button"
                className="secondary-button"
                onClick={onFilterInTable}
                style={{
                  margin: 0,
                  padding: "8px 14px",
                  fontSize: "13px",
                  color: "var(--accent, #d8744a)",
                  borderColor: "var(--accent, #d8744a)",
                }}
              >
                在下方主表格篩選 ➔
              </button>
            )}
            {onNavigateToWarehouse && (
              <button
                type="button"
                className="secondary-button"
                onClick={onNavigateToWarehouse}
                style={{
                  margin: 0,
                  padding: "8px 14px",
                  fontSize: "13px",
                  color: "#0369a1",
                  borderColor: "#38bdf8",
                  background: "#f0f9ff",
                }}
              >
                前往「倉庫作業」查看 ➔
              </button>
            )}
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              style={{ margin: 0, padding: "8px 14px", fontSize: "13px" }}
              aria-label="關閉視窗"
            >
              ✕ 關閉
            </button>
          </div>
        </div>

        {/* 摘要數據卡片列與搜尋列 */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px",
            background: "#f8fafc",
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#334155" }}>
              統計分析：
            </span>
            <span
              style={{
                fontSize: "12px",
                background: "#fee2e2",
                color: "#991b1b",
                padding: "3px 8px",
                borderRadius: "6px",
                fontWeight: 600,
              }}
            >
              可申請量為 0（缺貨）：{zeroStockCount} 筆
            </span>
            {belowSafetyStockCount > 0 && (
              <span
                style={{
                  fontSize: "12px",
                  background: "#fef3c7",
                  border: "1px solid #fcd34d",
                  color: "#b45309",
                  padding: "3px 8px",
                  borderRadius: "6px",
                  fontWeight: 600,
                }}
              >
                低於安全庫存：{belowSafetyStockCount} 筆
              </span>
            )}
            {generalZeroCount > 0 && (
              <span
                style={{
                  fontSize: "12px",
                  background: "#fff7ed",
                  border: "1px solid #fdba74",
                  color: "#c2410c",
                  padding: "3px 8px",
                  borderRadius: "6px",
                  fontWeight: 600,
                }}
              >
                總倉無庫存（需補庫）：{generalZeroCount} 筆
              </span>
            )}
            {dataErrorCount > 0 && (
              <span
                style={{
                  fontSize: "12px",
                  background: "#fef2f2",
                  border: "1px solid #f87171",
                  color: "#991b1b",
                  padding: "3px 8px",
                  borderRadius: "6px",
                  fontWeight: 700,
                }}
              >
                負數或資料異常：{dataErrorCount} 筆
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜尋品號、品名、尺寸…"
              style={{
                padding: "5px 10px",
                fontSize: "12px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                width: "200px",
                background: "#fff",
              }}
              aria-label="搜尋缺量品項"
            />
            {search && (
              <button
                type="button"
                className="text-button"
                onClick={() => setSearch("")}
                style={{ fontSize: "12px", padding: "2px 6px" }}
              >
                清除
              </button>
            )}
          </div>
        </div>

        {/* 缺量品項清單表格區（獨立垂直捲動） */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            background: "#fff",
            minHeight: "220px",
          }}
        >
          {loading ? (
            <div style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
              載入資料中…
            </div>
          ) : filteredItems.length === 0 ? (
            <div style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
              {search
                ? "找不到符合搜尋條件的品項，請清除搜尋條件再試。"
                : "目前無缺量品項，所有品項庫存與可申請量皆充足！"}
            </div>
          ) : (
            <table
              className="overview-table"
              style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}
            >
              <thead>
                <tr
                  style={{
                    position: "sticky",
                    top: 0,
                    background: "#f1f5f9",
                    borderBottom: "2px solid #cbd5e1",
                    zIndex: 2,
                  }}
                >
                  <th style={{ padding: "10px 12px", textAlign: "left", width: "130px" }}>品號</th>
                  <th style={{ padding: "10px 12px", textAlign: "left" }}>品名</th>
                  <th style={{ padding: "10px 12px", textAlign: "center", width: "70px" }}>尺寸</th>
                  <th style={{ padding: "10px 12px", textAlign: "center", width: "80px" }}>分類</th>
                  {hasHrOrGeneralOnHand && (
                    <>
                      <th style={{ padding: "10px 12px", textAlign: "right", width: "80px" }}>
                        人資倉現有
                      </th>
                      <th style={{ padding: "10px 12px", textAlign: "right", width: "80px" }}>
                        總倉現有
                      </th>
                    </>
                  )}
                  <th style={{ padding: "10px 12px", textAlign: "right", width: "85px" }}>
                    兩倉合計
                  </th>
                  <th style={{ padding: "10px 12px", textAlign: "right", width: "80px" }}>
                    有效預留
                  </th>
                  <th style={{ padding: "10px 12px", textAlign: "right", width: "95px" }}>
                    可申請量
                  </th>
                  {hasSafetyStockConfigured && (
                    <th style={{ padding: "10px 12px", textAlign: "right", width: "85px" }}>
                      安全庫存
                    </th>
                  )}
                  <th style={{ padding: "10px 12px", textAlign: "center", width: "115px" }}>
                    狀態
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item, idx) => {
                  const isNegative = item.availableToRequest < 0 || item.isDataError;
                  const rowBg = idx % 2 === 0 ? "#ffffff" : "#fbfbfa";

                  return (
                    <tr
                      key={`${item.itemCode}-${item.size || ""}-${idx}`}
                      style={{
                        backgroundColor: isNegative ? "#fff5f5" : rowBg,
                        borderBottom: "1px solid #e2e8f0",
                        transition: "background-color 0.1s ease",
                      }}
                    >
                      <td style={{ padding: "10px 12px", fontWeight: 700, color: "#0f172a" }}>
                        {item.itemCode}
                      </td>
                      <td style={{ padding: "10px 12px", color: "#334155" }}>
                        {item.itemName}
                        {item.unit && (
                          <span style={{ fontSize: "11px", color: "#64748b", marginLeft: "4px" }}>
                            （{item.unit}）
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "center", color: "#475569" }}>
                        {item.size || "—"}
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "center", color: "#475569" }}>
                        {item.category || "—"}
                      </td>
                      {hasHrOrGeneralOnHand && (
                        <>
                          <td
                            style={{
                              padding: "10px 12px",
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              color: item.hrOnHand === 0 ? "#94a3b8" : "#0f172a",
                            }}
                          >
                            {item.hrOnHand ?? "—"}
                          </td>
                          <td
                            style={{
                              padding: "10px 12px",
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              fontWeight: item.generalOnHand === 0 ? 700 : 400,
                              color: item.generalOnHand === 0 ? "#ea580c" : "#0f172a",
                              backgroundColor: item.generalOnHand === 0 ? "#fff7ed" : undefined,
                            }}
                          >
                            {item.generalOnHand ?? "—"}
                            {item.generalOnHand === 0 && (
                              <span style={{ fontSize: "10px", color: "#c2410c", marginLeft: "2px" }}>(無庫存)</span>
                            )}
                          </td>
                        </>
                      )}
                      <td
                        style={{
                          padding: "10px 12px",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 600,
                          color: "#1e293b",
                        }}
                      >
                        {item.combinedOnHand}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          color: item.activeReserved > 0 ? "#b45309" : "#64748b",
                          fontWeight: item.activeReserved > 0 ? 600 : 400,
                        }}
                      >
                        {item.activeReserved}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 800,
                          color: isNegative ? "#dc2626" : item.availableToRequest === 0 ? "#e11d48" : "#d97706",
                          fontSize: "14px",
                        }}
                      >
                        {item.availableToRequest}
                      </td>
                      {hasSafetyStockConfigured && (
                        <td
                          style={{
                            padding: "10px 12px",
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            color: item.safetyStock ? "#334155" : "#94a3b8",
                            fontWeight: item.safetyStock ? 600 : 400,
                          }}
                        >
                          {item.safetyStock !== null && item.safetyStock !== undefined ? item.safetyStock : "—"}
                        </td>
                      )}
                      <td style={{ padding: "10px 12px", textAlign: "center" }}>
                        {(() => {
                          const isBelowSafety = item.isBelowSafetyStock || item.statusLabel === "低於安全庫存";
                          const isGenZero = item.isGeneralOutOfStock || item.statusLabel === "總倉無庫存";
                          const bg = isNegative ? "#fef2f2" : isBelowSafety ? "#fef3c7" : isGenZero ? "#fff7ed" : "#fee2e2";
                          const color = isNegative ? "#991b1b" : isBelowSafety ? "#b45309" : isGenZero ? "#c2410c" : "#b91c1c";
                          const border = isNegative ? "1px solid #f87171" : isBelowSafety ? "1px solid #fcd34d" : isGenZero ? "1px solid #fed7aa" : "1px solid #fca5a5";
                          const defaultLabel = isNegative ? "資料異常" : isBelowSafety ? "低於安全庫存" : isGenZero ? "總倉無庫存" : "無可申請量";
                          return (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "2px 8px",
                                borderRadius: "12px",
                                fontSize: "11px",
                                fontWeight: 700,
                                backgroundColor: bg,
                                color: color,
                                border: border,
                              }}
                            >
                              {item.statusLabel || defaultLabel}
                            </span>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 底部說明與關閉按鈕 */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: "6px",
            borderTop: "1px solid #e5e7eb",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <span style={{ fontSize: "12px", color: "#64748b" }}>
            💡 可申請量 ＝ 兩倉合計現有庫存 － 進行中有效預留量
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            style={{ margin: 0, padding: "8px 20px", fontSize: "13px" }}
          >
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}
