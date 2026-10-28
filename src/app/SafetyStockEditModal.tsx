"use client";

import { useCallback, useEffect, useState } from "react";
import type { InventoryAvailabilityRow } from "@/src/domain/inventory-availability";

export type SafetyStockEditModalProps = {
  isOpen: boolean;
  item: InventoryAvailabilityRow | null;
  currentThreshold: number | null;
  onClose: () => void;
  onSave: (threshold: number | null) => void;
};

export default function SafetyStockEditModal({
  isOpen,
  item,
  currentThreshold,
  onClose,
  onSave,
}: SafetyStockEditModalProps) {
  // 將輸入值以文字狀態維護，方便使用者輸入與清空
  const [inputValue, setInputValue] = useState<string>(() => {
    return currentThreshold !== null && currentThreshold !== undefined ? String(currentThreshold) : "";
  });
  const [errorMsg, setErrorMsg] = useState<string>("");

  // 當 item 或 currentThreshold 變更時，可由 key 機制重設，或者在外部每次開啟時更新 key
  // 為了徹底避免 Next.js 15 的 set-state-in-effect 警告，我們在內部按鈕點擊關閉時重置

  const handleClose = useCallback(() => {
    setErrorMsg("");
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  if (!isOpen || !item) return null;

  const handleSave = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      // 空白代表清除設定
      onSave(null);
      handleClose();
      return;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setErrorMsg("請輸入大於或等於 0 的整數");
      return;
    }

    if (parsed === 0) {
      onSave(null);
    } else {
      onSave(Math.trunc(parsed));
    }
    handleClose();
  };

  const handleClear = () => {
    onSave(null);
    handleClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="safety-stock-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        zIndex: 10000,
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
          backgroundColor: "#ffffff",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "520px",
          display: "flex",
          flexDirection: "column",
          padding: "24px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
          border: "1px solid #d6d0c5",
          gap: "18px",
          position: "relative",
        }}
      >
        {/* 標題列 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2
              id="safety-stock-modal-title"
              style={{
                margin: 0,
                fontSize: "18px",
                fontWeight: 700,
                color: "#0f172a",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span>⚙️</span>
              <span>設定品項安全庫存量</span>
            </h2>
            <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "#64748b" }}>
              設定後，當此品項的可申請量低於此數值時將發出提醒通知
            </p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={handleClose}
            style={{
              margin: 0,
              padding: "4px 10px",
              fontSize: "14px",
              minHeight: "auto",
              color: "#64748b",
            }}
            aria-label="關閉"
          >
            ✕
          </button>
        </div>

        {/* 品項基本資訊 */}
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "14px",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "10px",
            fontSize: "13px",
          }}
        >
          <div>
            <span style={{ color: "#64748b", fontSize: "12px" }}>品號</span>
            <div style={{ fontWeight: 700, color: "#0f172a", fontSize: "14px" }}>
              {item.itemCode || "—"}
            </div>
          </div>
          <div>
            <span style={{ color: "#64748b", fontSize: "12px" }}>品名</span>
            <div style={{ fontWeight: 600, color: "#1e293b" }}>{item.itemName || "—"}</div>
          </div>
          <div>
            <span style={{ color: "#64748b", fontSize: "12px" }}>規格／尺寸</span>
            <div style={{ color: "#334155" }}>{item.size || "無規格"}</div>
          </div>
          <div>
            <span style={{ color: "#64748b", fontSize: "12px" }}>單位</span>
            <div style={{ color: "#334155" }}>{item.unit || "件"}</div>
          </div>
          <div>
            <span style={{ color: "#64748b", fontSize: "12px" }}>人資倉現有</span>
            <div style={{ fontWeight: 600, color: "#334155" }}>
              {item.hrOnHand} {item.unit}
            </div>
          </div>
          <div>
            <span style={{ color: "#64748b", fontSize: "12px" }}>總倉現有</span>
            <div style={{ fontWeight: 600, color: item.generalOnHand === 0 ? "#ea580c" : "#334155" }}>
              {item.generalOnHand} {item.unit}
            </div>
          </div>
          <div style={{ gridColumn: "span 2", paddingTop: "4px", borderTop: "1px dashed #cbd5e1" }}>
            <span style={{ color: "#64748b", fontSize: "12px" }}>目前可申請量</span>
            <div
              style={{
                fontWeight: 800,
                fontSize: "16px",
                color: item.availableToRequest <= 0 ? "#dc2626" : "#0284c7",
              }}
            >
              {item.availableToRequest} {item.unit}
            </div>
          </div>
        </div>

        {/* 安全庫存輸入區塊 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label
            htmlFor="safety-stock-input"
            style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b" }}
          >
            安全庫存警戒值（{item.unit || "件"}）
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              id="safety-stock-input"
              type="number"
              min="0"
              step="1"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                setErrorMsg("");
              }}
              placeholder="例如：10"
              style={{
                flex: 1,
                padding: "8px 12px",
                fontSize: "15px",
                borderRadius: "8px",
                border: errorMsg ? "1px solid #dc2626" : "1px solid #cbd5e1",
                outline: "none",
              }}
              autoFocus
            />
            <span style={{ fontSize: "14px", color: "#64748b" }}>{item.unit || "件"}</span>
          </div>

          {errorMsg ? (
            <p style={{ margin: 0, fontSize: "12px", color: "#dc2626", fontWeight: 600 }}>
              {errorMsg}
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: "12px", color: "#64748b", lineHeight: 1.5 }}>
              💡 當「可申請量」小於或等於此數值時，系統會在<strong>「需注意品號卡片」</strong>與總覽的<strong>「可申請量異常指標」</strong>中發出預警提醒。
            </p>
          )}
        </div>

        {/* 底部按鈕 */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: "12px",
            borderTop: "1px solid #e2e8f0",
          }}
        >
          <div>
            {currentThreshold !== null && currentThreshold !== undefined && (
              <button
                type="button"
                className="secondary-button"
                onClick={handleClear}
                style={{
                  margin: 0,
                  padding: "6px 12px",
                  fontSize: "13px",
                  color: "#dc2626",
                  borderColor: "#fca5a5",
                  background: "#fff5f5",
                }}
              >
                清除安全庫存
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className="secondary-button"
              onClick={handleClose}
              style={{ margin: 0, padding: "6px 14px", fontSize: "13px" }}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={handleSave}
              style={{ margin: 0, padding: "6px 16px", fontSize: "13px" }}
            >
              儲存設定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
